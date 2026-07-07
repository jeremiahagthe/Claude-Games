const WAIT_MS = 10_000

interface Waiter {
  matchId: string
  createdAt: number
}

/**
 * Pure 1v1 pairing logic for the chess lobby: unlike fragwait's LobbyRegistry
 * (which fills matches with bots so it never has to make a caller wait),
 * checkwait needs exactly two humans, so a single waiting slot holds at most
 * one joiner at a time. `join` is called once per POST /chess/join with a
 * freshly-minted candidate matchId: if a live (not yet stale) waiter exists,
 * it is paired with (and cleared); otherwise this call's matchId becomes the
 * new waiter, and the caller must hold the HTTP request open for up to
 * WAIT_MS waiting for either a pairing or its own `expire()` timeout.
 */
export class ChessLobbyQueue {
  private waiting: Waiter | null = null

  join(candidateMatchId: string, nowMs: number): { paired: true; matchId: string } | { paired: false } {
    if (this.waiting && nowMs - this.waiting.createdAt < WAIT_MS) {
      const matchId = this.waiting.matchId
      this.waiting = null
      return { paired: true, matchId }
    }
    this.waiting = { matchId: candidateMatchId, createdAt: nowMs }
    return { paired: false }
  }

  // Called by the original waiter's own ~WAIT_MS timeout. Clears the waiter
  // (reporting true) only if it is still THIS candidate -- i.e. nobody paired
  // with it in the meantime. Returns false if it already got paired.
  expire(candidateMatchId: string): boolean {
    if (this.waiting && this.waiting.matchId === candidateMatchId) {
      this.waiting = null
      return true
    }
    return false
  }
}

export interface ChessLobbyEnv {
  CHESS_MATCH: DurableObjectNamespace
}

export class ChessLobbyDO implements DurableObject {
  private queue = new ChessLobbyQueue()

  constructor(private state: DurableObjectState, private env: ChessLobbyEnv) {}

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method', { status: 405 })
    // Same id-generation scheme as fragwait's LobbyDO: a DO-minted unique id,
    // used as both the candidate matchId and (if nobody pairs with us) wasted
    // harmlessly -- the DO namespace has no notion of "unused" ids to reclaim.
    const candidateMatchId = this.env.CHESS_MATCH.newUniqueId().toString()
    const result = this.queue.join(candidateMatchId, Date.now())
    if (result.paired) return Response.json({ matchId: result.matchId })

    const timedOut = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(this.queue.expire(candidateMatchId)), WAIT_MS)
    })
    if (timedOut) return Response.json({ noOpponent: true })
    // Someone paired with us while we waited: our own candidateMatchId is the shared one.
    return Response.json({ matchId: candidateMatchId })
  }
}
