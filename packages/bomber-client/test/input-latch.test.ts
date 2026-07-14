import { describe, expect, it } from 'vitest'
import type { KeyEvent } from 'termwait'
import { createLatch, drain, onKey, type LatchState } from '../src/input-latch.js'

const press = (key: string): KeyEvent => ({ key, kind: 'press' })
const repeat = (key: string): KeyEvent => ({ key, kind: 'repeat' })
const release = (key: string): KeyEvent => ({ key, kind: 'release' })

describe('createLatch', () => {
  it('starts with no direction and no queued bomb', () => {
    expect(createLatch()).toEqual({ dir: null, bombQueued: false })
  })
})

describe('onKey — direction pulse (tap-to-step)', () => {
  it('a dir press requests a step that way', () => {
    expect(onKey(createLatch(), press('w')).dir).toBe('up')
    expect(onKey(createLatch(), press('a')).dir).toBe('left')
    expect(onKey(createLatch(), press('s')).dir).toBe('down')
    expect(onKey(createLatch(), press('d')).dir).toBe('right')
    expect(onKey(createLatch(), press('up')).dir).toBe('up')
    expect(onKey(createLatch(), press('down')).dir).toBe('down')
    expect(onKey(createLatch(), press('left')).dir).toBe('left')
    expect(onKey(createLatch(), press('right')).dir).toBe('right')
  })

  it('a same-direction repeat re-requests the step (hold-to-run, not a no-op)', () => {
    const l1 = onKey(createLatch(), press('w'))
    const l2 = onKey(l1, repeat('w'))
    expect(l2.dir).toBe('up') // still requesting up; the sim rate-limits the run
  })

  it('the latest dir key wins — opposing or perpendicular both just switch', () => {
    // opposing: up then down → now requesting down (no stop-first dance)
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
})

describe('onKey — bomb queue', () => {
  it('space press queues exactly one bomb', () => {
    const l = onKey(createLatch(), press(' '))
    expect(l.bombQueued).toBe(true)
  })

  it('space repeat does not re-queue (only a real press queues a bomb)', () => {
    const l1 = onKey(createLatch(), press(' '))
    const { next } = drain(l1) // consumes the queued bomb
    expect(next.bombQueued).toBe(false)
    const l2 = onKey(next, repeat(' '))
    expect(l2.bombQueued).toBe(false)
  })

  it('space release is ignored', () => {
    const l = onKey(createLatch(), release(' '))
    expect(l.bombQueued).toBe(false)
  })

  it('queuing a bomb does not disturb a pending direction pulse', () => {
    const moving = onKey(createLatch(), press('d')) // right
    const withBomb = onKey(moving, press(' '))
    expect(withBomb.dir).toBe('right')
    expect(withBomb.bombQueued).toBe(true)
  })
})

describe('drain', () => {
  it('translates the latch into an Input', () => {
    const l: LatchState = { dir: 'up', bombQueued: true }
    const { input } = drain(l)
    expect(input).toEqual({ dir: 'up', bomb: true })
  })

  it('clears BOTH dir and bombQueued in the next state (both are one-shot pulses)', () => {
    const l: LatchState = { dir: 'left', bombQueued: true }
    const { next } = drain(l)
    expect(next).toEqual({ dir: null, bombQueued: false })
  })

  it('a tap sends its dir exactly once — the next drain reports no direction', () => {
    const tapped: LatchState = { dir: 'down', bombQueued: false }
    const first = drain(tapped)
    expect(first.input).toEqual({ dir: 'down', bomb: false })
    // no fresh key event arrived, so the pulse is spent
    const second = drain(first.next)
    expect(second.input).toEqual({ dir: null, bomb: false })
  })
})
