import { MAX_PLAYERS } from 'snakewait-core'

const WAIT_MS = 10_000

export interface LobbyOutcome {
  matchId: string
  humanCount: number
}

interface Room {
  matchId: string
  createdAt: number
  waiters: Array<(o: LobbyOutcome) => void>
}

export type JoinRegResult =
  | { filled: true; matchId: string }
  | { filled: false; isNewRoom: boolean; matchId: string }

/**
 * Pure gather-window pairing logic for the snake lobby — copied near-verbatim from
 * bomber-lobby.ts's BomberLobbyQueue (see that file's header comment for the full
 * reasoning): fills a single room with up to MAX_PLAYERS humans and always starts a
 * match — bots backfill any empty slots, so there is no noOpponent-style outcome here.
 */
export class SnakeLobbyQueue {
  private room: Room | null = null

  join(candidateMatchId: string, nowMs: number, resolve: (o: LobbyOutcome) => void): JoinRegResult {
    if (this.room && nowMs - this.room.createdAt >= WAIT_MS) {
      const stale = this.room
      this.room = null
      this.resolveRoom(stale)
    }
    if (this.room) {
      this.room.waiters.push(resolve)
      const matchId = this.room.matchId
      if (this.room.waiters.length >= MAX_PLAYERS) {
        const room = this.room
        this.room = null
        this.resolveRoom(room)
        return { filled: true, matchId }
      }
      return { filled: false, isNewRoom: false, matchId }
    }
    this.room = { matchId: candidateMatchId, createdAt: nowMs, waiters: [resolve] }
    return { filled: false, isNewRoom: true, matchId: candidateMatchId }
  }

  // Called by the room-creating joiner's own WAIT_MS timer. Resolves the room's current
  // waiters with their actual headcount only if it is still THIS room -- if it was already
  // filled or displaced in the meantime, its waiters' resolves already fired and this is a
  // no-op.
  expire(matchId: string): void {
    if (this.room && this.room.matchId === matchId) {
      const room = this.room
      this.room = null
      this.resolveRoom(room)
    }
  }

  private resolveRoom(room: Room): void {
    const humanCount = room.waiters.length
    for (const w of room.waiters) w({ matchId: room.matchId, humanCount })
  }
}

export interface SnakeLobbyEnv {
  SNAKE_MATCH: DurableObjectNamespace
}

export class SnakeLobbyDO implements DurableObject {
  private queue = new SnakeLobbyQueue()

  constructor(private state: DurableObjectState, private env: SnakeLobbyEnv) {}

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method', { status: 405 })
    // The client's name is re-sent over the ws 'hello' once connected (see snake-match.ts);
    // the lobby itself doesn't strictly need it here, but a missing/malformed body or absent
    // name must never throw on a public endpoint (the snakewait CF-1101 lesson) -- parse
    // defensively and return an explicit 400, exactly matching block-lobby.ts's join contract.
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (typeof body !== 'object' || body === null || typeof (body as { name?: unknown }).name !== 'string') {
      return new Response('bad request', { status: 400 })
    }
    const candidateMatchId = this.env.SNAKE_MATCH.newUniqueId().toString()
    const outcome = await new Promise<LobbyOutcome>((resolve) => {
      const r = this.queue.join(candidateMatchId, Date.now(), resolve)
      if (r.filled) return // already resolved synchronously inside join()
      if (r.isNewRoom) setTimeout(() => this.queue.expire(candidateMatchId), WAIT_MS)
    })
    return Response.json({ matchId: outcome.matchId, token: String(outcome.humanCount) })
  }
}
