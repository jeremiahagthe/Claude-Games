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

describe('onKey — direction latch', () => {
  it('a dir press latches that direction', () => {
    expect(onKey(createLatch(), press('w')).dir).toBe('up')
    expect(onKey(createLatch(), press('a')).dir).toBe('left')
    expect(onKey(createLatch(), press('s')).dir).toBe('down')
    expect(onKey(createLatch(), press('d')).dir).toBe('right')
    expect(onKey(createLatch(), press('up')).dir).toBe('up')
    expect(onKey(createLatch(), press('down')).dir).toBe('down')
    expect(onKey(createLatch(), press('left')).dir).toBe('left')
    expect(onKey(createLatch(), press('right')).dir).toBe('right')
  })

  it('same-direction repeat is a no-op (OS auto-repeat safe)', () => {
    const l1 = onKey(createLatch(), press('w'))
    const l2 = onKey(l1, repeat('w'))
    expect(l2).toEqual(l1)
    expect(l2.dir).toBe('up')
  })

  it('same-direction press (indistinguishable-from-repeat legacy terminal) is also a no-op', () => {
    const l1 = onKey(createLatch(), press('w'))
    const l2 = onKey(l1, press('w'))
    expect(l2).toEqual(l1)
  })

  it('an opposing tap stops movement (stop-first)', () => {
    const moving = onKey(createLatch(), press('w')) // up
    const stopped = onKey(moving, press('s')) // down opposes up
    expect(stopped.dir).toBeNull()
  })

  it('a second opposing tap reverses direction', () => {
    let l = createLatch()
    l = onKey(l, press('w')) // up
    l = onKey(l, press('s')) // stop
    expect(l.dir).toBeNull()
    l = onKey(l, press('s')) // tap again: reverse into down
    expect(l.dir).toBe('down')
  })

  it('opposing repeat also stops (repeat and press treated identically for dir keys)', () => {
    const moving = onKey(createLatch(), press('right'))
    const stopped = onKey(moving, repeat('left'))
    expect(stopped.dir).toBeNull()
  })

  it('a perpendicular tap switches direction without stopping first', () => {
    const movingUp = onKey(createLatch(), press('w')) // up
    const movingLeft = onKey(movingUp, press('a')) // left is perpendicular to up
    expect(movingLeft.dir).toBe('left')
  })

  it('left/right and up/down are the only opposing pairs (left/up are perpendicular)', () => {
    const movingLeft = onKey(createLatch(), press('a'))
    const afterUp = onKey(movingLeft, press('w'))
    expect(afterUp.dir).toBe('up') // switch, not stop
  })

  it('release events are ignored — latch persists', () => {
    const moving = onKey(createLatch(), press('w'))
    const afterRelease = onKey(moving, release('w'))
    expect(afterRelease).toEqual(moving)
    expect(afterRelease.dir).toBe('up')

    const idle = createLatch()
    const stillIdle = onKey(idle, release('s'))
    expect(stillIdle).toEqual(idle)
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

  it('queuing a bomb does not disturb the current direction latch', () => {
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

  it('clears bombQueued but keeps dir in the next state', () => {
    const l: LatchState = { dir: 'left', bombQueued: true }
    const { next } = drain(l)
    expect(next).toEqual({ dir: 'left', bombQueued: false })
  })

  it('a no-bomb drain reports bomb:false and dir persists across repeated drains', () => {
    const l: LatchState = { dir: 'down', bombQueued: false }
    const first = drain(l)
    expect(first.input).toEqual({ dir: 'down', bomb: false })
    const second = drain(first.next)
    expect(second.input).toEqual({ dir: 'down', bomb: false })
    expect(second.next).toEqual({ dir: 'down', bombQueued: false })
  })
})
