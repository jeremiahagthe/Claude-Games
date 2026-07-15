// Blockwait online transport: a one-shot lobby POST (BlockLobbyDO gathers the duel's two humans
// for a short window, a bot always backfills an empty slot — never a noOpponent-style outcome)
// followed by a persistent match WebSocket. Transcribed from packages/snake-client/src/net.ts
// (factory seam for tests, handlers wired for the connection's whole life, resolving on `start`),
// with two block-specific differences: the ongoing traffic is a mix of `snap` (periodic full
// state), `garbage` (per-attack, on the VICTIM's own clock), and a final `end`; and the client is
// NOT render-only — online.ts locally steps its OWN board every tick and only RESYNCS from snaps
// (the per-player-clock authority model), so this transport just relays raw messages up.
import { parseBlockServerMsg, type BlockServerMsg, type GarbageMsg, type InputMsg, type Result, type StartMsg, type WireState } from 'blockwait-core'
import { WebSocket, type RawData } from 'ws'

export interface BlockNetHandlers {
  onSnap(state: WireState): void
  onGarbage(msg: GarbageMsg): void
  onEnd(result: Result): void
  onClose(reason: string): void
}

export type JoinOutcome = { kind: 'joined'; matchId: string; token: string } | { kind: 'error' }

// Factory seam for the underlying socket: production passes the real `ws` constructor, tests
// inject a fake so the join/handshake flow is exercisable without a live server.
export type WebSocketFactory = (url: string) => WebSocket

const realFactory: WebSocketFactory = (url) => new WebSocket(url)

// EndMsg.result is the compact wire form ([0,winner] | [1]=draw), not a Result — this converts it
// the same way protocol.ts's fromWire converts WireState.result, so callers only ever see the
// same Result shape offline.ts already works with.
function endResultToResult(r: [0, number] | [1]): Result {
  return r.length === 1 ? { kind: 'draw' } : { kind: 'win', winner: r[1] }
}

// POST {serverUrl}/block/join {name}. The lobby gathers briefly then always answers
// {matchId, token} — a bot backfills the empty slot server-side, so there is no noOpponent case
// to distinguish here. ANY failure (network error, non-2xx, timeout, malformed body) collapses to
// the same 'error' outcome; the caller's fallback (play offline) is identical regardless of why.
export async function joinBlockMatch(serverUrl: string, name: string, timeoutMs = 12_000): Promise<JoinOutcome> {
  const base = serverUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/block/join`, {
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

export class BlockNetClient {
  private constructor(private ws: WebSocket) {}

  // Opens ws(s)://.../block/match/{matchId}/ws?token={token}, sends hello, resolves once `start`
  // arrives with the client plus the StartMsg payload (seeds the caller's local mirror).
  // `handlers` stay wired for the life of the connection — snap/garbage/end/close events keep
  // flowing through them after connect() resolves.
  static async connect(
    serverUrl: string,
    matchId: string,
    token: string,
    name: string,
    handlers: BlockNetHandlers,
    timeoutMs = 12_000,
    factory: WebSocketFactory = realFactory,
  ): Promise<{ client: BlockNetClient; start: StartMsg }> {
    const base = serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')
    const ws = factory(`${base}/block/match/${matchId}/ws?token=${encodeURIComponent(token)}`)
    const client = new BlockNetClient(ws)
    // Gates onClose so a pre-start close/error rejects connect() instead of reaching the caller's
    // handlers — only an established session's close should ever fire onClose.
    let started = false
    const start = await new Promise<StartMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('start timeout')), timeoutMs)
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name })))
      ws.on('message', (data: RawData) => {
        const msg: BlockServerMsg | null = parseBlockServerMsg(data.toString())
        if (!msg) return // garbage/oversized/malformed: ignored, never crashes or corrupts state
        if (msg.t === 'start') {
          started = true
          clearTimeout(timer)
          resolve(msg)
        } else if (msg.t === 'snap') {
          handlers.onSnap(msg.state)
        } else if (msg.t === 'garbage') {
          handlers.onGarbage(msg)
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
