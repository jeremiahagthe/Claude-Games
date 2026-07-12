// input-latch.ts — fragwait feel lesson: movement is LATCHED, timing-free.
// See packages/client/src/input/intent.ts:14-20 — Apple Terminal can't
// distinguish a real key press from an OS auto-repeat, and it only
// auto-repeats one key at a time. Timing-based hold detection is unfixable
// there, so movement latches instead: a same-direction press or repeat is
// always a no-op, which means replaying an indistinguishable repeat can
// never toggle anything. bomber's grid movement is single-axis (one of
// up/down/left/right at a time, unlike fragwait's independent forward/strafe
// axes), so the whole model collapses to one nullable Dir plus a one-shot
// bomb flag.
import type { Dir, Input } from 'boomwait-core'
import type { KeyEvent } from 'termwait'

export interface LatchState {
  dir: Dir | null
  bombQueued: boolean
}

export function createLatch(): LatchState {
  return { dir: null, bombQueued: false }
}

const DIR_KEYS: Record<string, Dir> = {
  w: 'up',
  up: 'up',
  s: 'down',
  down: 'down',
  a: 'left',
  left: 'left',
  d: 'right',
  right: 'right',
}

const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

// press/repeat of a dir key: same dir → no-op (the auto-repeat safety net);
// perpendicular → switch straight over; opposing → stop-first (tap again
// while stopped to reverse). space is a one-shot bomb queue: only a real
// press queues one — a repeat (only distinguishable at all on kitty-capable
// terminals) must never re-queue, or holding space would spam bombs every
// tick the OS repeats it. Release events never touch the latch — that's the
// whole point: the latch IS the persisted state, so a key release (which
// legacy terminals often can't even report) has nothing to do.
export function onKey(l: LatchState, e: KeyEvent): LatchState {
  if (e.kind === 'release') return l

  const dir = DIR_KEYS[e.key.toLowerCase()]
  if (dir) {
    if (l.dir === dir) return l
    if (l.dir !== null && OPPOSITE[l.dir] === dir) return { ...l, dir: null }
    return { ...l, dir }
  }

  if (e.key === ' ') {
    if (e.kind === 'repeat') return l
    return { ...l, bombQueued: true }
  }

  return l
}

// bombQueued is one-shot: drain hands it to this tick's Input and clears it,
// while dir simply carries forward (holding a direction needs no new events).
export function drain(l: LatchState): { input: Input; next: LatchState } {
  return {
    input: { dir: l.dir, bomb: l.bombQueued },
    next: { dir: l.dir, bombQueued: false },
  }
}
