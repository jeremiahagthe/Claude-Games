// Snake's online transport: a one-shot lobby POST (Task 7's SnakeLobbyDO gathers players for a
// short window, bots always backfill any empty slots — never a noOpponent-style outcome)
// followed by a persistent match WebSocket. Transcribed from packages/bomber-client/src/net.ts
// (factory seam for tests, handlers wired for the connection's whole life), resolving on `start`
// instead of `welcome`/`hello`, with the ongoing traffic afterward a `snap` stream (client is
// render-only — it never locally steps the sim, every snap REPLACES the rendered state) rather
// than a per-move relay.
import { parseSnakeServerMsg, type Dir, type Input, type InputMsg, type Result, type SnakeServerMsg, type StartMsg, type WireState } from 'snakewait-core'
import { WebSocket, type RawData } from 'ws'

export interface SnakeNetHandlers {
  onSnap(state: WireState): void
  onEnd(result: Result): void
  onClose(reason: string): void
}

export type JoinOutcome = { kind: 'joined'; matchId: string; token: string } | { kind: 'error' }

// Factory seam for the underlying socket: production passes the real `ws` constructor, tests
// inject a fake so the join/handshake flow is exercisable without a live server.
export type WebSocketFactory = (url: string) => WebSocket

const realFactory: WebSocketFactory = (url) => new WebSocket(url)

// EndMsg.result is the compact wire form ([0,winner] | [1]=draw), not a Result — this converts
// it the same way protocol.ts's fromWire converts WireState.result, so callers only ever see the
// same Result shape offline.ts already works with.
function endResultToResult(r: [0, number] | [1]): Result {
  return r.length === 1 ? { kind: 'draw' } : { kind: 'win', winner: r[1] }
}

// POST {serverUrl}/snake/join {name}. The lobby gathers briefly (Task 7) then always answers
// {matchId, token} — bots backfill empty slots server-side, so there is no noOpponent case to
// distinguish here. ANY failure (network error, non-2xx, timeout, malformed body) collapses to
// the same 'error' outcome; the caller's fallback (play offline) is identical regardless of why.
export async function joinSnakeMatch(serverUrl: string, name: string, timeoutMs = 12_000): Promise<JoinOutcome> {
  const base = serverUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/snake/join`, {
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

export class SnakeNetClient {
  private constructor(private ws: WebSocket) {}

  // Opens ws(s)://.../snake/match/{matchId}/ws?token={token}, sends hello, resolves once `start`
  // arrives with the client plus the StartMsg payload (seeds the caller's local mirror).
  // `handlers` stay wired for the life of the connection — snap/end/close events keep flowing
  // through them after connect() resolves.
  static async connect(
    serverUrl: string,
    matchId: string,
    token: string,
    name: string,
    handlers: SnakeNetHandlers,
    timeoutMs = 12_000,
    factory: WebSocketFactory = realFactory,
  ): Promise<{ client: SnakeNetClient; start: StartMsg }> {
    const base = serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')
    const ws = factory(`${base}/snake/match/${matchId}/ws?token=${encodeURIComponent(token)}`)
    const client = new SnakeNetClient(ws)
    // Gates onClose so a pre-start close/error rejects connect() instead of reaching the
    // caller's handlers — only an established session's close should ever fire onClose.
    let started = false
    const start = await new Promise<StartMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('start timeout')), timeoutMs)
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name })))
      ws.on('message', (data: RawData) => {
        const msg: SnakeServerMsg | null = parseSnakeServerMsg(data.toString())
        if (!msg) return // garbage/oversized/malformed: ignored, never crashes or corrupts state
        if (msg.t === 'start') {
          started = true
          clearTimeout(timer)
          resolve(msg)
        } else if (msg.t === 'snap') {
          handlers.onSnap(msg.state)
        } else {
          handlers.onEnd(endResultToResult(msg.result))
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

  sendInput(msg: InputMsg): void {
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

// Minimal-diff wire logic: only send an InputMsg when this tick's latched dir actually differs
// from what the server was last told, AND the new dir is non-null (Input's null means "no key
// since spawn/last drain" — snake never stops, so there is nothing meaningful to relay for that;
// unlike bomber's dir:'keep', snake's InputMsg has no null/keep case at all, see protocol.ts). A
// quiet tick (dir unchanged, or still null) sends nothing.
export function diffInputForWire(prevDir: Dir | null, input: Input): { msg: InputMsg | null; nextDir: Dir | null } {
  if (input.dir === null || input.dir === prevDir) return { msg: null, nextDir: prevDir }
  return { msg: { t: 'input', dir: input.dir }, nextDir: input.dir }
}
