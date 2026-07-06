import { LobbyRegistry } from './lobby-logic.js'

export interface LobbyEnv { MATCH: DurableObjectNamespace }

export class LobbyDO implements DurableObject {
  private registry = new LobbyRegistry()

  constructor(private state: DurableObjectState, private env: LobbyEnv) {}

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method', { status: 405 })
    let exclude: string | undefined
    try {
      const body = (await req.json()) as { exclude?: string }
      if (typeof body.exclude === 'string') exclude = body.exclude
    } catch { /* empty body is fine */ }
    const now = Date.now()
    let matchId = this.registry.pick(now, exclude)
    if (matchId) {
      this.registry.assign(matchId)
    } else {
      matchId = this.env.MATCH.newUniqueId().toString()
      this.registry.register(matchId, now)
    }
    return Response.json({ matchId })
  }
}
