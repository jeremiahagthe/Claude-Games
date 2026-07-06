import { parseServerMsg, type MatchState, type PlayerInput } from 'fragwait-core'
import { WebSocket, type RawData } from 'ws'

export interface NetHandlers {
  onWelcome(id: string, state: MatchState): void
  onSnap(state: MatchState): void
  onEnd(state: MatchState): void
  onClose(reason: string): void
}

// Factory seam for the underlying socket. Production passes the real `ws`
// constructor; tests inject a fake so the connect handshake / full-retry logic
// is exercisable without a live server.
export type WebSocketFactory = (url: string, opts: { handshakeTimeout: number }) => WebSocket

const realFactory: WebSocketFactory = (url, opts) => new WebSocket(url, opts)

export class NetClient {
  private constructor(private ws: WebSocket) {}

  // POST {serverUrl}/api/join → {matchId}; open ws(s)://.../match/{matchId}/ws;
  // send join; resolve on welcome. If the match closes with code 1013 reason
  // 'full' before welcome, retry ONCE with { exclude: matchId } so the lobby
  // hands out a different match. Any other close/error → throw.
  static async connect(
    serverUrl: string,
    handle: string,
    handlers: NetHandlers,
    timeoutMs = 4000,
    factory: WebSocketFactory = realFactory,
  ): Promise<NetClient> {
    const base = serverUrl.replace(/\/$/, '')
    let exclude: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${base}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exclude ? { exclude } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`join failed: ${res.status}`)
      const { matchId } = (await res.json()) as { matchId: string }
      const wsUrl = `${base.replace(/^http/, 'ws')}/match/${matchId}/ws`
      const ws = factory(wsUrl, { handshakeTimeout: timeoutMs })
      // One instance, built before the handshake promise. The message listener
      // stays attached after `welcome` resolves so live snaps/end keep flowing
      // through the same handlers.
      const client = new NetClient(ws)
      // Set once welcome resolves the attempt. Gates onClose so a pre-welcome
      // close — including the full-retry close below — never reaches the
      // caller; only a close of an established session should.
      let welcomed = false
      const outcome = await new Promise<'ok' | 'full' | 'error'>((resolve) => {
        ws.on('open', () => ws.send(JSON.stringify({ t: 'join', handle })))
        ws.on('message', (data: RawData) => {
          const msg = parseServerMsg(data.toString())
          if (!msg) return
          if (msg.t === 'welcome') {
            welcomed = true
            handlers.onWelcome(msg.id, msg.state)
            resolve('ok')
          } else if (msg.t === 'snap') handlers.onSnap(msg.state)
          else handlers.onEnd(msg.state)
        })
        ws.on('close', (_code: number, reason: Buffer) => {
          const why = reason.toString()
          resolve(why === 'full' ? 'full' : 'error')
          if (welcomed) handlers.onClose(why)
        })
        ws.on('error', () => resolve('error'))
      })
      if (outcome === 'ok') return client
      if (outcome === 'full') {
        exclude = matchId
        continue
      }
      throw new Error('connect failed')
    }
    throw new Error('no open match')
  }

  sendInputs(batch: PlayerInput[]): void {
    if (this.ws.readyState === WebSocket.OPEN && batch.length > 0) {
      this.ws.send(JSON.stringify({ t: 'input', inputs: batch }))
    }
  }

  leave(): void {
    try {
      this.ws.send(JSON.stringify({ t: 'leave' }))
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}
