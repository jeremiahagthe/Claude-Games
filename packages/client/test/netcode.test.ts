import { describe, expect, it } from 'vitest'
import { makeInput, parseMap, stepPlayer } from 'fragwait-core'
import type { MatchState, PlayerState } from 'fragwait-core'
import { Interpolator } from '../src/net/interp.js'
import { Predictor } from '../src/net/predictor.js'

const MAP = parseMap('open', 'Open', [
  '####################',
  '#SSSSSSSS..........#',
  '#..................#',
  '#.........R........#',
  '#..................#',
  '####################',
].join('\n'))

function player(over: Partial<PlayerState> = {}): PlayerState {
  return { id: 'me', handle: 'me', bot: false, pos: { x: 5, y: 3 }, dir: 0, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0, ...over }
}

describe('Predictor', () => {
  it('replaying pending inputs on a server rebase converges exactly (determinism)', () => {
    const pred = new Predictor(player(), MAP)
    const serverSide = player()
    const inputs = Array.from({ length: 10 }, (_, i) => makeInput(i + 1, { forward: 1, turn: i % 2 ? 1 : 0 }))
    for (const i of inputs) pred.applyLocal(i)
    // server has only processed the first 5
    for (const i of inputs.slice(0, 5)) stepPlayer(serverSide, i, MAP)
    pred.onServerState(structuredClone(serverSide))
    // full 10-input sim is the expected client view
    const expected = player()
    for (const i of inputs) stepPlayer(expected, i, MAP)
    expect(pred.self.pos.x).toBeCloseTo(expected.pos.x, 10)
    expect(pred.self.pos.y).toBeCloseTo(expected.pos.y, 10)
    expect(pred.self.dir).toBeCloseTo(expected.dir, 10)
  })
  it('server correction overrides local drift', () => {
    const pred = new Predictor(player(), MAP)
    pred.applyLocal(makeInput(1, { forward: 1 }))
    const corrected = player({ pos: { x: 9, y: 3 }, lastInputSeq: 1 }) // server says: actually here
    pred.onServerState(corrected)
    expect(pred.self.pos.x).toBeCloseTo(9)
  })
  it('never inspects or rewrites input fields (aimOffset survives replay verbatim)', () => {
    const pred = new Predictor(player(), MAP)
    const withAim = makeInput(1, { forward: 1, aimOffset: 0.2 })
    pred.applyLocal(withAim)
    // rebase against a server state that hasn't processed input 1 yet
    pred.onServerState(player({ lastInputSeq: 0 }))
    // the input object itself must be untouched by the predictor
    expect(withAim.aimOffset).toBeCloseTo(0.2)
    expect(withAim.seq).toBe(1)
  })
  it('ignores a stale/out-of-order server state instead of rebasing onto it', () => {
    const pred = new Predictor(player(), MAP)
    const serverSide = player()
    const inputs = Array.from({ length: 10 }, (_, i) => makeInput(i + 1, { forward: 1, turn: i % 2 ? 1 : 0 }))
    for (const i of inputs) pred.applyLocal(i)
    // server acks the first 8 inputs
    for (const i of inputs.slice(0, 8)) stepPlayer(serverSide, i, MAP)
    pred.onServerState(structuredClone(serverSide))
    const afterFreshAck = structuredClone(pred.self)
    // a stale/duplicate delivery arrives late, reporting an older ack (seq 3)
    const staleServerSide = player()
    for (const i of inputs.slice(0, 3)) stepPlayer(staleServerSide, i, MAP)
    pred.onServerState(structuredClone(staleServerSide))
    // self must be completely unaffected by the stale delivery
    expect(pred.self).toEqual(afterFreshAck)
    // and must still match the full straight-line sim
    const expected = player()
    for (const i of inputs) stepPlayer(expected, i, MAP)
    expect(pred.self.pos.x).toBeCloseTo(expected.pos.x, 10)
    expect(pred.self.pos.y).toBeCloseTo(expected.pos.y, 10)
    expect(pred.self.dir).toBeCloseTo(expected.dir, 10)
  })
  it('pending-buffer overflow self-heals once the server ack catches up past the dropped range', () => {
    const pred = new Predictor(player(), MAP)
    const inputs = Array.from({ length: 100 }, (_, i) => makeInput(i + 1, { forward: 1, turn: i % 3 === 0 ? 1 : 0 }))
    // pending buffer caps at 64: applying 100 inputs drops the oldest 36 (seqs 1-36)
    for (const i of inputs) pred.applyLocal(i)
    // server has only acked seq 5 so far (far behind the dropped range) — the
    // rebase is missing inputs 6-36 that the client already discarded, so
    // divergence from the true full-history sim is expected and allowed here.
    const ackedTo5 = player()
    for (const i of inputs.slice(0, 5)) stepPlayer(ackedTo5, i, MAP)
    pred.onServerState(structuredClone(ackedTo5))
    const expected = player()
    for (const i of inputs) stepPlayer(expected, i, MAP)
    expect(Math.abs(pred.self.pos.x - expected.pos.x)).toBeGreaterThan(1e-6)
    // server eventually simulates all 100 inputs in order and acks seq 100 —
    // once the ack is past the dropped range, the pending buffer (which only
    // ever held already-un-acked inputs) rebases onto the exact server state
    // with nothing left to replay, converging exactly.
    const ackedTo100 = player()
    for (const i of inputs) stepPlayer(ackedTo100, i, MAP)
    pred.onServerState(structuredClone(ackedTo100))
    expect(pred.self.pos.x).toBeCloseTo(expected.pos.x, 10)
    expect(pred.self.pos.y).toBeCloseTo(expected.pos.y, 10)
    expect(pred.self.dir).toBeCloseTo(expected.dir, 10)
  })
})

describe('Interpolator', () => {
  function snap(tick: number, x: number): MatchState {
    return { tick, timeLeftTicks: 100, mapId: 'open', players: { other: player({ id: 'other', pos: { x, y: 3 } }) }, rail: { pos: MAP.railSpawn, present: true, respawnTimer: 0 }, kills: [] }
  }
  it('lerps between snapshots', () => {
    const interp = new Interpolator()
    interp.push(snap(1, 2), 0)
    interp.push(snap(2, 4), 100)
    const mid = interp.sample(50)!
    expect(mid.players['other']!.pos.x).toBeCloseTo(3)
  })
  it('clamps outside the buffer and handles joins', () => {
    const interp = new Interpolator()
    expect(interp.sample(0)).toBeNull()
    interp.push(snap(1, 2), 0)
    expect(interp.sample(-50)!.players['other']!.pos.x).toBeCloseTo(2)
    expect(interp.sample(500)!.players['other']!.pos.x).toBeCloseTo(2)
  })

  it('angle-lerps dir along the shortest path across the +/-PI seam', () => {
    const interp = new Interpolator()
    // Both angles sit near the wrap seam; the short way round is +1.0 rad
    // (through PI), the naive unwrapped lerp would instead go the long way
    // (-2*PI + 1.0 rad) and land near 0 at the midpoint instead of near PI.
    const older: MatchState = {
      tick: 1, timeLeftTicks: 100, mapId: 'open',
      players: { other: player({ id: 'other', pos: { x: 2, y: 3 }, dir: Math.PI - 0.5 }) },
      rail: { pos: MAP.railSpawn, present: true, respawnTimer: 0 }, kills: [],
    }
    const newer: MatchState = {
      tick: 2, timeLeftTicks: 100, mapId: 'open',
      players: { other: player({ id: 'other', pos: { x: 2, y: 3 }, dir: -(Math.PI - 0.5) }) },
      rail: { pos: MAP.railSpawn, present: true, respawnTimer: 0 }, kills: [],
    }
    interp.push(older, 0)
    interp.push(newer, 100)
    const mid = interp.sample(50)!
    expect(Math.abs(mid.players['other']!.dir)).toBeCloseTo(Math.PI, 5)
  })

  it('does not mutate stored snapshots across repeated samples', () => {
    const interp = new Interpolator()
    interp.push(snap(1, 2), 0)
    interp.push(snap(2, 4), 100)
    const first = interp.sample(50)!
    first.players['other']!.pos.x = 9999
    first.timeLeftTicks = -1
    const second = interp.sample(50)!
    expect(second.players['other']!.pos.x).toBeCloseTo(3)
    expect(second.timeLeftTicks).toBe(100)
  })

  it('takes discrete non-position fields from the newer snap, not lerped', () => {
    const interp = new Interpolator()
    const older: MatchState = {
      tick: 1, timeLeftTicks: 100, mapId: 'open',
      players: { other: player({ id: 'other', pos: { x: 2, y: 3 }, hp: 100, frags: 0, fireCooldown: 0, hasRail: false }) },
      rail: { pos: { x: 1, y: 1 }, present: true, respawnTimer: 0 }, kills: [],
    }
    const newer: MatchState = {
      tick: 2, timeLeftTicks: 90, mapId: 'open',
      players: { other: player({ id: 'other', pos: { x: 4, y: 3 }, hp: 40, frags: 3, fireCooldown: 5, hasRail: true }) },
      rail: { pos: { x: 1, y: 1 }, present: false, respawnTimer: 40 },
      kills: [{ tick: 2, killerId: 'other', victimId: 'me', weapon: 'rail' }],
    }
    interp.push(older, 0)
    interp.push(newer, 100)
    const mid = interp.sample(50)!
    // position keeps lerping...
    expect(mid.players['other']!.pos.x).toBeCloseTo(3)
    // ...but discrete fields snap to the newer state instead of blending
    expect(mid.players['other']!.hp).toBe(40)
    expect(mid.players['other']!.frags).toBe(3)
    expect(mid.players['other']!.fireCooldown).toBe(5)
    expect(mid.players['other']!.hasRail).toBe(true)
    expect(mid.timeLeftTicks).toBe(90)
    expect(mid.rail).toEqual(newer.rail)
    expect(mid.kills).toEqual(newer.kills)
  })

  it('players present in only one snap use that snap state verbatim (join/leave mid-buffer)', () => {
    const interp = new Interpolator()
    const older: MatchState = {
      tick: 1, timeLeftTicks: 100, mapId: 'open',
      players: {
        leaver: player({ id: 'leaver', pos: { x: 2, y: 3 } }),
        stayer: player({ id: 'stayer', pos: { x: 6, y: 6 } }),
      },
      rail: { pos: MAP.railSpawn, present: true, respawnTimer: 0 }, kills: [],
    }
    const newer: MatchState = {
      tick: 2, timeLeftTicks: 100, mapId: 'open',
      players: {
        stayer: player({ id: 'stayer', pos: { x: 8, y: 6 } }),
        joiner: player({ id: 'joiner', pos: { x: 10, y: 10 } }),
      },
      rail: { pos: MAP.railSpawn, present: true, respawnTimer: 0 }, kills: [],
    }
    interp.push(older, 0)
    interp.push(newer, 100)
    const mid = interp.sample(50)!
    // joiner (only in newer snap): newer state verbatim, no lerp partner
    expect(mid.players['joiner']!.pos.x).toBeCloseTo(10)
    // leaver (only in older snap, gone by the newer one): older state verbatim
    expect(mid.players['leaver']).toBeDefined()
    expect(mid.players['leaver']!.pos.x).toBeCloseTo(2)
    // stayer (present in both): normally lerped
    expect(mid.players['stayer']!.pos.x).toBeCloseTo(7)
  })
})
