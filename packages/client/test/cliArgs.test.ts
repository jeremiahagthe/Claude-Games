import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/cliArgs.js'

describe('parseArgs --difficulty', () => {
  it('defaults to normal when not passed', () => {
    expect(parseArgs([]).difficulty).toBe('normal')
    expect(parseArgs(['--offline']).difficulty).toBe('normal')
  })
  it('accepts each valid difficulty value', () => {
    expect(parseArgs(['--difficulty', 'easy']).difficulty).toBe('easy')
    expect(parseArgs(['--difficulty', 'normal']).difficulty).toBe('normal')
    expect(parseArgs(['--difficulty', 'hard']).difficulty).toBe('hard')
  })
  it('follows the existing parseArgs convention: combines with other flags', () => {
    const opts = parseArgs(['--offline', '--difficulty', 'hard', '--name', 'jer', '--mute'])
    expect(opts).toEqual({ mode: 'play', offline: true, name: 'jer', mute: true, difficulty: 'hard' })
  })
  it('throws on an invalid difficulty value (fail-fast, matching the codebase-wide plain-Error convention)', () => {
    expect(() => parseArgs(['--difficulty', 'nightmare'])).toThrow(/invalid --difficulty/)
    expect(() => parseArgs(['--difficulty', 'nightmare'])).toThrow(/easy\|normal\|hard/)
  })
  it('throws when --difficulty is the last arg with no value', () => {
    expect(() => parseArgs(['--difficulty'])).toThrow(/invalid --difficulty/)
  })
})

describe('parseArgs (existing behavior, unaffected)', () => {
  it('doctor mode', () => {
    expect(parseArgs(['doctor']).mode).toBe('doctor')
  })
  it('name and server', () => {
    const opts = parseArgs(['--name', 'jer', '--server', 'wss://x'])
    expect(opts.name).toBe('jer')
    expect(opts.server).toBe('wss://x')
  })
})
