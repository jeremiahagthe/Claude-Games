// input-queue.ts — ORDERED EVENT QUEUE (NOT snake's one-shot dir latch).
// blockwait taps are discrete and their order is load-bearing: `left, left,
// rotCW` places a piece differently than `rotCW, left, left`, so we cannot
// collapse to a single latched value — we push each mapped key onto a FIFO and
// hand the whole ordered batch to step() on drain. press AND repeat both push
// (OS key auto-repeat is how DAS / soft-drop rate is delivered — every repeat
// is another discrete move); release is ignored (legacy terminals often can't
// report it, and there is no held state to turn off). The queue is hard-capped
// at MAX_EVENTS_PER_TICK so a between-tick mash can never grow unbounded — the
// same cap step() applies, mirrored here so the buffer itself stays bounded.
import { MAX_EVENTS_PER_TICK, type GameEvent } from 'blockwait-core'
import type { KeyEvent } from 'termwait'

export interface QueueState {
  events: GameEvent[]
}

export function createQueue(): QueueState {
  return { events: [] }
}

// Key map. `up`/`w`/`x` all rotate CW (the common tetromino convention: up-arrow
// or w for the primary rotation, x as an alternate CW some players prefer); `z`
// rotates CCW. `space` (the literal ' ' the parser emits for the space bar) is
// hard drop. Everything else is a movement/soft-drop/hold binding.
const KEY_EVENTS: Record<string, GameEvent> = {
  left: 'left',
  a: 'left',
  right: 'right',
  d: 'right',
  up: 'rotCW',
  w: 'rotCW',
  x: 'rotCW',
  z: 'rotCCW',
  down: 'softDrop',
  s: 'softDrop',
  ' ': 'hardDrop',
  space: 'hardDrop',
  c: 'hold',
}

export function onKey(q: QueueState, e: KeyEvent): QueueState {
  if (e.kind === 'release') return q
  const ev = KEY_EVENTS[e.key.toLowerCase()]
  if (!ev) return q
  if (q.events.length >= MAX_EVENTS_PER_TICK) return q
  return { events: [...q.events, ev] }
}

// Hand this tick's ordered batch to step() and reset to empty.
export function drain(q: QueueState): { events: GameEvent[]; next: QueueState } {
  return { events: q.events, next: createQueue() }
}
