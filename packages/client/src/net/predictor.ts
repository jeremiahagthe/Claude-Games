import { stepPlayer, type GameMap, type PlayerInput, type PlayerState } from '@fragwait/core'

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

  constructor(initial: PlayerState, private map: GameMap) {
    this.self = structuredClone(initial)
  }

  applyLocal(input: PlayerInput): void {
    this.pending.push(input)
    if (this.pending.length > 64) this.pending.shift()
    stepPlayer(this.self, input, this.map)
  }

  onServerState(server: PlayerState): void {
    this.pending = this.pending.filter((i) => i.seq > server.lastInputSeq)
    const rebased = structuredClone(server)
    for (const i of this.pending) stepPlayer(rebased, i, this.map)
    this.self = rebased
  }
}
