import { describe, expect, it } from 'vitest'
import type { KeyEvent } from 'termwait'
import { createQueue, drain, onKey, type QueueState } from '../src/input-queue.js'

const press = (key: string): KeyEvent => ({ key, kind: 'press' })
const repeat = (key: string): KeyEvent => ({ key, kind: 'repeat' })
const release = (key: string): KeyEvent => ({ key, kind: 'release' })

// blockwait input is an ORDERED EVENT QUEUE, not snake's one-shot dir latch:
// taps are discrete and order matters (left, left, rotCW ≠ rotCW, left, left).
// Every mapped press/repeat pushes its GameEvent; release is ignored; the
// queue is hard-capped at MAX_EVENTS_PER_TICK so a mash can't unbound it;
// drain hands the whole ordered batch to step() and resets to empty.

describe('createQueue', () => {
  it('starts empty', () => {
    expect(createQueue()).toEqual({ events: [] })
  })
})

describe('onKey — key map (each mapped key pushes its event)', () => {
  it('maps every movement/rotation key to its GameEvent', () => {
    expect(onKey(createQueue(), press('left')).events).toEqual(['left'])
    expect(onKey(createQueue(), press('a')).events).toEqual(['left'])
    expect(onKey(createQueue(), press('right')).events).toEqual(['right'])
    expect(onKey(createQueue(), press('d')).events).toEqual(['right'])
    expect(onKey(createQueue(), press('up')).events).toEqual(['rotCW'])
    expect(onKey(createQueue(), press('w')).events).toEqual(['rotCW'])
    expect(onKey(createQueue(), press('x')).events).toEqual(['rotCW'])
    expect(onKey(createQueue(), press('z')).events).toEqual(['rotCCW'])
    expect(onKey(createQueue(), press('down')).events).toEqual(['softDrop'])
    expect(onKey(createQueue(), press('s')).events).toEqual(['softDrop'])
    expect(onKey(createQueue(), press(' ')).events).toEqual(['hardDrop'])
    expect(onKey(createQueue(), press('c')).events).toEqual(['hold'])
  })

  it('is case-insensitive on letter keys', () => {
    expect(onKey(createQueue(), press('A')).events).toEqual(['left'])
    expect(onKey(createQueue(), press('W')).events).toEqual(['rotCW'])
    expect(onKey(createQueue(), press('C')).events).toEqual(['hold'])
  })

  it('preserves press order across successive keys', () => {
    let q = createQueue()
    q = onKey(q, press('left'))
    q = onKey(q, press('left'))
    q = onKey(q, press('up'))
    q = onKey(q, press(' '))
    expect(q.events).toEqual(['left', 'left', 'rotCW', 'hardDrop'])
  })

  it('a repeat pushes another event, same as a press (OS auto-repeat = DAS)', () => {
    let q = createQueue()
    q = onKey(q, press('left'))
    q = onKey(q, repeat('left'))
    q = onKey(q, repeat('left'))
    expect(q.events).toEqual(['left', 'left', 'left'])
  })

  it('ignores release events', () => {
    const q = onKey(createQueue(), press('left'))
    expect(onKey(q, release('left'))).toEqual(q)
    const idle = createQueue()
    expect(onKey(idle, release('a'))).toEqual(idle)
  })

  it('ignores unmapped keys', () => {
    expect(onKey(createQueue(), press('q'))).toEqual(createQueue())
    expect(onKey(createQueue(), press('enter'))).toEqual(createQueue())
  })

  it('hard-caps the queue at MAX_EVENTS_PER_TICK (8) — a mash cannot unbound it', () => {
    let q = createQueue()
    for (let i = 0; i < 20; i++) q = onKey(q, press('left'))
    expect(q.events.length).toBe(8)
    expect(q.events.every((e) => e === 'left')).toBe(true)
  })
})

describe('drain', () => {
  it('hands back the whole ordered batch and empties the queue', () => {
    let q: QueueState = createQueue()
    q = onKey(q, press('left'))
    q = onKey(q, press('up'))
    q = onKey(q, press(' '))
    const { events, next } = drain(q)
    expect(events).toEqual(['left', 'rotCW', 'hardDrop'])
    expect(next).toEqual({ events: [] })
  })

  it('a drained empty queue yields no events', () => {
    const { events, next } = drain(createQueue())
    expect(events).toEqual([])
    expect(next).toEqual({ events: [] })
  })
})
