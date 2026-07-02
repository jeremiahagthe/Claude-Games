import { describe, expect, it } from 'vitest'
import { doctorReport } from '../src/doctor.js'

const env = { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }

describe('doctorReport key-repeat section', () => {
  it('reports measured timings and the recommendation when the initial delay is slow (> 300ms)', () => {
    const out = doctorReport(env, true, 100, 30, { initialDelayMs: 500, repeatIntervalMs: 83 })
    expect(out).toContain('initial delay 500ms, interval 83ms')
    expect(out).toContain('Delay Until Repeat')
  })

  it('reports measured timings without the recommendation when the initial delay is fast', () => {
    const out = doctorReport(env, true, 100, 30, { initialDelayMs: 225, repeatIntervalMs: 30 })
    expect(out).toContain('initial delay 225ms, interval 30ms')
    expect(out).not.toContain('Delay Until Repeat')
  })

  it('omits the key-repeat line entirely when no measurement is provided (non-darwin)', () => {
    const out = doctorReport(env, true, 100, 30)
    expect(out).not.toContain('key repeat:')
  })
})
