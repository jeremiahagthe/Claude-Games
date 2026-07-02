import { describe, expect, it } from 'vitest'
import { parseMap } from '@fragwait/core'
import type { MatchState, PlayerState } from '@fragwait/core'
import { FrameBuffer } from '../src/framebuffer.js'
import { backgroundColorAt, renderView } from '../src/raycast.js'

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

describe('crosshair', () => {
  it('renders a minimal plus: white center, dim gray arms at +-1, nothing at +-2', () => {
    const fb = new FrameBuffer(80, 48)
    renderView(fb, BOX, mkState(player('me', 10, 3, 0)), 'me')
    const ccx = fb.w >> 1
    const ccy = fb.h >> 1
    expect(pixelAt(fb, ccx, ccy)).toEqual([255, 255, 255])
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      expect(pixelAt(fb, ccx + dx, ccy + dy)).toEqual([170, 170, 170])
    }
    // the old +-2 arms are gone (shrunk from a 5x5 to a 3x3 footprint) —
    // nothing at +-2 was touched by the crosshair, so it's not pure white
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) {
      expect(pixelAt(fb, ccx + dx, ccy + dy)).not.toEqual([255, 255, 255])
    }
  })

  it('muzzle flash brightens the center but leaves the dim arms untouched (not washed to white)', () => {
    const fb = new FrameBuffer(80, 48)
    renderView(fb, BOX, mkState(player('me', 10, 3, 0)), 'me', 1) // flash=1, the peak value right after firing
    const ccx = fb.w >> 1
    const ccy = fb.h >> 1
    expect(pixelAt(fb, ccx, ccy)).toEqual([255, 255, 255]) // center: already at 255, clamped
    // arms: only the center point is passed to applyMuzzleFlash, so the dim
    // arms stay at 170 rather than brightening to 170+flash*80=250 — which
    // would sit above the 256-color quantization boundary (r > 248) and
    // collapse to the same terminal color code as pure white, erasing the
    // plus shape at exactly the moment (firing) it matters most.
    expect(pixelAt(fb, ccx - 1, ccy)).toEqual([170, 170, 170])
  })
})
