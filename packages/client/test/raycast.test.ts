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

  it('feel-8: when the pointer is visible, NO plus is drawn at the pointer cell — the OS pointer is the only cursor', () => {
    const withPointer = new FrameBuffer(80, 48)
    const [x, y] = [20, 5]
    renderView(withPointer, BOX, mkState(player('me', 10, 3, 0)), 'me', 0, { now: 0, moving: {}, pointer: { x, y } })
    const [cx, cy] = crosshairFb(withPointer, x, y)
    expect([cx, cy]).toEqual([19, 9]) // x−1, (y−1)·2+1 — same aim cell as before

    // The rendered wall/floor pixel at the aim cell must survive untouched:
    // no white center, no gray arms overwriting it.
    expect(pixelAt(withPointer, cx, cy)).not.toEqual([255, 255, 255])
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      expect(pixelAt(withPointer, cx + dx, cy + dy)).not.toEqual([170, 170, 170])
    }
    // Root-cause check: the pixel matches a render of the identical scene with
    // no pointer at all (proving the plus was skipped, not just recolored).
    const noPointer = new FrameBuffer(80, 48)
    renderView(noPointer, BOX, mkState(player('me', 10, 3, 0)), 'me')
    expect(pixelAt(withPointer, cx, cy)).toEqual(pixelAt(noPointer, cx, cy))
  })

  it('feel-8: an off-view pointer still draws no plus, even at its clamped aim cell', () => {
    const withPointer = new FrameBuffer(80, 48)
    renderView(withPointer, BOX, mkState(player('me', 10, 3, 0)), 'me', 0, { now: 0, moving: {}, pointer: { x: 1000, y: 1000 } })
    const noPointer = new FrameBuffer(80, 48)
    renderView(noPointer, BOX, mkState(player('me', 10, 3, 0)), 'me')
    // clamped corner cell (far.w-2, far.h-2) matches the no-pointer render exactly
    expect(pixelAt(withPointer, withPointer.w - 2, withPointer.h - 2))
      .toEqual(pixelAt(noPointer, noPointer.w - 2, noPointer.h - 2))
  })

  it('feel-8: muzzle flash still blooms at the pointer aim cell even though no plus is drawn', () => {
    const noFlash = new FrameBuffer(80, 48)
    const flash = new FrameBuffer(80, 48)
    const [x, y] = [30, 6]
    renderView(noFlash, BOX, mkState(player('me', 10, 3, 0)), 'me', 0, { now: 0, moving: {}, pointer: { x, y } })
    renderView(flash, BOX, mkState(player('me', 10, 3, 0)), 'me', 1, { now: 0, moving: {}, pointer: { x, y } })
    const [cx, cy] = crosshairFb(flash, x, y)
    const [nr, ng, nb] = pixelAt(noFlash, cx, cy)
    const [fr, fg, fb2] = pixelAt(flash, cx, cy)
    // firing brightens the aim cell relative to the no-flash render
    expect(fr + fg + fb2).toBeGreaterThan(nr + ng + nb)
  })

  it('RENDER_HALF_FOV stays within core AIM_OFFSET_MAX so the aim can always reach the crosshair', () => {
    expect(RENDER_HALF_FOV).toBeLessThanOrEqual(AIM_OFFSET_MAX)
  })
})
