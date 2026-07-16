import {
  botDecide,
  createBotMind,
  createMatch,
  killSnake,
  MAX_PLAYERS,
  parseSnakeClientMsg,
  step,
  TICK_RATE,
  toWire,
  type BotMind,
  type Dir,
  type Input,
  type MatchState,
  type SnakeServerMsg,
} from 'snakewait-core'

const TICK_MS = 1000 / TICK_RATE // 50ms, per Task 7's brief
const GRACE_MS = 5_000 // disconnect grace before the snake is killed in-sim
// Bounds the sim steps a single alarm may run, so one very late alarm can't burn unbounded CPU
// catching up. Any deficit self-heals across later alarms: 4 steps/alarm outpaces the designed
// 20Hz at any realistic alarm rate (even ~13Hz live leaves ~2 ticks of catch-up per alarm).
const MAX_CATCHUP_STEPS = 4
// Getting {matchId, token} from POST /snake/join and actually opening the ws are separate
// steps -- a client can vanish in between (a Ctrl-C is enough). Without a deadline the
// players who DID connect would wait forever: start() fires only at conns.size ===
// humanCount, and no alarm runs pre-start. See bomber-match.ts's identical rationale.
const START_DEADLINE_MS = 10_000

export function parseSnakeMatchId(pathname: string): string | null {
  // A DO id from idFromString() is always exactly 64 lowercase hex chars; anything else
  // would make idFromString() throw and turn a malformed request into an unhandled 500
  // (same discipline as bomber's/chess's parse*MatchId).
  const m = pathname.match(/^\/snake\/match\/([0-9a-f]{64})\/ws$/)
  return m ? m[1]! : null
}

function parseHumanCount(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= MAX_PLAYERS ? n : null
}

export interface SnakeConn {
  send(data: string): void
  close(code: number, reason: string): void
}

interface Latch {
  dir: Dir | null
}

export interface JoinResult {
  // Host-scoped routing handle for this socket -- NOT the player slot. Final slots are
  // assigned at start() (see SnakeMatchHost.start), because ids handed out at hello time
  // are unstable under pre-start disconnects; the client learns its slot from StartMsg.you.
  connId: number
  started: boolean
}

export type TickAction = { type: 'running' } | { type: 'ended' } | { type: 'empty' }

/**
 * Pure per-match game logic — the snakewait analogue of boomwait's BomberMatchHost (see that
 * file's header comment for the full reasoning, followed near-verbatim here). humanCount is
 * decided once, up front, by the lobby's gather-window outcome (see snake-lobby.ts) -- this
 * host never waits on its own; as soon as humanCount human `hello`s have arrived it backfills
 * the remaining MAX_PLAYERS slots with bots and starts immediately.
 */
export class SnakeMatchHost {
  readonly humanCount: number
  // Pre-start bookkeeping is keyed by a MONOTONIC connId, never by "join order so far" (see
  // bomber-match.ts's comment for the id-churn lesson this avoids). Final player slots
  // 0..k-1 are assigned once, in start(), by compacting the SURVIVING connections in join
  // order -- clients only learn their slot from StartMsg.you.
  private nextConnId = 0
  private conns = new Map<number, SnakeConn>() // connId -> conn; insertion order = join order
  private names = new Map<number, string>() // connId -> handle
  private slots = new Map<number, number>() // connId -> final player slot, assigned at start()
  private latches = new Map<number, Latch>() // player slot -> one-shot input latch
  private minds = new Map<number, BotMind>() // player slot -> bot mind
  private disconnected = new Map<number, number>() // player slot -> disconnectedAt, pending grace
  private state: MatchState | null = null
  private started = false
  private ended = false
  private startMs = 0 // wall clock zero: set at start(), == the instant clients receive StartMsg

  constructor(humanCount: number) {
    this.humanCount = humanCount
  }

  join(conn: SnakeConn, name: string): JoinResult | null {
    if (this.started || this.conns.size >= this.humanCount) return null
    const connId = this.nextConnId++
    this.conns.set(connId, conn)
    this.names.set(connId, name)
    if (this.conns.size === this.humanCount) this.start()
    return { connId, started: this.started }
  }

  hasStarted(): boolean {
    return this.started
  }

  // Start-deadline path (see START_DEADLINE_MS): the lobby promised humanCount humans but
  // only some (or none) actually opened the ws. Whoever HAS helloed by the deadline plays --
  // start() sizes the human roster off conns.size, so the no-shows become bot slots exactly
  // as if the lobby had promised fewer humans. Zero connected -> 'empty': there is nobody to
  // start a match for, the caller tombstones the room. Idempotent: a deadline racing a
  // just-completed natural start is a harmless 'started'.
  forceStart(): 'started' | 'empty' {
    if (this.started) return 'started'
    if (this.conns.size === 0) return 'empty'
    this.start()
    return 'started'
  }

  // A socket closing does not eliminate the snake outright -- it starts a GRACE_MS window
  // (checked at the top of every tick()); this only removes the ATTACHED socket so broadcasts
  // and the "room empty" check reflect who's actually listening. Pre-start it simply forgets
  // the connection: the departed human never gets a slot (see start()'s compaction).
  leave(connId: number): void {
    if (!this.conns.delete(connId)) return
    this.names.delete(connId)
    if (!this.started || this.ended) return
    const slot = this.slots.get(connId)
    if (slot !== undefined) this.disconnected.set(slot, Date.now())
  }

  handleMessage(connId: number, raw: string): void {
    if (this.ended || !this.started) return // reject inputs before match start; nothing to crash
    const slot = this.slots.get(connId)
    if (slot === undefined) return // unknown connection: nothing to latch
    const msg = parseSnakeClientMsg(raw)
    if (!msg || msg.t !== 'input') return // garbage, oversized, or a stray 'hello': ignore
    // One-shot latch: InputMsg is sent only on change (no null/keep on the wire), and the
    // sim's own pendingDir persists once fed into a step() call -- so this only needs to
    // survive until the NEXT tick() consumes it, then it's cleared (see tick()).
    this.latches.set(slot, { dir: msg.dir })
  }

  /**
   * Invoked by SnakeMatchDO.alarm() once the match has started; `nowMs` is the DO's Date.now().
   * Sim progress is TIME-DERIVED, not one step per alarm: Cloudflare alarm processing + reschedule
   * latency stretch the effective period past TICK_MS (~75ms live), so counting one step per alarm
   * sagged the whole match to ~13Hz — a uniform ~35% slowdown. We instead run as many 20Hz steps as
   * the elapsed wall time calls for (bounded per alarm), so a late alarm catches up 2+ ticks at once.
   */
  tick(nowMs: number): TickAction {
    if (this.ended || !this.state) return { type: 'empty' }
    // No attached human sockets left to serve: stop burning DO CPU on a match nobody is
    // watching (same rationale as bomber-match.ts's 'empty' stop, generalized to the
    // grace-delayed kill model here).
    if (this.conns.size === 0) return { type: 'empty' }

    // Grace runs ONCE per alarm against the passed wall clock (nowMs), not per catch-up step: the
    // disconnect deadline is real wall time, independent of how many sim steps this alarm runs.
    this.applyGraceExpiry(nowMs)

    // Time-derived target tick; steps this alarm is the (bounded, never-negative) deficit vs the
    // sim's own tick counter. state.tick is incremented by snakewait-core's step(), so it is the
    // authoritative counter here -- no separate wall-tick field is needed.
    const target = Math.floor((nowMs - this.startMs) / TICK_MS)
    const steps = Math.min(Math.max(target - this.state.tick, 0), MAX_CATCHUP_STEPS)
    if (steps === 0) return { type: 'running' } // early alarm: no elapsed sim time yet, nothing to send

    for (let s = 0; s < steps; s++) {
      const inputs: (Input | null)[] = []
      for (let id = 0; id < MAX_PLAYERS; id++) {
        const mind = this.minds.get(id)
        if (mind) {
          // Online backfill bots are placeholders for humans, not the opposition (mirrors
          // bomber-match.ts's BOT_SKILLS reasoning): 'normal' cadence in tick().
          inputs.push(botDecide(this.state, id, mind, 'normal'))
          continue
        }
        const latch = this.latches.get(id)
        inputs.push(latch && latch.dir !== null ? { dir: latch.dir } : { dir: null })
        // Consume the one-shot latch into exactly the FIRST catch-up step that reads it, then clear
        // it -- the sim's own pendingDir carries the turn forward, so feeding it again next step
        // would be redundant (and, on 180-reverse edge cases, could re-request an already rejected
        // turn against a since-changed heading).
        if (latch && latch.dir !== null) this.latches.set(id, { dir: null })
      }

      this.state = step(this.state, inputs)

      if (this.state.result) {
        this.ended = true
        // Send the final board (its WireState.result is now stamped) before the formal end
        // notice -- EndMsg itself carries no board state, so this is the client's last frame.
        this.broadcast({ t: 'snap', state: toWire(this.state) })
        const result = this.state.result
        this.broadcast({ t: 'end', result: result.kind === 'win' ? [0, result.winner] : [1] })
        return { type: 'ended' }
      }
    }
    // One snap after the whole catch-up loop (not one per step): render-only clients just want the
    // latest board, and coalescing keeps the outbound rate at the alarm rate, not the sim rate.
    this.broadcast({ t: 'snap', state: toWire(this.state) })
    return { type: 'running' }
  }

  private applyGraceExpiry(now: number): void {
    if (this.disconnected.size === 0 || !this.state) return
    for (const [id, disconnectedAt] of this.disconnected) {
      if (now - disconnectedAt < GRACE_MS) continue
      // killSnake applies the corpse-food rule directly (see snake-core's step.ts): the
      // snake dies in-sim and decays to food via the normal step rules, exactly as if it
      // had died from a wall/body collision.
      this.state = killSnake(this.state, id)
      this.disconnected.delete(id)
    }
  }

  private start(): void {
    this.started = true
    const seed = Math.floor(Math.random() * 2 ** 31)
    // Final slot assignment: compact the SURVIVING connections (pre-start leavers are
    // already gone from `conns`) into slots 0..k-1 in join order, each with their own name.
    const names: string[] = []
    const bots: boolean[] = []
    for (const connId of this.conns.keys()) {
      const slot = names.length
      this.slots.set(connId, slot)
      this.latches.set(slot, { dir: null })
      names.push(this.names.get(connId) ?? `p${slot}`)
      bots.push(false)
    }
    for (let i = names.length; i < MAX_PLAYERS; i++) {
      names.push(`synth-${i}`)
      bots.push(true)
      this.minds.set(i, createBotMind(Math.floor(Math.random() * 2 ** 31)))
    }
    this.state = createMatch(seed, names, bots)
    // Wall clock zero, recorded immediately before StartMsg: each client starts its own tick 0 on
    // receipt, so the server's time-derived tick shares that origin. The first tick alarm is
    // scheduled ~TICK_MS later, so nowMs - startMs ≈ TICK_MS → one step on the first tick.
    this.startMs = Date.now()
    for (const [connId, conn] of this.conns) {
      this.send(conn, { t: 'start', you: this.slots.get(connId)!, seed, names, bots })
    }
  }

  private broadcast(msg: SnakeServerMsg): void {
    for (const conn of this.conns.values()) this.send(conn, msg)
  }

  private send(conn: SnakeConn, msg: SnakeServerMsg): void {
    try {
      conn.send(JSON.stringify(msg))
    } catch {
      /* dead socket: cleaned up on the DO's close event */
    }
  }
}

export class SnakeMatchDO implements DurableObject {
  private host: SnakeMatchHost | null = null
  private ids = new WeakMap<WebSocket, number>()
  private sockets = new Map<number, WebSocket>()

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
      // A stale/forged token disagreeing with the room this DO already committed to: the
      // matchId itself is the real secret (an unguessable 64-hex DO id), same trust model
      // as bomber/chess's tokenless ws route -- this is a defensive consistency check, not
      // auth.
      server.close(1002, 'room mismatch')
      return new Response(null, { status: 101, webSocket: client })
    }

    server.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      const id = this.ids.get(server)
      if (id !== undefined) {
        // this.host can already be null here: the tick loop nulls it and closes every socket
        // itself on 'ended'/'empty', but a straggling message from another socket can still
        // race in before its own 'close' event fires. Nothing to relay to once it's gone.
        if (this.host) this.host.handleMessage(id, raw)
        return
      }
      // First message on this socket must be a well-formed hello -- routed through
      // parseSnakeClientMsg (same as every other message) for the raw-size cap and safe JSON
      // parsing, so a public unauthenticated endpoint can never throw here.
      const msg = parseSnakeClientMsg(raw)
      if (msg?.t !== 'hello') {
        server.close(1002, 'expected hello')
        return
      }
      // re(create) the host lazily here too: the alarm loop may have tombstoned it between
      // this socket's fetch() and its first message (same caveat as bomber-match.ts).
      const joined = this.ensureHost(humanCount).join(
        { send: (d) => server.send(d), close: (code, reason) => server.close(code, reason) },
        msg.name,
      )
      if (joined === null) {
        server.close(1013, 'full')
        return
      }
      this.ids.set(server, joined.connId)
      this.sockets.set(joined.connId, server)
      if (joined.started) void this.state.storage.setAlarm(Date.now() + TICK_MS)
    })
    server.addEventListener('close', () => {
      const id = this.ids.get(server)
      // Same race as the message handler above: applyAction already closed every socket and
      // nulled this.host, so another socket's own real close event can still fire after that.
      if (id !== undefined && this.host) this.host.leave(id)
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  // Single alarm handler, dispatched on phase (same one-handler discipline as bomber-match.ts):
  // a DO has exactly ONE alarm slot, so the pre-start deadline and the running tick loop can
  // never coexist -- the first tick alarm (set at natural start or by the deadline branch
  // below) simply overwrites the pending deadline.
  async alarm(): Promise<void> {
    if (!this.host) return
    if (!this.host.hasStarted()) {
      // The start deadline fired before every promised human helloed.
      if (this.host.forceStart() === 'empty') {
        this.tombstone('never started') // nobody ever helloed: dead room, no match to run
        return
      }
      void this.state.storage.setAlarm(Date.now() + TICK_MS) // enter the tick phase
      return
    }
    const action = this.host.tick(Date.now())
    if (action.type === 'running') {
      // setAlarm is deliberately fire-and-forget (`void`): this runs inside the alarm handler
      // itself, and the DO runtime's input/output gating keeps the storage write ordered
      // ahead of any later event for this object even without awaiting it.
      void this.state.storage.setAlarm(Date.now() + TICK_MS)
      return
    }
    this.tombstone(action.type === 'ended' ? 'game over' : 'room empty')
  }

  private ensureHost(humanCount: number): SnakeMatchHost {
    if (!this.host) {
      this.host = new SnakeMatchHost(humanCount)
      // Arm the start deadline the moment the room exists -- once per host, never re-armed
      // per socket (that would let each straggler extend the wait for everyone already in).
      void this.state.storage.setAlarm(Date.now() + START_DEADLINE_MS)
    }
    return this.host
  }

  private tombstone(reason: string): void {
    void this.state.storage.deleteAlarm()
    for (const sock of this.sockets.values()) {
      try {
        sock.close(1000, reason)
      } catch {
        /* already closed */
      }
    }
    this.host = null
    this.sockets.clear()
  }
}
