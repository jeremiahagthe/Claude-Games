import { makeInput, type PlayerInput } from '@fragwait/core'
import type { KeyEvent } from './parser.js'

const TRACKED = new Set(['w', 'a', 's', 'd', ' ', 'up', 'down', 'left', 'right'])

// Adaptive decay bounds (ms). A key's decay window tracks its own observed
// press/repeat cadence instead of a single fixed timeout: fast OS key-repeat
// (e.g. macOS steady-state ~16-40ms) shrinks the window toward MIN_DECAY_MS
// for snappy release detection, while a slow/absent repeat cadence widens it
// toward MAX_DECAY_MS so the key doesn't go phantom-unheld between repeats.
const MIN_DECAY_MS = 120
const MAX_DECAY_MS = 600
const DECAY_SLOPE = 1.6
const DECAY_INTERCEPT_MS = 40

export class IntentTracker {
  private held = new Map<string, number>() // key -> last seen at (ms)
  private lastInterval = new Map<string, number>() // key -> last observed press/repeat interval (ms)
  private tier1 = false

  // decayMs is the INITIAL decay window used before any interval has been
  // observed for a key (bridges macOS's initial repeat delay, ~250-500ms).
  constructor(private now: () => number, private decayMs = 450) {}

  enableTier1(): void {
    this.tier1 = true
    this.held.clear() // tier-2 entries have no reliable release; start clean
    this.lastInterval.clear()
  }

  onKey(e: KeyEvent): void {
    if (!TRACKED.has(e.key)) return
    if (e.kind === 'release') {
      if (this.tier1) this.held.delete(e.key)
      return // tier 2: releases don't exist reliably; decay handles it
    }
    const t = this.now()
    const prev = this.held.get(e.key)
    if (prev !== undefined) this.lastInterval.set(e.key, t - prev)
    this.held.set(e.key, t)
  }

  private decayFor(key: string): number {
    const interval = this.lastInterval.get(key)
    if (interval === undefined) return this.decayMs
    return Math.min(MAX_DECAY_MS, Math.max(MIN_DECAY_MS, interval * DECAY_SLOPE + DECAY_INTERCEPT_MS))
  }

  private isHeld(key: string): boolean {
    const t = this.held.get(key)
    if (t === undefined) return false
    if (!this.tier1 && this.now() - t >= this.decayFor(key)) {
      this.held.delete(key)
      return false
    }
    return true
  }

  sample(seq: number): PlayerInput {
    const axis = (pos: string[], neg: string[]): -1 | 0 | 1 => {
      const p = pos.some((k) => this.isHeld(k))
      const n = neg.some((k) => this.isHeld(k))
      return p === n ? 0 : p ? 1 : -1
    }
    return makeInput(seq, {
      forward: axis(['w', 'up'], ['s', 'down']),
      strafe: axis(['d'], ['a']),
      turn: axis(['right'], ['left']),
      fire: this.isHeld(' '),
    })
  }
}
