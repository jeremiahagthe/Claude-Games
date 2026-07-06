import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS } from 'fragwait-core'
import { LobbyRegistry } from '../src/lobby-logic.js'

describe('LobbyRegistry', () => {
  it('returns null when empty, fills hottest open match first', () => {
    const reg = new LobbyRegistry()
    expect(reg.pick(0)).toBeNull()
    reg.register('m1', 0)
    reg.register('m2', 0)
    reg.assign('m2') // m2 now hotter (2 vs 1)
    expect(reg.pick(1000)).toBe('m2')
  })
  it('skips full matches', () => {
    const reg = new LobbyRegistry()
    reg.register('m1', 0)
    for (let i = 1; i < MAX_PLAYERS; i++) reg.assign('m1')
    expect(reg.pick(1000)).toBeNull()
  })
  it('skips expired matches and excluded ids', () => {
    const reg = new LobbyRegistry()
    reg.register('m1', 0)
    expect(reg.pick(0, 'm1')).toBeNull() // excluded
    expect(reg.pick(4 * 60_000)).toBeNull() // expired (3min match + 30s grace)
  })
})
