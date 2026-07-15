import { BOARD_W, PREVIEW, TOTAL_ROWS } from './constants.js'
import { mulberry32, randStep } from './prng.js'
import { KINDS, spawnPiece, type PieceKind } from './pieces.js'
import { gravityTicksAt, type MatchState, type PlayerState } from './state.js'

// Fisher-Yates shuffle of a fresh bag using randStep, threading rng state explicitly.
function shuffledBag(rng: number): { bag: PieceKind[]; next: number } {
  const bag = [...KINDS]
  let state = rng
  for (let i = bag.length - 1; i > 0; i--) {
    const { value, next } = randStep(state)
    state = next
    const j = Math.floor(value * (i + 1))
    const tmp = bag[i]!
    bag[i] = bag[j]!
    bag[j] = tmp
  }
  return { bag, next: state }
}

function fillQueue(queue: PieceKind[], rng: number): { queue: PieceKind[]; next: number } {
  let state = rng
  while (queue.length < PREVIEW + 1) {
    const { bag, next } = shuffledBag(state)
    state = next
    queue.push(...bag)
  }
  return { queue, next: state }
}

function createPlayer(id: number, name: string, bot: boolean, bagRng: number): PlayerState {
  const { queue, next } = fillQueue([], bagRng)
  const kind = queue.shift()!
  return {
    id, name, bot, alive: true,
    tick: 0,
    board: new Array<number>(TOTAL_ROWS * BOARD_W).fill(0),
    piece: spawnPiece(kind),
    queue,
    bagRng: next,
    hold: null,
    holdUsed: false,
    fallCooldown: gravityTicksAt(0),
    lockTicks: null,
    lockResets: 0,
    pendingGarbage: [],
    linesCleared: 0,
    linesSent: 0,
  }
}

export function createMatch(seed: number, names: string[], bots: boolean[]): MatchState {
  const gen = mulberry32(seed)
  const bagRngSeed = (gen() * 2 ** 32) >>> 0
  const garbageRng = (gen() * 2 ** 32) >>> 0

  const players: [PlayerState, PlayerState] = [
    createPlayer(0, names[0]!, bots[0]!, bagRngSeed),
    createPlayer(1, names[1]!, bots[1]!, bagRngSeed),
  ]

  return { players, garbageRng, result: null }
}
