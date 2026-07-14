// input-latch.ts — TAP-TO-STEP movement: one key event = one requested tile.
// Both dir and bomb are one-shot pulses drained each tick and cleared. The sim
// (packages/bomber-core/src/step.ts) buffers a pending dir through its per-tile
// cooldown and consumes it on the step, so a single tap moves exactly one tile
// and then stops. Holding a key makes the OS auto-repeat it — each repeat is
// another step request, which the sim spaces out to one tile per cooldown, so
// holding glides continuously (hold-to-run) while a quick tap steps once. This
// is why dir needs no same-direction no-op like fragwait's latch did: a repeat
// SHOULD re-request a step here, not be suppressed. Release events still do
// nothing (legacy terminals can't report them, and tap-to-step never needs a
// release — there is no held state to turn off).
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

// press/repeat of a dir key: request a step that way — latest key wins, and a
// same-direction repeat re-requests (that IS hold-to-run; the sim rate-limits
// it to one tile per cooldown). space is a one-shot bomb queue: only a real
// press queues one — a repeat (only distinguishable at all on kitty-capable
// terminals) must never re-queue, or holding space would spam bombs every tick
// the OS repeats it. Release events never touch the latch — tap-to-step has no
// held state to turn off, and legacy terminals often can't report releases.
export function onKey(l: LatchState, e: KeyEvent): LatchState {
  if (e.kind === 'release') return l

  const dir = DIR_KEYS[e.key.toLowerCase()]
  if (dir) {
    return { ...l, dir }
  }

  if (e.key === ' ') {
    if (e.kind === 'repeat') return l
    return { ...l, bombQueued: true }
  }

  return l
}

// Both dir and bombQueued are one-shot: drain hands this tick's pulse to the
// Input and clears both. A tap with no follow-up event therefore sends its dir
// exactly once (dir=null on subsequent ticks); the sim holds the pending step
// through its cooldown, so one tap still lands as one tile.
export function drain(l: LatchState): { input: Input; next: LatchState } {
  return {
    input: { dir: l.dir, bomb: l.bombQueued },
    next: { dir: null, bombQueued: false },
  }
}
