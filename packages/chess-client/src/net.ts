// Chess's online transport: a one-shot lobby POST (pairs two humans or times
// out to noOpponent) followed by a persistent match WebSocket. Mirrors
// packages/client/src/net/client.ts's shape (factory seam for tests, handlers
// wired for the connection's whole life), but the lobby step is its own HTTP
// call rather than folded into the ws handshake — checkwait's lobby (Task 7)
// answers `{matchId}` or `{noOpponent:true}` from a plain POST, no ws involved
// until a match actually exists.
import { parseChessServerMsg, type ChessServerMsg, type Color, type Result } from 'checkwait-core'
import { WebSocket, type RawData } from 'ws'

export interface ChessNetHandlers {
  onMove(move: string, clocksMs: { w: number; b: number }, seq: number): void
  onEnd(result: Result, state: string): void
  onClose(reason: string): void
}

export type JoinOutcome = { kind: 'matched'; matchId: string } | { kind: 'noOpponent' } | { kind: 'error' }

// Factory seam for the underlying socket: production passes the real `ws`
// constructor, tests inject a fake so the join/handshake flow is exercisable
// without a live server.
export type WebSocketFactory = (url: string) => WebSocket

const realFactory: WebSocketFactory = (url) => new WebSocket(url)

// POST {serverUrl}/chess/join. The lobby either pairs us instantly or makes
// us wait ~10s before answering noOpponent (Task 7) — 12s covers that with
// margin. ANY failure (network error, non-2xx, timeout, malformed body)
// collapses to the same 'error' outcome as an honest 'noOpponent': the
// caller's fallback (play the bot) is identical either way.
export async function joinChessLobby(serverUrl: string, timeoutMs = 12_000): Promise<JoinOutcome> {
  const base = serverUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/chess/join`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { kind: 'error' }
    const body = (await res.json()) as { matchId?: unknown; noOpponent?: unknown }
    if (body.noOpponent === true) return { kind: 'noOpponent' }
    if (typeof body.matchId === 'string') return { kind: 'matched', matchId: body.matchId }
    return { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}

export interface WelcomeInfo {
  color: Color
  opponent: string
  state: string // FEN
  clocksMs: { w: number; b: number }
}

export class ChessNetClient {
  private constructor(private ws: WebSocket) {}

  // Opens ws(s)://.../chess/match/{matchId}/ws, sends join, resolves once
  // welcome arrives with the client plus the welcome payload. `handlers` stay
  // wired for the life of the connection — move/end/close events keep
  // flowing through them after connect() resolves.
  static async connect(
    serverUrl: string,
    matchId: string,
    handle: string,
    handlers: ChessNetHandlers,
    timeoutMs = 12_000,
    factory: WebSocketFactory = realFactory,
  ): Promise<{ client: ChessNetClient; welcome: WelcomeInfo }> {
    const base = serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')
    const ws = factory(`${base}/chess/match/${matchId}/ws`)
    const client = new ChessNetClient(ws)
    // Gates onClose so a pre-welcome close/error rejects connect() instead of
    // reaching the caller's handlers — only an established session's close
    // should ever fire onClose.
    let welcomed = false
    const welcome = await new Promise<WelcomeInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('welcome timeout')), timeoutMs)
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', handle })))
      ws.on('message', (data: RawData) => {
        const msg: ChessServerMsg | null = parseChessServerMsg(data.toString())
        if (!msg) return
        if (msg.t === 'welcome') {
          welcomed = true
          clearTimeout(timer)
          resolve({ color: msg.color, opponent: msg.opponent, state: msg.state, clocksMs: msg.clocksMs })
        } else if (msg.t === 'move') {
          handlers.onMove(msg.move, msg.clocksMs, msg.seq)
        } else {
          handlers.onEnd(msg.result, msg.state)
        }
      })
      ws.on('close', (_code: number, reason: Buffer) => {
        const why = reason.toString()
        if (!welcomed) {
          clearTimeout(timer)
          reject(new Error(`connect closed: ${why || 'no reason'}`))
          return
        }
        handlers.onClose(why)
      })
      ws.on('error', (err: Error) => {
        if (!welcomed) {
          clearTimeout(timer)
          reject(err)
        }
      })
    })
    return { client, welcome }
  }

  sendMove(move: string, seq: number): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'move', move, seq }))
  }

  resign(): void {
    try {
      this.ws.send(JSON.stringify({ t: 'resign' }))
    } catch {
      /* already closed */
    }
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}
