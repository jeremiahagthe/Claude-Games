export type Route = { kind: 'join' } | { kind: 'ws'; matchId: string } | { kind: 'health' } | null

export function route(pathname: string, method: string): Route {
  if (pathname === '/' && method === 'GET') return { kind: 'health' }
  if (pathname === '/api/join' && method === 'POST') return { kind: 'join' }
  const m = pathname.match(/^\/match\/([0-9a-f]+)\/ws$/)
  if (m && method === 'GET') return { kind: 'ws', matchId: m[1]! }
  return null
}
