// Tankwait online transport: a one-shot lobby POST (TankLobbyDO gathers the duel's two humans for a
// short window, a bot always backfills an empty slot — never a noOpponent-style outcome) followed by
// a persistent match WebSocket. Transcribed from packages/block-client/src/net.ts (factory seam for
// tests, handlers wired for the connection's whole life, resolving on `start`), with two
// tank-specific differences: the ws handshake's first upstream frame is a `join` (block sends
// `hello`), and the ongoing server traffic is `shot` broadcasts (every fire, own included), `turn`
// notices, and a final `end` — the turn-based relay online.ts replays locally, NOT block's
// per-player-clock snap stream. This module just relays raw messages up; all replay/desync logic
// lives in online.ts.
import { parseTankServerMsg, resultFromWire, type Result, type ShotBcast, type ShotMsg, type StartMsg, type TankServerMsg, type TurnMsg } from 'tankwait-core'
import { WebSocket, type RawData } from 'ws'

export interface TankNetHandlers {
  onShot(msg: ShotBcast): void
  onTurn(msg: TurnMsg): void
  onEnd(result: Result): void
  onClose(reason: string): void
}

export type JoinOutcome = { kind: 'joined'; matchId: string; token: string } | { kind: 'error' }

// Factory seam for the underlying socket: production passes the real `ws` constructor, tests inject a
// fake so the join/handshake flow is exercisable without a live server.
export type WebSocketFactory = (url: string) => WebSocket

const realFactory: WebSocketFactory = (url) => new WebSocket(url)

// POST {serverUrl}/tank/join {name}. The lobby gathers briefly then always answers {matchId, token}
// (token is the room's humanCount, echoed back as the ws query param) — a bot backfills the empty
// slot server-side, so there is no noOpponent case to distinguish here. ANY failure (network error,
// non-2xx, timeout, malformed body) collapses to the same 'error' outcome; the caller's fallback
// (play offline) is identical regardless of why.
export async function joinTankMatch(serverUrl: string, name: string, timeoutMs = 12_000): Promise<JoinOutcome> {
  const base = serverUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/tank/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { kind: 'error' }
    const body = (await res.json()) as { matchId?: unknown; token?: unknown }
    if (typeof body.matchId === 'string' && typeof body.token === 'string') {
      return { kind: 'joined', matchId: body.matchId, token: body.token }
    }
    return { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}

export class TankNetClient {
  private constructor(private ws: WebSocket) {}

  // Opens ws(s)://.../tank/match/{matchId}/ws?token={token}, sends the join frame (the server's ws
  // requires a well-formed `join` as its first message), resolves once `start` arrives with the
  // client plus the StartMsg payload (seeds online.ts's deterministic local mirror). `handlers` stay
  // wired for the life of the connection — shot/turn/end/close events keep flowing through them after
  // connect() resolves.
  static async connect(
    serverUrl: string,
    matchId: string,
    token: string,
    name: string,
    handlers: TankNetHandlers,
    timeoutMs = 12_000,
    factory: WebSocketFactory = realFactory,
  ): Promise<{ client: TankNetClient; start: StartMsg }> {
    const base = serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')
    const ws = factory(`${base}/tank/match/${matchId}/ws?token=${encodeURIComponent(token)}`)
    const client = new TankNetClient(ws)
    // Gates onClose so a pre-start close/error rejects connect() instead of reaching the caller's
    // handlers — only an established session's close should ever fire onClose (online.ts reads that
    // as a mid-match forfeit rather than a join failure).
    let started = false
    const start = await new Promise<StartMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('start timeout')), timeoutMs)
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name })))
      ws.on('message', (data: RawData) => {
        const msg: TankServerMsg | null = parseTankServerMsg(data.toString())
        if (!msg) return // garbage/oversized/malformed: ignored, never crashes or corrupts state
        if (msg.t === 'start') {
          started = true
          clearTimeout(timer)
          resolve(msg)
        } else if (msg.t === 'shot') {
          handlers.onShot(msg)
        } else if (msg.t === 'turn') {
          handlers.onTurn(msg)
        } else {
          handlers.onEnd(resultFromWire(msg.result))
        }
      })
      ws.on('close', (_code: number, reason: Buffer) => {
        const why = reason.toString()
        if (!started) {
          clearTimeout(timer)
          reject(new Error(`connect closed: ${why || 'no reason'}`))
          return
        }
        handlers.onClose(why)
      })
      ws.on('error', (err: Error) => {
        if (!started) {
          clearTimeout(timer)
          reject(err)
        }
      })
    })
    return { client, start }
  }

  sendShot(msg: ShotMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}
