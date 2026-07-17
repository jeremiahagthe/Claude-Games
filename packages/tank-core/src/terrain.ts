import { TERRAIN_MAX, TERRAIN_MIN } from './constants.js'
import { randStep } from './prng.js'

// genTerrain: midpoint-displacement terrain generation, pinned by golden tests.
// 81 knots k[0..80]; k[0] and k[80] seeded uniform in [TERRAIN_MIN, TERRAIN_MAX]
// (two randStep draws, in that order). mid(lo, hi, amp) recursively fills the
// interior (left half before right half — draw order is part of the pin).
// Two clamped-edge smoothing passes, then clamp all to range, return first 80.
export function genTerrain(rng: number): { heights: number[]; rng: number } {
  const k: number[] = new Array(81)
  let s = rng

  const draw0 = randStep(s)
  k[0] = TERRAIN_MIN + draw0.value * (TERRAIN_MAX - TERRAIN_MIN)
  s = draw0.next

  const draw80 = randStep(s)
  k[80] = TERRAIN_MIN + draw80.value * (TERRAIN_MAX - TERRAIN_MIN)
  s = draw80.next

  const initialAmp = (TERRAIN_MAX - TERRAIN_MIN) / 2

  function mid(lo: number, hi: number, amp: number): void {
    if (hi - lo < 2) return
    const m = (lo + hi) >> 1
    const draw = randStep(s)
    s = draw.next
    k[m] = (k[lo]! + k[hi]!) / 2 + (draw.value * 2 - 1) * amp
    mid(lo, m, amp / 2)
    mid(m, hi, amp / 2)
  }
  mid(0, 80, initialAmp)

  const clampedEdge = (arr: number[], i: number): number => arr[Math.max(0, Math.min(arr.length - 1, i))]!

  const smooth1: number[] = new Array(81)
  for (let i = 0; i <= 80; i++) {
    smooth1[i] = (clampedEdge(k, i - 1) + 2 * k[i]! + clampedEdge(k, i + 1)) / 4
  }
  const smooth2: number[] = new Array(81)
  for (let i = 0; i <= 80; i++) {
    smooth2[i] = (clampedEdge(smooth1, i - 1) + 2 * smooth1[i]! + clampedEdge(smooth1, i + 1)) / 4
  }

  const clamp = (v: number): number => Math.max(TERRAIN_MIN, Math.min(TERRAIN_MAX, v))
  const heights = smooth2.slice(0, 80).map(clamp)

  return { heights, rng: s }
}
