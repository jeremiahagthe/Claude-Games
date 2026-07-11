import { GRID_H, GRID_W } from './constants.js'
import type { BomberState, Dir, Input, PlayerState } from './state.js'
import { idx, stepTicks } from './state.js'

function targetTile(x: number, y: number, dir: Dir): { x: number; y: number } {
  switch (dir) {
    case 'up':
      return { x, y: y - 1 }
    case 'down':
      return { x, y: y + 1 }
    case 'left':
      return { x: x - 1, y }
    case 'right':
      return { x: x + 1, y }
  }
}

function isBlocked(state: BomberState, x: number, y: number): boolean {
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return true
  if (state.grid[idx(x, y)] !== 'empty') return true
  if (state.bombs.some((b) => b.x === x && b.y === y)) return true
  return false
}

// Movement phase: latched-direction grid stepping. Bombs/flames/shrink phases
// land in Tasks 4-5, appended below this one inside step().
function movementPhase(state: BomberState, inputs: (Input | null)[]): PlayerState[] {
  return state.players.map((p, i) => {
    const input = inputs[i] ?? null
    const dir: Dir | null = input === null ? p.dir : input.dir

    if (!p.alive) {
      return dir === p.dir ? p : { ...p, dir }
    }

    let cooldown = p.stepCooldown - 1
    let x = p.x
    let y = p.y

    if (dir !== null && cooldown <= 0) {
      const target = targetTile(x, y, dir)
      if (!isBlocked(state, target.x, target.y)) {
        x = target.x
        y = target.y
      }
      // Blocked or not, the retry cadence resets on an expired cooldown.
      cooldown = stepTicks(p.speed)
    }

    if (dir === p.dir && x === p.x && y === p.y && cooldown === p.stepCooldown) return p
    return { ...p, dir, x, y, stepCooldown: cooldown }
  })
}

export function step(state: BomberState, inputs: (Input | null)[]): BomberState {
  const players = movementPhase(state, inputs)

  // Bomb placement/fuse, flame spread, and shrink phases land here in Tasks 4-5.

  return { ...state, tick: state.tick + 1, players }
}
