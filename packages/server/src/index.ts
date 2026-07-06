import { route } from './router.js'

export interface Env {
  MATCH: DurableObjectNamespace
  LOBBY: DurableObjectNamespace
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const r = route(url.pathname, req.method)
    if (!r) return new Response('not found', { status: 404 })
    if (r.kind === 'health') return new Response('fragwait-server ok')
    if (r.kind === 'join') {
      const continent = (req.cf?.continent as string | undefined) ?? 'XX'
      return env.LOBBY.get(env.LOBBY.idFromName(continent)).fetch(req)
    }
    return env.MATCH.get(env.MATCH.idFromString(r.matchId)).fetch(req)
  },
}

export { MatchDO } from './match-do.js'
export { LobbyDO } from './lobby-do.js'
