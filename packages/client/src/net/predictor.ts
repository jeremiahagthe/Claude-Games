import { stepPlayer, type GameMap, type PlayerInput, type PlayerState } from 'fragwait-core'

// Client-side prediction + server reconciliation for the local player.
//
// applyLocal() runs the input immediately (optimistic prediction) and keeps
// it in a pending buffer. onServerState() drops any pending input the server
// has already applied (seq <= server.lastInputSeq), then replays the rest on
// top of the authoritative server state (rebase). Inputs are treated as
// opaque — this class never inspects or mutates input fields (e.g.
// aimOffset); it only pushes/filters/replays them verbatim through
// stepPlayer, which is what makes the replay deterministic and reproducible.
export class Predictor {
  self: PlayerState
  private pending: PlayerInput[] = []
  // Highest server.lastInputSeq we've rebased onto so far. Used to reject
  // stale/out-of-order deliveries (see onServerState below).
  private highestAppliedSeq = -Infinity

  constructor(initial: PlayerState, private map: GameMap) {
    this.self = structuredClone(initial)
  }

  applyLocal(input: PlayerInput): void {
    this.pending.push(input)
    // Cap: 64 pending inputs ~= >3 seconds of unacked input at 20Hz. Beyond
    // this the oldest unacked inputs are dropped and self can diverge from
    // the true replay until the server's ack catches up past the dropped
    // range — at that point the next rebase in onServerState() is exact
    // again. This is deliberate, authoritative-server behavior: the client
    // never has more say than the server's own simulation, so a bounded,
    // self-healing divergence window is acceptable and simpler than an
    // unbounded buffer.
    if (this.pending.length > 64) this.pending.shift()
    stepPlayer(this.self, input, this.map)
  }

  onServerState(server: PlayerState): void {
    // Ignore stale/out-of-order state deliveries (e.g. duplicate or
    // reordered packets). Rebasing onto an older lastInputSeq than one
    // we've already applied would rebase onto stale server state while the
    // pending buffer has already been trimmed for the newer ack — losing
    // those inputs permanently. Since already-applied is monotonic here,
    // simply drop anything not newer than what we've seen.
    if (server.lastInputSeq < this.highestAppliedSeq) return
    this.highestAppliedSeq = server.lastInputSeq
    this.pending = this.pending.filter((i) => i.seq > server.lastInputSeq)
    const rebased = structuredClone(server)
    for (const i of this.pending) stepPlayer(rebased, i, this.map)
    this.self = rebased
  }
}
