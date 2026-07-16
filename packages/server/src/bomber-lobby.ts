import { MAX_PLAYERS } from 'boomwait-core'

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
 * Pure gather-window pairing logic for the bomber lobby: unlike checkwait's
 * ChessLobbyQueue (exactly two humans, one waiting slot), boomwait fills a
 * single room with UP TO MAX_PLAYERS humans and always starts a match — bots
 * backfill any empty slots, so there is no noOpponent-style outcome here.
 *
 * Every outcome is delivered through a waiter's resolve callback exactly
 * once, from exactly one of three places:
 *  - the MAX_PLAYERS-th joiner fills the room → every waiter in it (including
 *    this one) resolves NOW with humanCount === MAX_PLAYERS, never waiting
 *    out the rest of the window;
 *  - a joiner arrives after the room's own WAIT_MS window has elapsed but
 *    before its own expire() timer has fired → the stale room's waiters are
 *    displaced with an honest humanCount (whatever headcount it reached),
 *    same idea as ChessLobbyQueue's displacement, generalized to N waiters;
 *  - the room's own WAIT_MS timer calls expire().
 * Clearing `this.room` at each resolve site makes a later expire() call for
 * that room a no-op, so no waiter can ever be resolved twice.
 */
export class BomberLobbyQueue {
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

  // Called by the room-creating joiner's own WAIT_MS timer. Resolves the
  // room's current waiters with their actual headcount only if it is still
  // THIS room -- if it was already filled or displaced in the meantime, its
  // waiters' resolves already fired and this is a no-op.
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

export interface BomberLobbyEnv {
  BOMBER_MATCH: DurableObjectNamespace
}

export class BomberLobbyDO implements DurableObject {
  private queue = new BomberLobbyQueue()

  constructor(private state: DurableObjectState, private env: BomberLobbyEnv) {}

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method', { status: 405 })
    // The client's name is re-sent over the ws 'hello' once connected (see bomber-match.ts);
    // the lobby itself doesn't need it, so a garbage/absent body must never throw here (same
    // defensive shape as lobby-do.ts's `exclude` field).
    try {
      await req.json()
    } catch {
      /* empty/garbage body is fine */
    }
    const candidateMatchId = this.env.BOMBER_MATCH.newUniqueId().toString()
    const outcome = await new Promise<LobbyOutcome>((resolve) => {
      const r = this.queue.join(candidateMatchId, Date.now(), resolve)
      if (r.filled) return // already resolved synchronously inside join()
      if (r.isNewRoom) setTimeout(() => this.queue.expire(candidateMatchId), WAIT_MS)
    })
    return Response.json({ matchId: outcome.matchId, token: String(outcome.humanCount) })
  }
}

// Fresh class = fresh Durable Object NAMESPACE. On 2026-07-16 every instance of the
// original BomberLobbyDO namespace (including never-before-used names) returned
// "internal error; reference = ..." on prod across three clean deploys while the same
// bundle worked under wrangler dev — a Cloudflare-side namespace failure, not code.
// Migration v6 rebinds BOMBER_LOBBY here; lobby state is ephemeral, nothing migrates.
export class BomberLobby2DO extends BomberLobbyDO {}
