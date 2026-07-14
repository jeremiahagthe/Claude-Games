import { describe, expect, it } from 'vitest'
import type { KeyEvent } from 'termwait'
import { createLatch, drain, onKey, type LatchState } from '../src/input-latch.js'

const press = (key: string): KeyEvent => ({ key, kind: 'press' })
const repeat = (key: string): KeyEvent => ({ key, kind: 'repeat' })
const release = (key: string): KeyEvent => ({ key, kind: 'release' })

describe('createLatch', () => {
  it('starts with no queued direction', () => {
    expect(createLatch()).toEqual({ dir: null })
  })
})

describe('onKey — one-shot dir pulse (snake never stops; no reverse/hold logic here)', () => {
  it('a dir press sets the pulse, including arrow keys', () => {
    expect(onKey(createLatch(), press('w')).dir).toBe('up')
    expect(onKey(createLatch(), press('a')).dir).toBe('left')
    expect(onKey(createLatch(), press('s')).dir).toBe('down')
    expect(onKey(createLatch(), press('d')).dir).toBe('right')
    expect(onKey(createLatch(), press('up')).dir).toBe('up')
    expect(onKey(createLatch(), press('down')).dir).toBe('down')
    expect(onKey(createLatch(), press('left')).dir).toBe('left')
    expect(onKey(createLatch(), press('right')).dir).toBe('right')
  })

  it('a repeat sets the pulse the same as a press', () => {
    expect(onKey(createLatch(), repeat('w')).dir).toBe('up')
    const l1 = onKey(createLatch(), press('w'))
    const l2 = onKey(l1, repeat('w'))
    expect(l2.dir).toBe('up')
  })

  it('the latest dir key wins when two presses land before the next drain', () => {
    // opposing: up then down → now requesting down (the sim, not this latch,
    // owns whether a reverse is legal)
    expect(onKey(onKey(createLatch(), press('w')), press('s')).dir).toBe('down')
    // perpendicular: up then left → now requesting left
    expect(onKey(onKey(createLatch(), press('w')), press('a')).dir).toBe('left')
  })

  it('release events are ignored', () => {
    const requested = onKey(createLatch(), press('w'))
    const afterRelease = onKey(requested, release('w'))
    expect(afterRelease).toEqual(requested)

    const idle = createLatch()
    expect(onKey(idle, release('s'))).toEqual(idle)
  })

  it('a non-dir key is ignored', () => {
    expect(onKey(createLatch(), press('q'))).toEqual(createLatch())
  })
})

describe('drain', () => {
  it('translates the latch into an Input', () => {
    const l: LatchState = { dir: 'up' }
    const { input } = drain(l)
    expect(input).toEqual({ dir: 'up' })
  })

  it('clears dir in the next state (one-shot pulse)', () => {
    const l: LatchState = { dir: 'left' }
    const { next } = drain(l)
    expect(next).toEqual({ dir: null })
  })

  it('a tap sends its dir exactly once — the next drain reports no direction', () => {
    const tapped: LatchState = { dir: 'down' }
    const first = drain(tapped)
    expect(first.input).toEqual({ dir: 'down' })
    // no fresh key event arrived, so the pulse is spent — a quiet tick's
    // {dir: null} is NOT an absent-input distinction: the sim's pendingDir
    // persists across it (no client-side hold/stop logic here).
    const second = drain(first.next)
    expect(second.input).toEqual({ dir: null })
  })
})
