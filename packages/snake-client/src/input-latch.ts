// input-latch.ts — ONE-SHOT dir pulse. Snake never stops: the sim
// (packages/snake-core/src/step.ts) owns pendingDir and the 180°-reverse
// rule, buffering a requested heading until the next legal step. This latch
// only needs to hand step() "did a dir key fire since the last drain" — a
// quiet tick drains {dir: null}, which step() reads as "nothing new, keep
// whatever's already pending" (there is no absent-input distinction to
// preserve here, unlike bomber's tap-to-step latch: snake has no bomb flag
// and no hold-to-run cooldown gate to interact with). Release events never
// touch the latch — legacy terminals often can't report them, and there is
// no held state to turn off.
import type { Dir, Input } from 'snakewait-core'
import type { KeyEvent } from 'termwait'

export interface LatchState {
  dir: Dir | null
}

export function createLatch(): LatchState {
  return { dir: null }
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

// press/repeat of a dir key sets the pulse — latest key wins if two arrive
// before the next drain (e.g. a fast w-then-d before the tick fires: only d
// survives). A repeat is treated identically to a press: holding a key just
// keeps re-asserting the same heading, which is harmless since the sim only
// consumes one pending dir per step regardless of how many times it's set.
export function onKey(l: LatchState, e: KeyEvent): LatchState {
  if (e.kind === 'release') return l
  const dir = DIR_KEYS[e.key.toLowerCase()]
  if (dir) return { dir }
  return l
}

// One-shot: drain hands this tick's pulse to the Input and clears it. A quiet
// tick (no dir key since the last drain) yields {dir: null}.
export function drain(l: LatchState): { input: Input; next: LatchState } {
  return {
    input: { dir: l.dir },
    next: { dir: null },
  }
}
