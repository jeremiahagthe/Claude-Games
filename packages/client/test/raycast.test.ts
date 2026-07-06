import { describe, expect, it } from 'vitest'
import { AIM_OFFSET_MAX, parseMap } from '@fragwait/core'
import type { MatchState, PlayerState } from '@fragwait/core'
import { FrameBuffer } from '../src/framebuffer.js'
import { RENDER_HALF_FOV, backgroundColorAt, renderView } from '../src/raycast.js'

const BOX = parseMap('box', 'Box', [
  '####################',
  '#SSSSSSSS..........#',
  '#..................#',
  '#........R.........#',
  '#..................#',
  '####################',
].join('\n'))

function player(id: string, x: number, y: number, dir = 0): PlayerState {
  return { id, handle: id, bot: false, pos: { x, y }, dir, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0 }
}

function mkState(...players: PlayerState[]): MatchState {
  const rec: Record<string, PlayerState> = {}
  for (const p of players) rec[p.id] = p
  return { tick: 0, timeLeftTicks: 3600, mapId: 'box', players: rec, rail: { pos: BOX.railSpawn, present: false, respawnTimer: 1 }, kills: [] }
}

function wallColumnHeight(fb: FrameBuffer, col: number): number {
  let count = 0
  for (let y = 0; y < fb.h; y++) {
    const i = (y * fb.w + col) * 3
    const [r, g, b] = [fb.px[i]!, fb.px[i + 1]!, fb.px[i + 2]!]
    const [br, bg, bb] = backgroundColorAt(y, fb.h)
    if (!(r === br && g === bg && b === bb)) count++
  }
  return count
}

describe('renderView', () => {
  it('closer walls render taller columns', () => {
    const fbNear = new FrameBuffer(80, 48)
    renderView(fbNear, BOX, mkState(player('me', 17.5, 3, 0)), 'me')
    const fbFar = new FrameBuffer(80, 48)
    renderView(fbFar, BOX, mkState(player('me', 2.5, 3, 0)), 'me')
    // column 10 avoids the center crosshair pixels
    expect(wallColumnHeight(fbNear, 10)).toBeGreaterThan(wallColumnHeight(fbFar, 10))
  })
  it('a visible enemy changes the rendered pixels', () => {
    const fbA = new FrameBuffer(80, 48)
    const fbB = new FrameBuffer(80, 48)
    renderView(fbA, BOX, mkState(player('me', 3.5, 3, 0), player('foe', 8.5, 3)), 'me')
    renderView(fbB, BOX, mkState(player('me', 3.5, 3, 0)), 'me')
    expect(Buffer.compare(Buffer.from(fbA.px), Buffer.from(fbB.px))).not.toBe(0)
  })
})

function pixelAt(fb: FrameBuffer, x: number, y: number): [number, number, number] {
  const i = (y * fb.w + x) * 3
  return [fb.px[i]!, fb.px[i + 1]!, fb.px[i + 2]!]
}

// Framebuffer position of the crosshair for a 1-based pointer cell (feel-7):
// fbx = clamp(x−1, 1, w−2), fby = clamp((y−1)·2+1, 1, h−2) — cells are two
// framebuffer rows tall, and the clamp keeps the 3×3 plus inside the view.
function crosshairFb(fb: FrameBuffer, x: number, y: number): [number, number] {
  return [
    Math.max(1, Math.min(fb.w - 2, x - 1)),
    Math.max(1, Math.min(fb.h - 2, (y - 1) * 2 + 1)),
  ]
}

function expectCrosshairAt(fb: FrameBuffer, cx: number, cy: number): void {
  expect(pixelAt(fb, cx, cy)).toEqual([255, 255, 255])
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    expect(pixelAt(fb, cx + dx, cy + dy)).toEqual([170, 170, 170])
  }
}

describe('crosshair', () => {
  it('renders a minimal plus (white center, gray arms) at framebuffer center when there is no pointer', () => {
    const fb = new FrameBuffer(80, 48)
    renderView(fb, BOX, mkState(player('me', 10, 3, 0)), 'me')
    const ccx = fb.w >> 1
    const ccy = fb.h >> 1
    expectCrosshairAt(fb, ccx, ccy)
    // the +-2 arms are gone (3x3 footprint): nothing at +-2 is pure white
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) {
      expect(pixelAt(fb, ccx + dx, ccy + dy)).not.toEqual([255, 255, 255])
    }
  })

  // feel-9: revert feel-8's suppression. The 3×3 plus ALWAYS draws — at the
  // clamped pointer cell in cursor mode, at center otherwise. (The feel-8
  // "no plus when the pointer is visible" tests are superseded by these.)
  it('draws the crosshair at the pointer cell (cursor aim), not at center', () => {
    const fb = new FrameBuffer(80, 48)
    const [x, y] = [20, 5]
    renderView(fb, BOX, mkState(player('me', 10, 3, 0)), 'me', 0, { now: 0, moving: {}, pointer: { x, y } })
    const [cx, cy] = crosshairFb(fb, x, y)
    expect([cx, cy]).toEqual([19, 9]) // x−1, (y−1)·2+1
    expectCrosshairAt(fb, cx, cy)
    // the framebuffer center is no longer the crosshair
    expect(pixelAt(fb, fb.w >> 1, fb.h >> 1)).not.toEqual([255, 255, 255])
  })

  it('clamps the crosshair inside the view when the pointer is over the HUD / off-view', () => {
    const far = new FrameBuffer(80, 48)
    renderView(far, BOX, mkState(player('me', 10, 3, 0)), 'me', 0, { now: 0, moving: {}, pointer: { x: 1000, y: 1000 } })
    expectCrosshairAt(far, far.w - 2, far.h - 2) // clamped to the far corner, plus still inside

    const near = new FrameBuffer(80, 48)
    renderView(near, BOX, mkState(player('me', 10, 3, 0)), 'me', 0, { now: 0, moving: {}, pointer: { x: -100, y: -100 } })
    expectCrosshairAt(near, 1, 1) // clamped to the near corner
  })

  it('muzzle flash blooms at the MOVED crosshair, leaving the dim arms untouched', () => {
    const fb = new FrameBuffer(80, 48)
    const [x, y] = [30, 6]
    renderView(fb, BOX, mkState(player('me', 10, 3, 0)), 'me', 1, { now: 0, moving: {}, pointer: { x, y } })
    const [cx, cy] = crosshairFb(fb, x, y)
    expect(pixelAt(fb, cx, cy)).toEqual([255, 255, 255]) // center: at 255, clamped
    expect(pixelAt(fb, cx - 1, cy)).toEqual([170, 170, 170]) // arm not washed to white
  })

  it('RENDER_HALF_FOV stays within core AIM_OFFSET_MAX so the aim can always reach the crosshair', () => {
    expect(RENDER_HALF_FOV).toBeLessThanOrEqual(AIM_OFFSET_MAX)
  })
})
