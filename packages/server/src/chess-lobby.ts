const WAIT_MS = 10_000

export type LobbyOutcome = { matchId: string } | { noOpponent: true }

interface Waiter {
  matchId: string
  createdAt: number
  resolve: (outcome: LobbyOutcome) => void
}

/**
 * Pure 1v1 pairing logic for the chess lobby: unlike fragwait's LobbyRegistry
 * (which fills matches with bots so it never has to make a caller wait),
 * checkwait needs exactly two humans, so a single waiting slot holds at most
 * one joiner at a time.
 *
 * Every outcome is delivered through the waiter's `resolve` callback exactly
 * once, from exactly one of three places:
 *  - a second joiner pairs with a live waiter → resolve({ matchId }) NOW
 *    (the waiter's long-poll wakes immediately, it never sits out the 10s);
 *  - a late joiner displaces a stale waiter → the displaced waiter gets
 *    resolve({ noOpponent }) NOW (never a matchId nobody will join);
 *  - the waiter's own WAIT_MS timer calls expire() → resolve({ noOpponent }).
 * Clearing/replacing `this.waiting` at each resolve site is what makes the
 * later expire() call a no-op, so no waiter can be resolved twice.
 */
export class ChessLobbyQueue {
  private waiting: Waiter | null = null

  join(
    candidateMatchId: string,
    nowMs: number,
    resolve: (outcome: LobbyOutcome) => void,
  ): { paired: true; matchId: string } | { paired: false } {
    if (this.waiting) {
      if (nowMs - this.waiting.createdAt < WAIT_MS) {
        const { matchId, resolve: wakeWaiter } = this.waiting
        this.waiting = null
        wakeWaiter({ matchId })
        return { paired: true, matchId }
      }
      // Stale waiter whose expire() timer has not fired yet: displace it with
      // an honest noOpponent -- its matchId is about to be forgotten, so
      // handing it out later would create a match nobody else can ever join.
      this.waiting.resolve({ noOpponent: true })
    }
    this.waiting = { matchId: candidateMatchId, createdAt: nowMs, resolve }
    return { paired: false }
  }

  // Called by the original waiter's own WAIT_MS timer. Resolves the waiter
  // with noOpponent only if it is still THIS candidate -- if it was paired or
  // displaced in the meantime, its resolve already fired and this is a no-op.
  expire(candidateMatchId: string): void {
    if (this.waiting && this.waiting.matchId === candidateMatchId) {
      const { resolve } = this.waiting
      this.waiting = null
      resolve({ noOpponent: true })
    }
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
    const outcome = await new Promise<LobbyOutcome>((resolve) => {
      const r = this.queue.join(candidateMatchId, Date.now(), resolve)
      if (r.paired) {
        resolve({ matchId: r.matchId })
        return
      }
      // We are now the waiter: our promise resolves from whichever fires
      // first -- a pairing/displacement inside a later queue.join(), or this
      // timer calling expire(). Both paths go through the queue's exactly-once
      // resolve discipline, so the extra timer after a pairing is harmless.
      setTimeout(() => this.queue.expire(candidateMatchId), WAIT_MS)
    })
    return Response.json(outcome)
  }
}
