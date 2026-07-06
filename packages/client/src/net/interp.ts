import { wrapAngle, type MatchState } from 'fragwait-core'

// Snapshot buffer + sampling for remote-entity rendering. Snapshots arrive at
// the server tick rate (20Hz); sample() is called once per render frame
// (~60fps) at renderAtMs = now - INTERP_DELAY_MS, and returns a lerped view
// between the two snapshots surrounding that render time.
//
// sample() always returns a fresh MatchState — every branch below returns a
// structuredClone of a stored snapshot (or a clone-based composite) rather
// than a reference into `snaps`, so a caller mutating the returned object (or
// the renderer holding onto it) can never corrupt the buffer, and repeated
// calls for the same renderAtMs are idempotent. At the 20Hz-push / 60fps-
// sample profile this is one structuredClone per frame of one MatchState
// (a handful of players) — cheap enough not to warrant a diffing scheme.
export class Interpolator {
  private snaps: Array<{ at: number; state: MatchState }> = []

  push(state: MatchState, atMs: number): void {
    this.snaps.push({ at: atMs, state })
    if (this.snaps.length > 20) this.snaps.shift()
  }

  sample(renderAtMs: number): MatchState | null {
    if (this.snaps.length === 0) return null
    if (this.snaps.length === 1 || renderAtMs <= this.snaps[0]!.at) return structuredClone(this.snaps[0]!.state)
    const last = this.snaps[this.snaps.length - 1]!
    if (renderAtMs >= last.at) return structuredClone(last.state)
    let i = 0
    while (this.snaps[i + 1]!.at < renderAtMs) i++
    const a = this.snaps[i]!
    const b = this.snaps[i + 1]!
    const t = (renderAtMs - a.at) / Math.max(1, b.at - a.at)
    // Base the output on a clone of the newer snap: every field that isn't
    // explicitly lerped below (hp, frags, fireCooldown, hasRail, rail,
    // kills, timeLeftTicks, ...) is a discrete/event field and should reflect
    // the newer snap rather than blend, which falls out for free here.
    const out: MatchState = structuredClone(b.state)
    for (const [id, pb] of Object.entries(out.players)) {
      const pa = a.state.players[id]
      if (!pa) continue // joined between snaps: use the newer state as-is
      pb.pos.x = pa.pos.x + (pb.pos.x - pa.pos.x) * t
      pb.pos.y = pa.pos.y + (pb.pos.y - pa.pos.y) * t
      pb.dir = wrapAngle(pa.dir + wrapAngle(pb.dir - pa.dir) * t)
    }
    // Players present only in the older snap (gone by the newer one, e.g.
    // they left mid-buffer) aren't in `out` yet since it's based on `b`.
    // Carry their older-snap state over verbatim rather than dropping them.
    for (const [id, pa] of Object.entries(a.state.players)) {
      if (!(id in out.players)) out.players[id] = structuredClone(pa)
    }
    return out
  }
}
