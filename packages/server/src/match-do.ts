import { sanitizeHandle, TICK_MS } from '@fragwait/core'
import { MatchHost } from './match-host.js'

export class MatchDO implements DurableObject {
  private host: MatchHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private ids = new WeakMap<WebSocket, string>()

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    this.host ??= new MatchHost(Math.floor(Math.random() * 2 ** 31))

    server.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      const id = this.ids.get(server)
      if (id) {
        this.host?.handleMessage(id, raw)
        return
      }
      // first message must be join
      const joinId = raw.includes('"join"')
        ? this.host!.join({ send: (d) => server.send(d), close: () => server.close(1000, 'bye') },
            sanitizeHandle((JSON.parse(raw) as { handle?: string }).handle ?? 'anon'))
        : null
      if (joinId === null) {
        server.close(1013, 'full')
        return
      }
      this.ids.set(server, joinId)
      this.startLoop()
    })
    server.addEventListener('close', () => {
      const id = this.ids.get(server)
      if (id) this.host?.leave(id)
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  private startLoop(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const status = this.host?.tick() ?? 'empty'
      if (status !== 'running') this.stopLoop() // 'empty' rooms must stop: DO CPU budget (spec §4.3)
    }, TICK_MS)
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.host = null // next join builds a fresh match
  }
}
