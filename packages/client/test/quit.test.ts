import { describe, expect, it } from 'vitest'
import { QUIT_CONFIRM_MS, QuitConfirm } from '../src/input/quit.js'

// Feel-12 root cause (video-verified): Q / Esc / banner-Enter quit INSTANTLY
// with no confirmation — Q sits next to W, so a fat-fingered press mid-match
// (pointer hidden in mouselock, hands on WASD) killed the game with the match
// timer at 2:26 and no scoreboard. A quit press now only ARMS a confirm
// window; the quit happens on a second press inside that window.

describe('QuitConfirm — no more single-keystroke match loss', () => {
  it('first request arms but does not quit; second inside the window quits', () => {
    let t = 0
    const qc = new QuitConfirm(() => t)
    expect(qc.request()).toBe(false)
    t += 500
    expect(qc.request()).toBe(true)
  })

  it('a request after the window expires re-arms instead of quitting', () => {
    let t = 0
    const qc = new QuitConfirm(() => t)
    expect(qc.request()).toBe(false)
    t += QUIT_CONFIRM_MS + 1
    expect(qc.request()).toBe(false) // expired: this press re-arms
    t += 100
    expect(qc.request()).toBe(true)
  })

  it('armed reflects the live window (drives the HUD hint)', () => {
    let t = 0
    const qc = new QuitConfirm(() => t)
    expect(qc.armed).toBe(false)
    qc.request()
    expect(qc.armed).toBe(true)
    t += QUIT_CONFIRM_MS + 1
    expect(qc.armed).toBe(false)
  })

  it('a confirm at the exact window edge has expired (strict inside)', () => {
    let t = 0
    const qc = new QuitConfirm(() => t)
    qc.request()
    t += QUIT_CONFIRM_MS
    expect(qc.request()).toBe(false) // boundary re-arms, does not quit
  })
})
