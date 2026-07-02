import { describe, expect, it } from 'vitest'
import { parseMap } from '@fragwait/core'
import type { MatchState, PlayerState } from '@fragwait/core'
import { FrameBuffer } from '../src/framebuffer.js'
import { renderView } from '../src/raycast.js'

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
    if (!(r === 18 && g === 18 && b === 24) && !(r === 38 && g === 36 && b === 34)) count++
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
