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
  playerId: number
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
  private conns = new Map<number, BomberConn>()
  private humanNames: string[] = []
  private latches = new Map<number, Latch>()
  private minds = new Map<number, BotMind>()
  private disconnected = new Map<number, number>() // playerId -> disconnectedAt, pending grace
  private state: BomberState | null = null
  private started = false
  private ended = false

  constructor(humanCount: number) {
    this.humanCount = humanCount
  }

  join(conn: BomberConn, name: string): JoinResult | null {
    if (this.started || this.conns.size >= this.humanCount) return null
    const playerId = this.conns.size
    this.conns.set(playerId, conn)
    this.humanNames.push(name)
    this.latches.set(playerId, { dir: null, bomb: false })
    if (this.conns.size === this.humanCount) this.start()
    return { playerId, started: this.started }
  }

  // A socket closing does not eliminate the player outright -- it starts a GRACE_MS window
  // (checked at the top of every tick()); this only removes the ATTACHED socket so broadcasts
  // and the "room empty" check reflect who's actually listening.
  leave(playerId: number): void {
    if (!this.conns.has(playerId)) return
    this.conns.delete(playerId)
    if (!this.started || this.ended) return
    this.disconnected.set(playerId, Date.now())
  }

  handleMessage(playerId: number, raw: string): void {
    if (this.ended || !this.started) return // reject inputs before match start; nothing to crash
    const msg = parseBomberClientMsg(raw)
    if (!msg || msg.t !== 'input') return // garbage, oversized, or a stray 'hello': ignore
    const cur = this.latches.get(playerId) ?? { dir: null, bomb: false }
    const dir = msg.dir === 'keep' ? cur.dir : msg.dir
    this.latches.set(playerId, { dir, bomb: msg.bomb })
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
    const names: string[] = []
    const bots: boolean[] = []
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (i < this.humanCount) {
        names.push(this.humanNames[i] ?? `p${i}`)
        bots.push(false)
      } else {
        // Online backfill bots are placeholders for humans, not the opposition (mirrors
        // fragwait's match-host.ts BOT_SKILLS reasoning): 'easy' cadence in tick().
        names.push(`synth-${i}`)
        bots.push(true)
        this.minds.set(i, createBotMind(Math.floor(Math.random() * 2 ** 31)))
      }
    }
    this.state = createMatch(seed, names, bots)
    const startTick = this.state.tick
    for (const [playerId, conn] of this.conns) {
      this.send(conn, { t: 'start', you: playerId, seed, names, bots, startTick })
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
    this.host ??= new BomberMatchHost(humanCount)
    if (this.host.humanCount !== humanCount) {
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
      const joined = (this.host ??= new BomberMatchHost(humanCount)).join(
        { send: (d) => server.send(d), close: (code, reason) => server.close(code, reason) },
        msg.name,
      )
      if (joined === null) {
        server.close(1013, 'full')
        return
      }
      this.ids.set(server, joined.playerId)
      this.sockets.set(joined.playerId, server)
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

  async alarm(): Promise<void> {
    if (!this.host) return
    const action = this.host.tick()
    if (action.type === 'running') {
      // setAlarm is deliberately fire-and-forget (`void`): this runs inside the alarm handler
      // itself, and the DO runtime's input/output gating keeps the storage write ordered
      // ahead of any later event for this object even without awaiting it.
      void this.state.storage.setAlarm(Date.now() + TICK_MS)
      return
    }
    void this.state.storage.deleteAlarm()
    for (const sock of this.sockets.values()) {
      try {
        sock.close(1000, action.type === 'ended' ? 'game over' : 'room empty')
      } catch {
        /* already closed */
      }
    }
    this.host = null
    this.sockets.clear()
  }
}
