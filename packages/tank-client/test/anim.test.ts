import { describe, expect, it } from 'vitest'
import type { ResolveOut } from 'tankwait-core'
import { advancePlayback, createPlayback, playbackView } from '../src/anim.js'

// anim.ts is a PURE playback state machine over a ResolveOut — it never reads
// ResolveOut.state, so these tests feed synthetic trajectories with a known
// shape rather than running the physics. 3 trajectory steps per 50ms frame,
// then 6 explosion frames, then 6 settle frames, done; a lost shell (impact
// null) skips the explosion frames.

const traj: [number, number][] = [
  [0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6],
]

const mkOut = (over: Partial<ResolveOut> = {}): ResolveOut => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: {} as any, // playback never reads state
  trajectory: traj,
  impact: { x: 6, y: 6 },
  damage: [0, 0],
  ...over,
})

// Walk a playback to completion, collecting the per-frame view + a phase label.
function walk(out: ResolveOut): {
  frames: ReturnType<typeof playbackView>[]
  explosionFrames: number[]
  count: number
} {
  let pb = createPlayback(out)
  const frames: ReturnType<typeof playbackView>[] = []
  const explosionFrames: number[] = []
  let count = 0
  while (!pb.done && count < 1000) {
    const v = playbackView(pb)
    frames.push(v)
    if (v.explosion) explosionFrames.push(v.explosion.frame)
    pb = advancePlayback(pb)
    count++
  }
  return { frames, explosionFrames, count }
}

describe('createPlayback', () => {
  it('starts at cursor 0, not done', () => {
    const pb = createPlayback(mkOut())
    expect(pb.cursor).toBe(0)
    expect(pb.done).toBe(false)
  })
})

describe('advancePlayback + playbackView: trajectory phase', () => {
  it('the first frame shows the muzzle shell with a single-point trail', () => {
    const v = playbackView(createPlayback(mkOut()))
    expect(v.shell).toEqual([0, 0])
    expect(v.trail).toEqual([[0, 0]])
    expect(v.explosion).toBeNull()
  })

  it('advancing consumes 3 trajectory steps per frame, trail behind the shell', () => {
    let pb = createPlayback(mkOut())
    pb = advancePlayback(pb) // cursor 1 → step 3
    let v = playbackView(pb)
    expect(v.shell).toEqual([3, 3])
    expect(v.trail).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]])

    pb = advancePlayback(pb) // cursor 2 → step 6 (clamped to the last point)
    v = playbackView(pb)
    expect(v.shell).toEqual([6, 6])
  })
})

describe('advancePlayback: explosion then settle then done', () => {
  it('after the trajectory: exactly 6 explosion frames (0..5)', () => {
    expect(walk(mkOut()).explosionFrames).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('runs trajectory (3) + explosion (6) + settle (6) = 15 frames total', () => {
    // 7 points → ceil(6/3)+1 = 3 trajectory frames.
    expect(walk(mkOut()).count).toBe(3 + 6 + 6)
  })

  it('the settle frames show the clean post-shot state (no shell, no explosion)', () => {
    const { frames } = walk(mkOut())
    const settle = frames.slice(3 + 6) // after trajectory + explosion
    expect(settle.length).toBe(6)
    for (const v of settle) {
      expect(v.shell).toBeNull()
      expect(v.explosion).toBeNull()
      expect(v.trail).toEqual([])
    }
  })
})

describe('advancePlayback: a lost shell skips the explosion frames', () => {
  it('impact null → no explosion frames, trajectory (3) + settle (6) = 9 frames', () => {
    const { explosionFrames, count } = walk(mkOut({ impact: null }))
    expect(explosionFrames).toEqual([])
    expect(count).toBe(3 + 6)
  })
})

describe('done is idempotent', () => {
  it('advancing a done playback returns it unchanged', () => {
    let pb = createPlayback(mkOut())
    while (!pb.done) pb = advancePlayback(pb)
    const again = advancePlayback(pb)
    expect(again).toEqual(pb)
  })
})
