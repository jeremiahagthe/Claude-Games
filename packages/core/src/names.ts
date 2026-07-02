import { fnv1a, mulberry32 } from './prng.js'

const ADJECTIVES = [
  'rebased', 'segfaulting', 'async', 'deprecated', 'polymorphic', 'memoized',
  'unhandled', 'refactored', 'greedy', 'lazy', 'volatile', 'immutable',
  'orphaned', 'shadowed', 'hoisted', 'leaky', 'recursive', 'blocking',
  'stale', 'flaky', 'minified', 'vendored', 'monkeypatched', 'idempotent',
] as const

const NOUNS = [
  'rustacean', 'sensei', 'linter', 'daemon', 'pointer', 'closure',
  'mutex', 'goroutine', 'lambda', 'kernel', 'compiler', 'debugger',
  'iterator', 'allocator', 'promise', 'thread', 'socket', 'buffer',
  'stacktrace', 'gopher', 'crab', 'wizard', 'intern', 'architect',
] as const

function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.floor(r * arr.length) % arr.length]!
}

export function handleFromSeed(seed: string): string {
  const rng = mulberry32(fnv1a(seed))
  return `${pick(ADJECTIVES, rng())}-${pick(NOUNS, rng())}`
}

export function randomHandle(rng: () => number): string {
  return `${pick(ADJECTIVES, rng())}-${pick(NOUNS, rng())}`
}
