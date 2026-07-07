import {
  applyMove,
  initialState,
  parseChessClientMsg,
  parseMove,
  tickClock,
  toFEN,
  type ChessServerMsg,
  type ChessState,
  type Color,
  type Result,
} from 'checkwait-core'

export function parseChessMatchId(pathname: string): string | null {
  const m = pathname.match(/^\/chess\/match\/([0-9a-f]+)\/ws$/)
  return m ? m[1]! : null
}

export interface ChessConn {
  send(data: string): void
  close(code: number, reason: string): void
}

export type HostAction =
  | { type: 'none' }
  | { type: 'illegal' }
  | { type: 'moved'; alarmAt: number }
  | { type: 'ended' }

export interface JoinResult {
  color: Color
  alarmAt: number | null // set once both players have joined and white's clock starts
}

function other(c: Color): Color {
  return c === 'w' ? 'b' : 'w'
}

/**
 * Pure per-match game logic (the chess analogue of fragwait's MatchHost):
 * owns the ChessState, the two connections, and the clock bookkeeping. The
 * enclosing ChessMatchDO is a thin adapter that turns WebSocket events into
 * calls here and turns the returned HostAction into socket closes / DO alarm
 * scheduling -- Date.now() is used here (the server edge), never in
 * checkwait-core itself.
 */
export class ChessMatchHost {
  private state: ChessState = initialState()
  private conns = new Map<Color, ChessConn>()
  private handles = new Map<Color, string>()
  private lastMoveAt: number | null = null
  private ended = false

  join(conn: ChessConn, handle: string): JoinResult | null {
    if (this.conns.size >= 2) return null
    const color: Color = this.conns.size === 0 ? 'w' : 'b'
    this.conns.set(color, conn)
    this.handles.set(color, handle)

    let alarmAt: number | null = null
    if (this.conns.size === 2) {
      this.lastMoveAt = Date.now()
      alarmAt = this.lastMoveAt + this.state.clocksMs.w
      const fen = toFEN(this.state)
      const clocksMs = this.state.clocksMs
      this.send(this.conns.get('w')!, { t: 'welcome', color: 'w', opponent: this.handles.get('b')!, state: fen, clocksMs })
      this.send(this.conns.get('b')!, { t: 'welcome', color: 'b', opponent: this.handles.get('w')!, state: fen, clocksMs })
    }
    return { color, alarmAt }
  }

  handleMessage(color: Color, raw: string): HostAction {
    if (this.ended) return { type: 'none' }
    const msg = parseChessClientMsg(raw)
    if (!msg) return { type: 'none' }

    if (msg.t === 'resign') {
      this.endGame({ kind: 'resign', winner: other(color) })
      return { type: 'ended' }
    }
    if (msg.t !== 'move') return { type: 'none' } // a stray 'join' after joining: ignore
    if (this.state.turn !== color) return { type: 'illegal' }

    const move = parseMove(this.state, msg.move)
    if (!move) return { type: 'illegal' }

    const now = Date.now()
    const elapsed = now - (this.lastMoveAt ?? now)
    const ticked = tickClock(this.state, elapsed)
    if (ticked.result) {
      // The mover's own clock had already run out by wall-clock time before this move arrived.
      this.state = ticked
      this.endGame(ticked.result)
      return { type: 'ended' }
    }

    const applied = applyMove(ticked, move)
    this.state = applied
    this.lastMoveAt = now
    this.broadcast({ t: 'move', move: msg.move, clocksMs: applied.clocksMs, seq: msg.seq })
    if (applied.result) {
      this.endGame(applied.result)
      return { type: 'ended' }
    }
    return { type: 'moved', alarmAt: now + applied.clocksMs[applied.turn] }
  }

  leave(color: Color): HostAction {
    const wasConnected = this.conns.delete(color)
    if (this.ended || !wasConnected) return { type: 'none' }
    if (this.handles.size < 2) return { type: 'none' } // opponent never joined; nothing to end
    this.endGame({ kind: 'resign', winner: other(color) })
    return { type: 'ended' }
  }

  /** Invoked by ChessMatchDO.alarm(). Pure aside from Date.now() (the server edge). */
  onAlarm(): HostAction {
    if (this.ended || this.lastMoveAt === null) return { type: 'none' }
    const now = Date.now()
    const elapsed = now - this.lastMoveAt
    const ticked = tickClock(this.state, elapsed)
    this.state = ticked
    if (!ticked.result) return { type: 'none' } // spurious/early alarm: nothing to do
    this.endGame(ticked.result)
    return { type: 'ended' }
  }

  private endGame(result: Result): void {
    this.ended = true
    this.state = { ...this.state, result }
    this.broadcast({ t: 'end', result, state: toFEN(this.state) })
  }

  private broadcast(msg: ChessServerMsg): void {
    for (const conn of this.conns.values()) this.send(conn, msg)
  }

  private send(conn: ChessConn, msg: ChessServerMsg): void {
    try {
      conn.send(JSON.stringify(msg))
    } catch {
      /* dead socket: cleaned up on the DO's close event */
    }
  }
}

export class ChessMatchDO implements DurableObject {
  private host: ChessMatchHost | null = null
  private ids = new WeakMap<WebSocket, Color>()
  private sockets = new Map<Color, WebSocket>()

  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    this.host ??= new ChessMatchHost()

    server.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      const color = this.ids.get(server)
      if (color) {
        this.applyAction(this.host!.handleMessage(color, raw), server)
        return
      }
      // First message on this socket must be a well-formed join -- routed through
      // parseChessClientMsg (same as every other message) for the raw-size cap and
      // safe JSON parsing, so a public unauthenticated endpoint can never throw here.
      const msg = parseChessClientMsg(raw)
      if (msg?.t !== 'join') {
        server.close(1002, 'expected join')
        return
      }
      const joined = (this.host ??= new ChessMatchHost()).join(
        { send: (d) => server.send(d), close: (code, reason) => server.close(code, reason) },
        msg.handle,
      )
      if (joined === null) {
        server.close(1013, 'full')
        return
      }
      this.ids.set(server, joined.color)
      this.sockets.set(joined.color, server)
      if (joined.alarmAt !== null) void this.state.storage.setAlarm(joined.alarmAt)
    })
    server.addEventListener('close', () => {
      const color = this.ids.get(server)
      if (color) this.applyAction(this.host!.leave(color), server)
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  async alarm(): Promise<void> {
    if (!this.host) return
    this.applyAction(this.host.onAlarm(), null)
  }

  private applyAction(action: HostAction, mover: WebSocket | null): void {
    if (action.type === 'illegal') {
      mover?.close(1002, 'illegal move')
    } else if (action.type === 'moved') {
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
