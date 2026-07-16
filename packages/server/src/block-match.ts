import {
  BOARD_W,
  botDecide,
  createBotMind,
  createMatch,
  EVENT_CODES,
  killPlayer,
  LAG_TICKS,
  LEAD_TICKS,
  MAX_EVENTS_PER_TICK,
  parseBlockClientMsg,
  queueGarbage,
  randStep,
  stepPlayer,
  TICK_RATE,
  toWire,
  type BlockServerMsg,
  type BotMind,
  type GameEvent,
  type InputMsg,
  type MatchState,
  type PlayerState,
} from 'blockwait-core'
import { HUMANS_PER_MATCH } from './block-lobby.js'

const TICK_MS = 1000 / TICK_RATE // 50ms wall clock, per Task 7's brief
const GRACE_MS = 5_000 // disconnect grace before the board is killed in-sim (forfeit)
// Getting {matchId, token} from POST /block/join and actually opening the ws are separate
// steps -- a client can vanish in between. Without a deadline the players who DID connect would
// wait forever (start() fires only at conns.size === humanCount, no alarm runs pre-start). Same
// rationale as snake-match.ts's START_DEADLINE_MS.
const START_DEADLINE_MS = 10_000
const SNAP_INTERVAL = 5 // broadcast a snap every 5 alarms → 4Hz at a 20Hz wall clock
const MAX_BUFFERED_BATCHES = 128 // per-slot inbound batch cap; excess dropped (a spamming socket)

export function parseBlockMatchId(pathname: string): string | null {
  // A DO id from idFromString() is always exactly 64 lowercase hex chars; anything else would
  // make idFromString() throw and turn a malformed request into an unhandled 500 (same
  // discipline as snake's/bomber's parse*MatchId).
  const m = pathname.match(/^\/block\/match\/([0-9a-f]{64})\/ws$/)
  return m ? m[1]! : null
}

function parseHumanCount(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= HUMANS_PER_MATCH ? n : null
}

export interface BlockConn {
  send(data: string): void
  close(code: number, reason: string): void
}

export interface JoinResult {
  // Host-scoped routing handle for this socket -- NOT the player slot. Final slots are assigned
  // at start() (ids handed out at hello time are unstable under pre-start disconnects); the
  // client learns its slot from StartMsg.you.
  connId: number
  started: boolean
}

export type TickAction = { type: 'running' } | { type: 'ended' } | { type: 'empty' }

/**
 * Pure per-match host for the block duel — the per-player-clock analogue of SnakeMatchHost
 * (see snake-match.ts's header for the pre-start-churn / monotonic-connId / start-deadline
 * lessons, all followed here). The tick loop is the plan's per-player-clock model: a 50ms wall
 * clock, human boards driven by validated InputMsg batches, the bot board driven server-side,
 * and each board advancing on its OWN sim clock.
 */
export class BlockMatchHost {
  readonly humanCount: number
  private nextConnId = 0
  private conns = new Map<number, BlockConn>() // connId -> conn; insertion order = join order
  private names = new Map<number, string>() // connId -> handle
  private slots = new Map<number, number>() // connId -> final player slot, assigned at start()
  private minds = new Map<number, BotMind>() // player slot -> bot mind (bot slots only)
  private disconnected = new Map<number, number>() // player slot -> disconnectedAt, pending grace
  private buffers = new Map<number, InputMsg[]>() // player slot -> buffered inbound batches
  private lastSeq: [number, number] = [-1, -1] // per-slot last-accepted seq (strictly monotonic)
  private lastUpTo: [number, number] = [0, 0] // per-slot last-accepted upTo (== that board's tick)
  private state: MatchState | null = null
  private started = false
  private ended = false
  private startMs = 0 // wall clock zero: set at start(), == the instant clients receive StartMsg
  private wallTick = 0 // TIME-DERIVED: floor((now - startMs) / TICK_MS), never decreasing
  private alarms = 0 // alarm counter, for the snap cadence

  constructor(humanCount: number) {
    this.humanCount = humanCount
  }

  join(conn: BlockConn, name: string): JoinResult | null {
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

  // Start-deadline path (see START_DEADLINE_MS): the lobby promised humanCount humans but only
  // some (or none) opened the ws. Whoever HAS helloed by the deadline plays -- start() sizes the
  // human roster off conns.size, so no-shows become the bot slot. Zero connected -> 'empty': the
  // caller tombstones the room. Idempotent under a deadline racing a natural start.
  forceStart(): 'started' | 'empty' {
    if (this.started) return 'started'
    if (this.conns.size === 0) return 'empty'
    this.start()
    return 'started'
  }

  // A socket closing does not eliminate the board outright -- it starts a GRACE_MS window
  // (checked at the top of every tick()); this only removes the ATTACHED socket so broadcasts
  // and the "room empty" check reflect who's actually listening. Pre-start it simply forgets the
  // connection: the departed human never gets a slot (see start()'s compaction).
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
    if (slot === undefined) return // unknown connection: nothing to buffer
    const msg = parseBlockClientMsg(raw)
    if (!msg || msg.t !== 'input') return // garbage, oversized, or a stray 'hello': ignore
    const buf = this.buffers.get(slot) ?? []
    if (buf.length >= MAX_BUFFERED_BATCHES) return // spamming socket: drop the excess
    buf.push(msg)
    this.buffers.set(slot, buf)
  }

  /**
   * Invoked by BlockMatchDO.alarm() once the match has started; `nowMs` is the DO's Date.now().
   * wallTick is derived from elapsed wall time, NOT counted per alarm: in production, alarm
   * processing + Cloudflare alarm-reschedule latency stretch the effective period well past
   * TICK_MS (~75ms live), so a per-alarm counter would fall behind the clients' true 20Hz clock
   * and every input batch's upTo would outrun wallTick + LEAD_TICKS → silently dropped forever.
   * A late alarm now advances wallTick by 2+ at once; bots / force-advance / sudden-death all
   * catch up via their while-loops, so processing granularity is decoupled from sim time.
   */
  tick(nowMs: number): TickAction {
    if (this.ended || !this.state) return { type: 'empty' }
    // No attached human sockets left to serve: stop burning DO CPU on a match nobody is watching
    // (same 'empty' stop as snake-match.ts, generalized to the grace-delayed kill model here).
    if (this.conns.size === 0) return { type: 'empty' }

    // Never-decreasing guard against clock weirdness (NTP step-back / a stale alarm firing late).
    this.wallTick = Math.max(this.wallTick, Math.floor((nowMs - this.startMs) / TICK_MS))
    this.alarms += 1
    this.applyGraceExpiry(nowMs) // grace deadline is wall time; reuse tick()'s nowMs (no 2nd clock read)

    // 1. Human slots: apply this sweep's buffered batches (each advances that board on its own
    //    clock, routing any attack to the opponent).
    for (let slot = 0; slot < HUMANS_PER_MATCH; slot++) {
      if (!this.minds.has(slot)) this.applyBatches(slot)
    }
    // 2. Bot slot(s): advance to the wall clock with server-side botDecide events.
    for (const slot of this.minds.keys()) this.advanceBot(slot)
    // 3. Force-advance: any ALIVE human lagging past LAG_TICKS is pulled forward with empty
    //    events (gravity + sudden death still run → the end bound holds online).
    const floor = this.wallTick - LAG_TICKS
    for (let slot = 0; slot < HUMANS_PER_MATCH; slot++) {
      if (!this.minds.has(slot)) this.forceAdvance(slot, floor)
    }

    // 4. Result: newly-dead collected this sweep; both dead → draw, one → win by the other.
    if (this.state.result === null) {
      const d0 = !this.state.players[0].alive
      const d1 = !this.state.players[1].alive
      const result = d0 && d1 ? ({ kind: 'draw' } as const)
        : d1 ? ({ kind: 'win', winner: 0 } as const)
        : d0 ? ({ kind: 'win', winner: 1 } as const)
        : null
      if (result) {
        this.state = { ...this.state, result }
        this.ended = true
        // Final board (its WireState.result is now stamped) before the formal end notice --
        // EndMsg carries no board, so this is the client's last frame.
        this.broadcast({ t: 'snap', state: toWire(this.state) })
        this.broadcast({ t: 'end', result: result.kind === 'win' ? [0, result.winner] : [1] })
        return { type: 'ended' }
      }
    }

    if (this.alarms % SNAP_INTERVAL === 0) this.broadcast({ t: 'snap', state: toWire(this.state) })
    return { type: 'running' }
  }

  // Apply (or silently drop) each buffered batch for a human slot, in arrival order.
  private applyBatches(slot: number): void {
    const buf = this.buffers.get(slot)
    if (!buf || buf.length === 0) return
    for (const msg of buf) this.applyOneBatch(slot, msg)
    buf.length = 0
  }

  // Validate a single batch strictly; a violating batch is DROPPED without mutating any state.
  private applyOneBatch(slot: number, msg: InputMsg): void {
    if (!this.state) return
    const lastSeq = this.lastSeq[slot === 0 ? 0 : 1]
    const lastUpTo = this.lastUpTo[slot === 0 ? 0 : 1]
    if (msg.seq <= lastSeq) return // seq not strictly monotonic
    if (msg.upTo <= lastUpTo) return // upTo not strictly monotonic
    if (msg.upTo > this.wallTick + LEAD_TICKS) return // client running too far ahead

    // Bucket events by their stamped tick; every event tick must fall in (lastUpTo, upTo] and no
    // tick may carry more than MAX_EVENTS_PER_TICK events. Any breach drops the whole batch.
    const byTick = new Map<number, GameEvent[]>()
    for (const [t, code] of msg.events) {
      if (t <= lastUpTo || t > msg.upTo) return
      const arr = byTick.get(t) ?? []
      arr.push(EVENT_CODES[code]!)
      if (arr.length > MAX_EVENTS_PER_TICK) return
      byTick.set(t, arr)
    }

    // Advance this board tick-by-tick from its current tick to upTo, stamping events at their
    // ticks and empty elsewhere; route any attack as each step produces it.
    let p = this.state.players[slot === 0 ? 0 : 1]
    for (let tt = p.tick + 1; tt <= msg.upTo; tt++) {
      const out = stepPlayer(p, byTick.get(tt) ?? [])
      p = out.player
      this.setPlayer(slot, p)
      this.routeAttack(slot, out.attack)
      if (!p.alive) break // topped out mid-batch: stop advancing this board
    }
    this.setPlayer(slot, p)
    this.lastSeq[slot === 0 ? 0 : 1] = msg.seq
    this.lastUpTo[slot === 0 ? 0 : 1] = msg.upTo
  }

  private advanceBot(slot: number): void {
    if (!this.state) return
    let p = this.state.players[slot === 0 ? 0 : 1]
    let mind = this.minds.get(slot)!
    while (p.alive && p.tick < this.wallTick) {
      const decided = botDecide(p, mind, 'normal')
      mind = decided.mind
      const out = stepPlayer(p, decided.events)
      p = out.player
      this.setPlayer(slot, p)
      this.routeAttack(slot, out.attack)
    }
    this.setPlayer(slot, p)
    this.minds.set(slot, mind)
  }

  private forceAdvance(slot: number, floor: number): void {
    if (!this.state) return
    let p = this.state.players[slot === 0 ? 0 : 1]
    while (p.alive && p.tick < floor) {
      const out = stepPlayer(p, [])
      p = out.player
      this.setPlayer(slot, p)
      this.routeAttack(slot, out.attack)
    }
    // Keep lastUpTo pinned to this board's clock so future batches validate against where the
    // board actually is, not the stale point the client last acked.
    if (p.tick > this.lastUpTo[slot === 0 ? 0 : 1]) this.lastUpTo[slot === 0 ? 0 : 1] = p.tick
  }

  // Route an attack from attackerSlot to the opponent: roll the hole column from the host's
  // garbageRng (same randStep formula as core step()), queueGarbage onto the victim at the
  // victim's CURRENT own tick, and tell that victim's socket.
  private routeAttack(attackerSlot: number, attack: number): void {
    if (attack <= 0 || !this.state) return
    const victimSlot = attackerSlot === 0 ? 1 : 0
    const roll = randStep(this.state.garbageRng)
    this.state.garbageRng = roll.next
    const holeCol = Math.floor(roll.value * BOARD_W)
    const victim = this.state.players[victimSlot]
    const atTick = victim.tick
    this.setPlayer(victimSlot, queueGarbage(victim, attack, holeCol))
    const conn = this.connForSlot(victimSlot)
    if (conn) this.send(conn, { t: 'garbage', rows: attack, holeCol, atTick })
  }

  private applyGraceExpiry(now: number): void {
    if (this.disconnected.size === 0 || !this.state) return
    for (const [slot, disconnectedAt] of this.disconnected) {
      if (now - disconnectedAt < GRACE_MS) continue
      // Forfeit: kill the board in-sim (drops the active piece, marks dead) exactly as if it had
      // topped out; the result sweep below turns this into a win for the opponent.
      this.setPlayer(slot, killPlayer(this.state.players[slot === 0 ? 0 : 1]))
      this.disconnected.delete(slot)
    }
  }

  private setPlayer(slot: number, p: PlayerState): void {
    if (!this.state) return
    const players = this.state.players
    this.state = { ...this.state, players: slot === 0 ? [p, players[1]] : [players[0], p] }
  }

  private connForSlot(slot: number): BlockConn | undefined {
    for (const [connId, conn] of this.conns) if (this.slots.get(connId) === slot) return conn
    return undefined
  }

  private start(): void {
    this.started = true
    // Wall clock zero. This start() broadcasts StartMsg below, and each client starts its own tick 0
    // on receipt, so the server's time-derived wallTick shares that origin. The first tick alarm is
    // scheduled ~TICK_MS after this, so nowMs - startMs ≈ TICK_MS → wallTick 1 on the first tick.
    this.startMs = Date.now()
    const seed = Math.floor(Math.random() * 2 ** 31)
    // Final slot assignment: compact the SURVIVING connections (pre-start leavers are already
    // gone from `conns`) into slots 0..k-1 in join order; a bot backfills the remaining slot.
    const names: string[] = []
    const bots: boolean[] = []
    for (const connId of this.conns.keys()) {
      const slot = names.length
      if (slot >= HUMANS_PER_MATCH) break
      this.slots.set(connId, slot)
      this.lastSeq[slot === 0 ? 0 : 1] = -1
      this.lastUpTo[slot === 0 ? 0 : 1] = 0
      names.push(this.names.get(connId) ?? `p${slot}`)
      bots.push(false)
    }
    for (let i = names.length; i < HUMANS_PER_MATCH; i++) {
      names.push(`synth-${i}`)
      bots.push(true)
      this.minds.set(i, createBotMind(Math.floor(Math.random() * 2 ** 31)))
    }
    this.state = createMatch(seed, names, bots)
    for (const [connId, conn] of this.conns) {
      this.send(conn, { t: 'start', you: this.slots.get(connId)!, seed, names, bots })
    }
  }

  private broadcast(msg: BlockServerMsg): void {
    for (const conn of this.conns.values()) this.send(conn, msg)
  }

  private send(conn: BlockConn, msg: BlockServerMsg): void {
    try {
      conn.send(JSON.stringify(msg))
    } catch {
      /* dead socket: cleaned up on the DO's close event */
    }
  }
}

export class BlockMatchDO implements DurableObject {
  private host: BlockMatchHost | null = null
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
      // A stale/forged token disagreeing with the room this DO already committed to: the matchId
      // itself is the real secret (an unguessable 64-hex DO id), same trust model as the
      // tokenless ws routes -- this is a defensive consistency check, not auth.
      server.close(1002, 'room mismatch')
      return new Response(null, { status: 101, webSocket: client })
    }

    server.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      const id = this.ids.get(server)
      if (id !== undefined) {
        // this.host can already be null here: the tick loop nulls it and closes every socket on
        // 'ended'/'empty', but a straggling message from another socket can still race in.
        if (this.host) this.host.handleMessage(id, raw)
        return
      }
      // First message on this socket must be a well-formed hello -- routed through
      // parseBlockClientMsg (same as every other message) for the raw-size cap and safe JSON
      // parsing, so a public unauthenticated endpoint can never throw here.
      const msg = parseBlockClientMsg(raw)
      if (msg?.t !== 'hello') {
        server.close(1002, 'expected hello')
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
      this.ids.set(server, joined.connId)
      this.sockets.set(joined.connId, server)
      if (joined.started) void this.state.storage.setAlarm(Date.now() + TICK_MS)
    })
    server.addEventListener('close', () => {
      const id = this.ids.get(server)
      // Same race as the message handler: applyAction already closed every socket and nulled
      // this.host, so another socket's own real close event can still fire after that.
      if (id !== undefined && this.host) this.host.leave(id)
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  // Single alarm handler, dispatched on phase (same one-handler discipline as snake-match.ts): a
  // DO has exactly ONE alarm slot, so the pre-start deadline and the running tick loop never
  // coexist -- the first tick alarm simply overwrites the pending deadline.
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
      void this.state.storage.setAlarm(Date.now() + TICK_MS)
      return
    }
    this.tombstone(action.type === 'ended' ? 'game over' : 'room empty')
  }

  private ensureHost(humanCount: number): BlockMatchHost {
    if (!this.host) {
      this.host = new BlockMatchHost(humanCount)
      // Arm the start deadline the moment the room exists -- once per host, never re-armed per
      // socket (that would let each straggler extend the wait for everyone already in).
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
