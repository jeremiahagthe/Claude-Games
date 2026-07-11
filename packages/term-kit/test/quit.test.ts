import { describe, expect, it } from 'vitest'
import { QUIT_CONFIRM_MS, QuitConfirm } from '../src/input/quit.js'

// Real API (constructor takes a `now: () => number` clock; `request()`
// returns a boolean — true means CONFIRMED, false means (re)ARMED). The
// brief's pseudocode assumed a `press(ms): 'armed' | 'confirmed'` shape;
// the actual copied source uses this clock-injected boolean shape instead —
// pinned here rather than changed to fit the pseudocode.
describe('QuitConfirm', () => {
  it('first request arms (false), second request within window confirms (true)', () => {
    let now = 1000
    const qc = new QuitConfirm(() => now)
    expect(qc.request()).toBe(false)
    now = 1000 + QUIT_CONFIRM_MS - 1
    expect(qc.request()).toBe(true)
  })
  it('second request after the window re-arms (false) instead of confirming', () => {
    let now = 1000
    const qc = new QuitConfirm(() => now)
    qc.request()
    now = 1000 + QUIT_CONFIRM_MS + 1
    expect(qc.request()).toBe(false)
  })
  it('armed getter reflects whether the window is currently open', () => {
    let now = 1000
    const qc = new QuitConfirm(() => now)
    expect(qc.armed).toBe(false)
    qc.request()
    expect(qc.armed).toBe(true)
    now = 1000 + QUIT_CONFIRM_MS + 1
    expect(qc.armed).toBe(false)
  })
})
