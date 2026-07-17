// anim.ts — pure playback state machine over a ResolveOut (client-side ANIM
// twin of the server's animAllowanceMs). One advancePlayback() is one 50ms
// frame: 3 trajectory steps per frame, then — if the shot connected — 6
// explosion frames, then 6 settle frames showing the post-shot state (≈
// ANIM_TAIL_MS), then done. A lost shell (impact null) has nothing to blow up,
// so it skips the explosion frames and goes straight from trajectory to settle.
// Nothing here reads ResolveOut.state; the offline loop adopts out.state itself
// once the playback is done.
import type { ResolveOut } from 'tankwait-core'
import type { RenderView } from './render.js'

const STEPS_PER_FRAME = 3
const EXPLOSION_FRAMES = 6 // render draws explosion frame 0..5
const SETTLE_FRAMES = 6

export interface Playback {
  out: ResolveOut
  cursor: number // 0-based frame index
  done: boolean
}

export function createPlayback(out: ResolveOut): Playback {
  return { out, cursor: 0, done: false }
}

// Frames needed to walk the whole trajectory STEPS_PER_FRAME at a time, with the
// final frame landing exactly on the last point (the muzzle-first trajectory
// always has ≥ 1 point).
function trajFrameCount(out: ResolveOut): number {
  const n = out.trajectory.length
  return Math.ceil(Math.max(0, n - 1) / STEPS_PER_FRAME) + 1
}

function totalFrames(out: ResolveOut): number {
  const explosion = out.impact ? EXPLOSION_FRAMES : 0
  return trajFrameCount(out) + explosion + SETTLE_FRAMES
}

export function advancePlayback(pb: Playback): Playback {
  if (pb.done) return pb
  const cursor = pb.cursor + 1
  return { out: pb.out, cursor, done: cursor >= totalFrames(pb.out) }
}

export function playbackView(pb: Playback): Pick<RenderView, 'shell' | 'trail' | 'explosion'> {
  const { out, cursor } = pb
  const tf = trajFrameCount(out)

  // Trajectory phase: shell at the cursor step, trail the arc drawn so far.
  if (cursor < tf) {
    const last = out.trajectory.length - 1
    const step = Math.min(last, cursor * STEPS_PER_FRAME)
    return {
      shell: out.trajectory[step] ?? null,
      trail: out.trajectory.slice(0, step + 1),
      explosion: null,
    }
  }

  // Explosion phase (impact only): keep the full arc visible while the ring
  // expands over frames 0..5.
  if (out.impact) {
    const ef = cursor - tf
    if (ef < EXPLOSION_FRAMES) {
      return {
        shell: null,
        trail: out.trajectory,
        explosion: { x: out.impact.x, y: out.impact.y, frame: ef },
      }
    }
  }

  // Settle phase (and beyond, once done): clean post-shot state.
  return { shell: null, trail: [], explosion: null }
}
