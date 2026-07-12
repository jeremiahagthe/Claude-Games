import {
  botDecide,
  createBotMind,
  createMatch,
  MAX_PLAYERS,
  parseBomberClientMsg,
  step,
  TICK_RATE,
  toWire,
  type BomberServerMsg,
  type BomberState,
  type BotMind,
  type Dir,
  type Input,
  type WirePlayer,
  type WireState,
} from 'boomwait-core'

const TICK_MS = 1000 / TICK_RATE
const GRACE_MS = 5_000 // disconnect grace before elimination
// Getting {matchId, token} from POST /bomber/join and actually opening the ws are separate
// steps -- a client can vanish in between (a Ctrl-C is enough). Without a deadline the
// players who DID connect would wait forever: start() fires only at conns.size ===
// humanCount, and no alarm runs pre-start. So the DO arms this deadline the moment the room
// (host) is created; if it fires pre-start, whoever has helloed by then plays (the no-shows
// are backfilled as bots), and a room where NOBODY helloed is tombstoned instead.
const START_DEADLINE_MS = 10_000

export function parseBomberMatchId(pathname: string): string | null {
  // A DO id from idFromString() is always exactly 64 lowercase hex chars; anything else
  // would make idFromString() throw and turn a malformed request into an unhandled 500
  // (same discipline as checkwait's parseChessMatchId).
  const m = pathname.match(/^\/bomber\/match\/([0-9a-f]{64})\/ws$/)
  return m ? m[1]! : null
}

function parseHumanCount(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= MAX_PLAYERS ? n : null
}

// step.ts's movementPhase decrements a standing-still player's stepCooldown unconditionally
// (`cooldown = p.stepCooldown - 1`) and only ever resets it to a positive value on an actual
// move -- for a player who never holds a direction (the default at spawn, and after any stop)
// this drifts arbitrarily negative, violating protocol.ts's own WireState invariant
// (isStat requires >= 0) on literally the first idle tick. bomber-core is frozen (golden
// master), so this floors the value on the OUTBOUND wire copy only -- 0 is exactly as
// meaningful as any more-negative number here ("eligible to move now"), and the authoritative
// `this.state` used for the next step() call is never touched.
function clampWire(w: WireState): WireState {
  let changed = false
  const players = w.players.map((p): WirePlayer => {
    if (p[10] >= 0) return p
    changed = true
    return [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], 0, p[11]]
  })
  return changed ? { ...w, players } : w
}

export interface BomberConn {
  send(data: string): void
  close(code: number, reason: string): void
}

interface Latch {
  dir: Dir | null
  bomb: boolean
}

export interface JoinResult {
  // Host-scoped routing handle for this socket -- NOT the player slot. Final slots are
  // assigned at start() (see BomberMatchHost.start), because ids handed out at hello time
  // are unstable under pre-start disconnects; the client learns its slot from StartMsg.you.
  connId: number
  started: boolean
}

export type TickAction = { type: 'running' } | { type: 'ended' } | { type: 'empty' }

/**
 * Pure per-match game logic (the boomwait analogue of fragwait's MatchHost /
 * checkwait's ChessMatchHost). humanCount is decided once, up front, by the
 * lobby's gather-window outcome (see bomber-lobby.ts) -- this host never
 * waits on its own; as soon as humanCount human `hello`s have arrived it
 * backfills the remaining MAX_PLAYERS slots with bots and starts immediately.
 * Date.now() is used here (the server edge), never in boomwait-core itself.
 */
export class BomberMatchHost {
  readonly humanCount: number
  // Pre-start bookkeeping is keyed by a MONOTONIC connId, never by "join order so far":
  // a hello-then-disconnect before start would leave a gap that a naive conns.size id both
  // collides into (next joiner reuses a live player's id) and miscounts at force-start
  // (a connected human lands on a bot slot, their inputs ignored all match). Final player
  // slots 0..k-1 are assigned once, in start(), by compacting the SURVIVING connections in
  // join order -- clients only learn their slot from StartMsg.you, so this is free.
  private nextConnId = 0
  private conns = new Map<number, BomberConn>() // connId -> conn; insertion order = join order
  private names = new Map<number, string>() // connId -> handle
  private slots = new Map<number, number>() // connId -> final player slot, assigned at start()
  private latches = new Map<number, Latch>() // player slot -> input latch
  private minds = new Map<number, BotMind>() // player slot -> bot mind
  private disconnected = new Map<number, number>() // player slot -> disconnectedAt, pending grace
  private state: BomberState | null = null
  private started = false
  private ended = false

  constructor(humanCount: number) {
    this.humanCount = humanCount
  }

  join(conn: BomberConn, name: string): JoinResult | null {
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

  // A socket closing does not eliminate the player outright -- it starts a GRACE_MS window
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
    const msg = parseBomberClientMsg(raw)
    if (!msg || msg.t !== 'input') return // garbage, oversized, or a stray 'hello': ignore
    const cur = this.latches.get(slot) ?? { dir: null, bomb: false }
    const dir = msg.dir === 'keep' ? cur.dir : msg.dir
    // bomb is a one-shot latch, not a held state like dir: a still-pending bomb from an
    // earlier InputMsg this same server tick must survive a later message that doesn't
    // itself re-request one, or unsynchronized 50ms client/server clocks (two client ticks
    // coalescing into one server tick) silently drop a queued "bomb then run". tick() clears
    // it back to false the instant it's consumed, so `cur.bomb` is never stale across ticks.
    this.latches.set(slot, { dir, bomb: cur.bomb || msg.bomb })
  }

  /** Invoked by BomberMatchDO.alarm() at 20Hz once the match has started. */
  tick(): TickAction {
    if (this.ended || !this.state) return { type: 'empty' }
    // No attached human sockets left to serve: stop burning DO CPU on a match nobody is
    // watching (same rationale as fragwait's match-do.ts 'empty' stop, generalized to the
    // grace-delayed elimination model here -- a pending grace timer with zero live sockets
    // has no observer left to eliminate for, so there is nothing to finish).
    if (this.conns.size === 0) return { type: 'empty' }

    this.applyGraceEliminations(Date.now())

    const inputs: (Input | null)[] = []
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const mind = this.minds.get(id)
      if (mind) {
        inputs.push(botDecide(this.state, id, mind, 'easy'))
        continue
      }
      const latch = this.latches.get(id) ?? { dir: null, bomb: false }
      inputs.push({ dir: latch.dir, bomb: latch.bomb })
      // Bomb placement is a one-shot action per received InputMsg, not a held latch like dir:
      // consume it into exactly this tick's step() call, then clear it so it takes a fresh
      // bomb:true from the client to place the next one.
      if (latch.bomb) this.latches.set(id, { ...latch, bomb: false })
    }

    this.state = step(this.state, inputs)

    if (this.state.result) {
      this.ended = true
      // Send the final board (its WireState.result is now stamped) before the formal end
      // notice -- EndMsg itself carries no board state, so this is the client's last frame.
      this.broadcast({ t: 'snap', state: clampWire(toWire(this.state)) })
      this.broadcast({ t: 'end', result: this.state.result })
      return { type: 'ended' }
    }
    this.broadcast({ t: 'snap', state: clampWire(toWire(this.state)) })
    return { type: 'running' }
  }

  private applyGraceEliminations(now: number): void {
    if (this.disconnected.size === 0 || !this.state) return
    let players = this.state.players
    let changed = false
    for (const [id, disconnectedAt] of this.disconnected) {
      if (now - disconnectedAt < GRACE_MS) continue
      players = players.map((p) => (p.id === id ? { ...p, alive: false } : p))
      changed = true
      this.disconnected.delete(id)
    }
    if (changed) this.state = { ...this.state, players }
  }

  private start(): void {
    this.started = true
    const seed = Math.floor(Math.random() * 2 ** 31)
    // Final slot assignment: compact the SURVIVING connections (pre-start leavers are
    // already gone from `conns`) into slots 0..k-1 in join order, each with their own name.
    // Human slots = who actually connected, not the lobby's promise: identical at a natural
    // start (conns.size === humanCount), smaller after a forceStart() with no-shows.
    const names: string[] = []
    const bots: boolean[] = []
    for (const connId of this.conns.keys()) {
      const slot = names.length
      this.slots.set(connId, slot)
      this.latches.set(slot, { dir: null, bomb: false })
      names.push(this.names.get(connId) ?? `p${slot}`)
      bots.push(false)
    }
    for (let i = names.length; i < MAX_PLAYERS; i++) {
      // Online backfill bots are placeholders for humans, not the opposition (mirrors
      // fragwait's match-host.ts BOT_SKILLS reasoning): 'easy' cadence in tick().
      names.push(`synth-${i}`)
      bots.push(true)
      this.minds.set(i, createBotMind(Math.floor(Math.random() * 2 ** 31)))
    }
    this.state = createMatch(seed, names, bots)
    const startTick = this.state.tick
    for (const [connId, conn] of this.conns) {
      this.send(conn, { t: 'start', you: this.slots.get(connId)!, seed, names, bots, startTick })
    }
  }

  private broadcast(msg: BomberServerMsg): void {
    for (const conn of this.conns.values()) this.send(conn, msg)
  }

  private send(conn: BomberConn, msg: BomberServerMsg): void {
    try {
      conn.send(JSON.stringify(msg))
    } catch {
      /* dead socket: cleaned up on the DO's close event */
    }
  }
}

export class BomberMatchDO implements DurableObject {
  private host: BomberMatchHost | null = null
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
      // matchId itself is the real secret (an unguessable 64-hex DO id, same trust model as
      // checkwait's tokenless ws route); this is a defensive consistency check, not auth.
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
      // parseBomberClientMsg (same as every other message) for the raw-size cap and safe JSON
      // parsing, so a public unauthenticated endpoint can never throw here.
      const msg = parseBomberClientMsg(raw)
      if (msg?.t !== 'hello') {
        server.close(1002, 'expected hello')
        return
      }
      // re(create) the host lazily here too: the alarm loop may have tombstoned it between
      // this socket's fetch() and its first message (same caveat as fragwait's match-do.ts).
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

  // Single alarm handler, dispatched on phase (chess-match precedent for one-handler
  // discipline): a DO has exactly ONE alarm slot, so the pre-start deadline and the running
  // tick loop can never coexist -- the first tick alarm (set at natural start or by the
  // deadline branch below) simply overwrites the pending deadline.
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
    const action = this.host.tick()
    if (action.type === 'running') {
      // setAlarm is deliberately fire-and-forget (`void`): this runs inside the alarm handler
      // itself, and the DO runtime's input/output gating keeps the storage write ordered
      // ahead of any later event for this object even without awaiting it.
      void this.state.storage.setAlarm(Date.now() + TICK_MS)
      return
    }
    this.tombstone(action.type === 'ended' ? 'game over' : 'room empty')
  }

  private ensureHost(humanCount: number): BomberMatchHost {
    if (!this.host) {
      this.host = new BomberMatchHost(humanCount)
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
