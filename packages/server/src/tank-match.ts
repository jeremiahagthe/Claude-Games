import {
  botDecide,
  botObserve,
  createBotMind,
  createMatch,
  killPlayer,
  parseTankClientMsg,
  randStep,
  resolveShot,
  resultToWire,
  SHOT_CLOCK_MS,
  stateHash,
  type BotMind,
  type MatchState,
  type Shot,
  type TankServerMsg,
} from 'tankwait-core'
import { HUMANS_PER_MATCH } from './tank-lobby.js'

// Wall-clock playback pacing (server-local, NOT core — these are edge concerns): the client renders
// the shell flight at 3 sim steps per 50ms frame, so a trajectory of N steps takes ~N * (50/3) ms to
// watch, plus a fixed tail for the explosion + settle beat. The next turn's countdown must not start
// until the animation has plausibly finished, so this allowance is ADDED on top of the shot clock.
export const ANIM_MS_PER_STEP = 1000 / 60 // 50ms frame / 3 steps ≈ 16.67ms per sim step
export const ANIM_TAIL_MS = 1500 // explosion + settle beat
export function animAllowanceMs(steps: number): number {
  return Math.ceil(steps * ANIM_MS_PER_STEP) + ANIM_TAIL_MS
}
// Seeded humanizing delay before a bot fires: BOT_DELAY_BASE_MS + value * BOT_DELAY_SPREAD_MS, drawn
// from a match-seeded rng so a bot "thinks" for 2–4s rather than firing instantly.
export const BOT_DELAY_BASE_MS = 2000
export const BOT_DELAY_SPREAD_MS = 2000
// Getting {matchId, token} from POST /tank/join and actually opening the ws are separate steps -- a
// client can vanish in between. Without a deadline the human who DID connect to a humanCount=2 room
// would wait forever (start() fires only at conns.size === humanCount). Same rationale as
// block-match.ts's START_DEADLINE_MS: when it fires pre-start, the no-show slot converts to a bot.
export const START_DEADLINE_MS = 15_000

export function parseTankMatchId(pathname: string): string | null {
  // A DO id from idFromString() is always exactly 64 lowercase hex chars; anything else would make
  // idFromString() throw and turn a malformed request into an unhandled 500 (same discipline as the
  // other games' parse*MatchId).
  const m = pathname.match(/^\/tank\/match\/([0-9a-f]{64})\/ws$/)
  return m ? m[1]! : null
}

function parseHumanCount(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= HUMANS_PER_MATCH ? n : null
}

export interface TankConn {
  send(data: string): void
  close(code: number, reason: string): void
}

export type HostAction = { type: 'none' } | { type: 'fired'; alarmAt: number } | { type: 'ended' }

export interface JoinResult {
  slot: 0 | 1
  alarmAt: number | null // set once this join triggers start() (both human slots present)
}

/**
 * Pure per-match host for the tank duel — the turn-clock analogue of ChessMatchHost (see
 * chess-match.ts for the host/DO split and the close-race null-safety it relies on). Slots are
 * assigned at join like chess's colors (0 = left, 1 = right); start() fires once conns.size reaches
 * humanCount, backfilling the remaining slot with one 'normal' bot. resolveShot replaces applyMove.
 *
 * Deliberate divergence from chess: a late / out-of-turn / stale-seq shot is IGNORED silently (never
 * a socket close). Expiry races are expected here — the alarm can auto-fire a turn just as the human's
 * real shot arrives, which then fails the turn check; that is benign, not misbehaviour.
 */
export class TankMatchHost {
  readonly humanCount: number
  private conns = new Map<0 | 1, TankConn>() // slot -> conn
  private names = new Map<0 | 1, string>() // slot -> handle
  private state: MatchState | null = null
  private started = false
  private ended = false
  private botMinds = new Map<0 | 1, BotMind>() // bot slot -> mind (bot slots only)
  private lastSeq: [number, number] = [-1, -1] // per-slot last-accepted client seq (strictly monotonic)
  private botDelayRng = 0 // match-seeded; threaded through each drawBotDelay()

  constructor(humanCount: number) {
    this.humanCount = humanCount
  }

  join(conn: TankConn, name: string): JoinResult | null {
    if (this.started || this.conns.size >= this.humanCount) return null
    const slot: 0 | 1 = this.conns.has(0) ? 1 : 0
    this.conns.set(slot, conn)
    this.names.set(slot, name)
    let alarmAt: number | null = null
    if (this.conns.size === this.humanCount) alarmAt = this.start()
    return { slot, alarmAt }
  }

  hasStarted(): boolean {
    return this.started
  }

  // Start-deadline path (see START_DEADLINE_MS): the lobby promised humanCount humans but only some
  // (or none) opened the ws by the deadline. Whoever HAS joined plays -- start() derives bots from
  // the missing conns, so a no-show human slot becomes a 'normal' bot exactly like a lobby backfill.
  // Zero connected -> 'empty': the caller tombstones the room (block-match.ts's forceStart shape).
  // Idempotent under a deadline racing a natural start: already started -> 'none' (the turn alarm
  // chain is live; nothing to schedule, nothing to tombstone).
  forceStart(): { type: 'started'; alarmAt: number } | { type: 'empty' } | { type: 'none' } {
    if (this.started) return { type: 'none' }
    if (this.conns.size === 0) return { type: 'empty' }
    return { type: 'started', alarmAt: this.start() }
  }

  /** First message from an already-joined socket. Parses defensively (raw-size cap + safe JSON), then
   * applies the shot; anything malformed / off-turn / stale is ignored silently. */
  handleMessage(slot: 0 | 1, raw: string): HostAction {
    if (this.ended || !this.started || !this.state) return { type: 'none' }
    const msg = parseTankClientMsg(raw)
    if (!msg || msg.t !== 'shot') return { type: 'none' } // stray join or garbage: ignore
    if (this.state.result) return { type: 'none' }
    if (slot !== this.state.turn) return { type: 'none' } // out of turn (incl. the expiry race): ignore
    if (msg.seq <= this.lastSeq[slot]) return { type: 'none' } // stale / non-increasing seq: ignore
    this.lastSeq[slot] = msg.seq
    return this.fire(slot, { angle: msg.angle, power: msg.power }, msg.seq)
  }

  /** Invoked by TankMatchDO.alarm(). Bot turn → decide + fire; human turn → auto-fire its last shot
   * params (createMatch pre-loads the seeded defaults, so a first-turn expiry fires DEFAULT_*). */
  onAlarm(): HostAction {
    if (this.ended || !this.started || !this.state) return { type: 'none' }
    if (this.state.result) return { type: 'none' }
    const who = this.state.turn
    if (this.state.tanks[who].bot) {
      const mind = this.botMinds.get(who)!
      const decided = botDecide(this.state, who, mind, 'normal')
      this.botMinds.set(who, decided.mind) // rng-advanced mind; fire()'s botObserve records the outcome
      return this.fire(who, decided.shot, 0)
    }
    const tank = this.state.tanks[who]
    return this.fire(who, { angle: tank.lastAngle, power: tank.lastPower }, 0)
  }

  leave(slot: 0 | 1): HostAction {
    const wasConnected = this.conns.delete(slot)
    if (this.ended || !wasConnected) return { type: 'none' }
    if (!this.started || !this.state) return { type: 'none' } // opponent never joined: nothing to end
    this.state = killPlayer(this.state, slot) // forfeit: slot dead, win stamped for the other (once)
    this.ended = true
    this.broadcast({ t: 'end', result: resultToWire(this.state.result!) })
    return { type: 'ended' }
  }

  // Shared by handleMessage (human seq), onAlarm bot turns, and onAlarm human expiry (seq 0). Resolves
  // the shot, broadcasts it, then either ends the match or schedules the next turn. deadlineMs and the
  // returned alarmAt use ONE computed duration (the turn countdown === the alarm delay).
  private fire(slot: 0 | 1, shot: Shot, seq: number): HostAction {
    if (!this.state) return { type: 'none' }
    const now = Date.now()
    const out = resolveShot(this.state, shot)
    this.state = out.state
    if (this.state.tanks[slot].bot) {
      const mind = this.botMinds.get(slot)
      if (mind) this.botMinds.set(slot, botObserve(mind, shot, out.impact ? out.impact.x : null))
    }
    // Server-originated fires (bot + expiry) broadcast seq 0; human shots relay their own seq.
    this.broadcast({ t: 'shot', by: slot, seq, angle: shot.angle, power: shot.power, stateHash: stateHash(this.state) })
    if (this.state.result) {
      this.ended = true
      this.broadcast({ t: 'end', result: resultToWire(this.state.result) })
      return { type: 'ended' }
    }
    const who = this.state.turn
    const nextIsBot = this.state.tanks[who].bot
    const deadlineMs = animAllowanceMs(out.trajectory.length) + (nextIsBot ? this.drawBotDelay() : SHOT_CLOCK_MS)
    this.broadcast({ t: 'turn', who, deadlineMs })
    return { type: 'fired', alarmAt: now + deadlineMs }
  }

  private start(): number {
    this.started = true
    const seed = (Math.floor(Math.random() * 2 ** 31)) >>> 0
    this.botDelayRng = seed
    const names: [string, string] = [this.names.get(0) ?? 'cpu-l', this.names.get(1) ?? 'cpu-r']
    const bots: [boolean, boolean] = [!this.conns.has(0), !this.conns.has(1)]
    this.state = createMatch(seed, names, bots)
    for (const slot of [0, 1] as const) {
      if (bots[slot]) this.botMinds.set(slot, createBotMind((seed ^ (0x9e3779b9 * (slot + 1))) >>> 0))
    }
    for (const [slot, conn] of this.conns) {
      this.send(conn, { t: 'start', you: slot, seed, names, bots, firstTurn: this.state.firstTurn })
    }
    // First turn: no shot precedes it, so no anim allowance — just the shot clock, or a bot delay.
    const who = this.state.turn
    const now = Date.now()
    const deadlineMs = this.state.tanks[who].bot ? this.drawBotDelay() : SHOT_CLOCK_MS
    this.broadcast({ t: 'turn', who, deadlineMs })
    return now + deadlineMs
  }

  private drawBotDelay(): number {
    const { value, next } = randStep(this.botDelayRng)
    this.botDelayRng = next
    return Math.round(BOT_DELAY_BASE_MS + value * BOT_DELAY_SPREAD_MS)
  }

  private broadcast(msg: TankServerMsg): void {
    for (const conn of this.conns.values()) this.send(conn, msg)
  }

  private send(conn: TankConn, msg: TankServerMsg): void {
    try {
      conn.send(JSON.stringify(msg))
    } catch {
      /* dead socket: cleaned up on the DO's close event */
    }
  }
}

export class TankMatchDO implements DurableObject {
  private host: TankMatchHost | null = null
  private ids = new WeakMap<WebSocket, 0 | 1>()
  private sockets = new Map<0 | 1, WebSocket>()

  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const humanCount = parseHumanCount(new URL(req.url).searchParams.get('token'))

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()

    if (humanCount === null) {
      server.close(1002, 'bad token')
      return new Response(null, { status: 101, webSocket: client })
    }
    if (this.ensureHost(humanCount).humanCount !== humanCount) {
      // A stale/forged token disagreeing with the room this DO already committed to: the matchId is
      // the real secret (an unguessable 64-hex DO id), so this is a defensive consistency check, not
      // auth (same trust model as block-match.ts).
      server.close(1002, 'room mismatch')
      return new Response(null, { status: 101, webSocket: client })
    }

    server.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      const slot = this.ids.get(server)
      if (slot !== undefined) {
        // this.host can already be null here: applyAction('ended') nulls it and closes both sockets
        // itself, but a straggling message from the other side can still race in before its own
        // 'close' fires. Nothing to relay to once the match is gone.
        if (this.host) this.applyAction(this.host.handleMessage(slot, raw))
        return
      }
      // First message on this socket must be a well-formed join -- routed through parseTankClientMsg
      // (same as every other message) for the raw-size cap and safe JSON parsing, so a public
      // unauthenticated endpoint can never throw here.
      const msg = parseTankClientMsg(raw)
      if (msg?.t !== 'join') {
        server.close(1002, 'expected join')
        return
      }
      const joined = this.ensureHost(humanCount).join(
        { send: (d) => server.send(d), close: (code, reason) => server.close(code, reason) },
        msg.name,
      )
      if (joined === null) {
        server.close(1013, 'full')
        return
      }
      this.ids.set(server, joined.slot)
      this.sockets.set(joined.slot, server)
      if (joined.alarmAt !== null) void this.state.storage.setAlarm(joined.alarmAt)
    })
    server.addEventListener('close', () => {
      const slot = this.ids.get(server)
      // Same race as the message handler: applyAction('ended') already closed both sockets and nulled
      // this.host, so the other socket's own real close event can still fire after that.
      if (slot !== undefined && this.host) this.applyAction(this.host.leave(slot))
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  // Single alarm handler, dispatched on phase (same one-handler discipline as block-match.ts): a DO
  // has exactly ONE alarm slot, so the pre-start deadline and the running turn chain never coexist --
  // the start-triggered turn alarm simply overwrites the pending deadline. hasStarted() is the phase
  // check that keeps a stale deadline from misfiring into an already-started match.
  async alarm(): Promise<void> {
    if (!this.host) return
    if (!this.host.hasStarted()) {
      // The start deadline fired before every promised human joined: the no-show slot converts to a
      // bot (behaving exactly like a lobby-backfilled bot from then on) and the match starts normally.
      const r = this.host.forceStart()
      if (r.type === 'started') void this.state.storage.setAlarm(r.alarmAt)
      else if (r.type === 'empty') this.applyAction({ type: 'ended' }) // nobody ever joined: dead room
      return
    }
    this.applyAction(this.host.onAlarm())
  }

  private ensureHost(humanCount: number): TankMatchHost {
    if (!this.host) {
      this.host = new TankMatchHost(humanCount)
      // Arm the start deadline the moment the room exists -- once per host, never re-armed per
      // socket (that would let each straggler extend the wait for everyone already in). A natural
      // start overwrites it with the first turn alarm (one alarm slot per DO).
      void this.state.storage.setAlarm(Date.now() + START_DEADLINE_MS)
    }
    return this.host
  }

  private applyAction(action: HostAction): void {
    // setAlarm/deleteAlarm are fire-and-forget (`void`): this runs inside synchronous WebSocket event
    // handlers, and the DO runtime's I/O gating keeps the storage write ordered ahead of any later
    // event even without awaiting. A 'none' action is a silently-ignored shot -- no socket close (the
    // deliberate divergence from chess's illegal-close; expiry races are expected).
    if (action.type === 'fired') {
      void this.state.storage.setAlarm(action.alarmAt)
    } else if (action.type === 'ended') {
      void this.state.storage.deleteAlarm()
      for (const sock of this.sockets.values()) {
        try {
          sock.close(1000, 'game over')
        } catch {
          /* already closed */
        }
      }
      this.host = null
      this.sockets.clear()
    }
  }
}
