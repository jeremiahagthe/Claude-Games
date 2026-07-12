// Bomber's online transport: a one-shot lobby POST (up to MAX_PLAYERS humans gather for
// ~10s, bots always backfill any empty slots — never a noOpponent-style outcome, see Task 8's
// bomber-lobby.ts) followed by a persistent match WebSocket. Mirrors
// packages/chess-client/src/net.ts's shape (factory seam for tests, handlers wired for the
// connection's whole life), but resolves on `start` instead of `welcome`, and the ongoing
// traffic afterward is a `snap` stream (client is render-only — it never locally steps the
// sim, every snap REPLACES the rendered state) rather than a per-move relay.
import { parseBomberServerMsg, type BomberServerMsg, type Dir, type Input, type InputMsg, type Result, type StartMsg, type WireState } from 'boomwait-core'
import { WebSocket, type RawData } from 'ws'

export interface BomberNetHandlers {
  onSnap(state: WireState): void
  onEnd(result: Result): void
  onClose(reason: string): void
}

export type JoinOutcome = { kind: 'joined'; matchId: string; token: string } | { kind: 'error' }

// Factory seam for the underlying socket: production passes the real `ws` constructor, tests
// inject a fake so the join/handshake flow is exercisable without a live server.
export type WebSocketFactory = (url: string) => WebSocket

const realFactory: WebSocketFactory = (url) => new WebSocket(url)

// POST {serverUrl}/bomber/join {name}. The lobby gathers for ~10s (Task 8) then always answers
// {matchId, token} — bots backfill empty slots server-side, so there is no noOpponent case to
// distinguish here. ANY failure (network error, non-2xx, timeout, malformed body) collapses to
// the same 'error' outcome; the caller's fallback (play offline) is identical regardless of why.
export async function joinBomberMatch(serverUrl: string, name: string, timeoutMs = 12_000): Promise<JoinOutcome> {
  const base = serverUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/bomber/join`, {
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

export class BomberNetClient {
  private constructor(private ws: WebSocket) {}

  // Opens ws(s)://.../bomber/match/{matchId}/ws?token={token}, sends hello, resolves once
  // `start` arrives with the client plus the StartMsg payload (seeds the caller's local
  // mirror). `handlers` stay wired for the life of the connection — snap/end/close events
  // keep flowing through them after connect() resolves.
  static async connect(
    serverUrl: string,
    matchId: string,
    token: string,
    name: string,
    handlers: BomberNetHandlers,
    timeoutMs = 12_000,
    factory: WebSocketFactory = realFactory,
  ): Promise<{ client: BomberNetClient; start: StartMsg }> {
    const base = serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')
    const ws = factory(`${base}/bomber/match/${matchId}/ws?token=${encodeURIComponent(token)}`)
    const client = new BomberNetClient(ws)
    // Gates onClose so a pre-start close/error rejects connect() instead of reaching the
    // caller's handlers — only an established session's close should ever fire onClose.
    let started = false
    const start = await new Promise<StartMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('start timeout')), timeoutMs)
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name })))
      ws.on('message', (data: RawData) => {
        const msg: BomberServerMsg | null = parseBomberServerMsg(data.toString())
        if (!msg) return // garbage/oversized/malformed: ignored, never crashes or corrupts state
        if (msg.t === 'start') {
          started = true
          clearTimeout(timer)
          resolve(msg)
        } else if (msg.t === 'snap') {
          handlers.onSnap(msg.state)
        } else {
          handlers.onEnd(msg.result)
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

// Minimal-diff wire logic: only send an InputMsg when this tick's latched Input actually
// differs from what the server was last told. A quiet tick (dir unchanged, no bomb queued)
// sends nothing at all; a dir change sends the new dir; a bomb queued with the dir unchanged
// sends dir:'keep' (the server's own handleMessage in bomber-match.ts treats 'keep' as "don't
// touch the latched dir") so the bomb flag rides alone. Pure and separately tested (mirrors
// input-latch.ts's pure onKey/drain — the loop in online.ts just calls this every tick).
export function diffInputForWire(prevDir: Dir | null, input: Input): { msg: InputMsg | null; nextDir: Dir | null } {
  const dirChanged = input.dir !== prevDir
  if (!dirChanged && !input.bomb) return { msg: null, nextDir: prevDir }
  return { msg: { t: 'input', dir: dirChanged ? input.dir : 'keep', bomb: input.bomb }, nextDir: input.dir }
}
