import { route } from './router.js'
import { parseChessMatchId } from './chess-match.js'
import { parseBomberMatchId } from './bomber-match.js'

export interface Env {
  MATCH: DurableObjectNamespace
  LOBBY: DurableObjectNamespace
  CHESS_LOBBY: DurableObjectNamespace
  CHESS_MATCH: DurableObjectNamespace
  BOMBER_LOBBY: DurableObjectNamespace
  BOMBER_MATCH: DurableObjectNamespace
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // Chess routes live outside the shared fragwait router (kept untouched): the
    // path shapes are distinct enough (/chess/...) that a plain check is clearer
    // than growing router.ts's Route union for an unrelated game.
    if (url.pathname === '/chess/join' && req.method === 'POST') {
      return env.CHESS_LOBBY.get(env.CHESS_LOBBY.idFromName('chess')).fetch(req)
    }
    const chessMatchId = parseChessMatchId(url.pathname)
    if (chessMatchId && req.method === 'GET') {
      return env.CHESS_MATCH.get(env.CHESS_MATCH.idFromString(chessMatchId)).fetch(req)
    }

    // Bomber routes: same shape as chess's, kept outside the shared fragwait router.
    if (url.pathname === '/bomber/join' && req.method === 'POST') {
      return env.BOMBER_LOBBY.get(env.BOMBER_LOBBY.idFromName('bomber')).fetch(req)
    }
    const bomberMatchId = parseBomberMatchId(url.pathname)
    if (bomberMatchId && req.method === 'GET') {
      return env.BOMBER_MATCH.get(env.BOMBER_MATCH.idFromString(bomberMatchId)).fetch(req)
    }

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
export { ChessLobbyDO } from './chess-lobby.js'
export { ChessMatchDO } from './chess-match.js'
export { BomberLobbyDO } from './bomber-lobby.js'
export { BomberMatchDO } from './bomber-match.js'
