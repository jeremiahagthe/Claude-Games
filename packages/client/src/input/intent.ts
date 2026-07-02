import { makeInput, type PlayerInput } from '@fragwait/core'
import type { KeyEvent } from './parser.js'

const TRACKED = new Set(['w', 'a', 's', 'd', ' ', 'up', 'down', 'left', 'right'])

export class IntentTracker {
  private held = new Map<string, number>() // key -> last seen at (ms)
  private tier1 = false

  constructor(private now: () => number, private decayMs = 200) {}

  enableTier1(): void {
    this.tier1 = true
    this.held.clear() // tier-2 entries have no reliable release; start clean
  }

  onKey(e: KeyEvent): void {
    if (!TRACKED.has(e.key)) return
    if (e.kind === 'release') {
      if (this.tier1) this.held.delete(e.key)
      return // tier 2: releases don't exist reliably; decay handles it
    }
    this.held.set(e.key, this.now())
  }

  private isHeld(key: string): boolean {
    const t = this.held.get(key)
    if (t === undefined) return false
    if (!this.tier1 && this.now() - t >= this.decayMs) {
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
