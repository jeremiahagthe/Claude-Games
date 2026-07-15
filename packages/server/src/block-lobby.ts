const WAIT_MS = 10_000
// A block duel is 2 boards. The lobby gathers up to this many humans; the match DO
// backfills any empty slot with one 'normal' bot (see block-match.ts's start()).
export const HUMANS_PER_MATCH = 2

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
 * Pure gather-window pairing logic for the block lobby — the snakewait analogue of
 * SnakeLobbyQueue (see snake-lobby.ts's header for the full reasoning), with the fill
 * threshold dropped to HUMANS_PER_MATCH (2): a single room fills with up to 2 humans and
 * always starts a match — a bot backfills the empty slot, so there is no noOpponent outcome.
 */
export class BlockLobbyQueue {
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
      if (this.room.waiters.length >= HUMANS_PER_MATCH) {
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
  // filled or displaced in the meantime, its waiters' resolves already fired and this is a no-op.
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

export interface BlockLobbyEnv {
  BLOCK_MATCH: DurableObjectNamespace
}

export class BlockLobbyDO implements DurableObject {
  private queue = new BlockLobbyQueue()

  constructor(private state: DurableObjectState, private env: BlockLobbyEnv) {}

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method', { status: 405 })
    // Unlike snake/bomber (which swallow a garbage body), the block join contract is an
    // explicit 400 on a missing/malformed body or absent name (the snakewait CF-1101 lesson):
    // parse defensively and never throw on a public endpoint. The name itself is re-sent over
    // the ws 'hello' once connected (see block-match.ts), so the lobby only needs its presence.
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (typeof body !== 'object' || body === null || typeof (body as { name?: unknown }).name !== 'string') {
      return new Response('bad request', { status: 400 })
    }
    const candidateMatchId = this.env.BLOCK_MATCH.newUniqueId().toString()
    const outcome = await new Promise<LobbyOutcome>((resolve) => {
      const r = this.queue.join(candidateMatchId, Date.now(), resolve)
      if (r.filled) return // already resolved synchronously inside join()
      if (r.isNewRoom) setTimeout(() => this.queue.expire(candidateMatchId), WAIT_MS)
    })
    return Response.json({ matchId: outcome.matchId, token: String(outcome.humanCount) })
  }
}
