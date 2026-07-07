import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVER, parseArgs } from '../src/cliArgs.js'

describe('parseArgs --difficulty', () => {
  // Mirrors fragwait's cliArgs default: 'easy', matching the online backfill
  // bots — feel-gating found normal's 0.3-0.4 skills near-hard in practice.
  it('defaults to easy when not passed', () => {
    expect(parseArgs([]).difficulty).toBe('easy')
    expect(parseArgs(['--offline']).difficulty).toBe('easy')
  })
  it('accepts each valid difficulty value', () => {
    expect(parseArgs(['--difficulty', 'easy']).difficulty).toBe('easy')
    expect(parseArgs(['--difficulty', 'normal']).difficulty).toBe('normal')
    expect(parseArgs(['--difficulty', 'hard']).difficulty).toBe('hard')
  })
  it('follows the existing parseArgs convention: combines with other flags', () => {
    const opts = parseArgs(['--offline', '--difficulty', 'hard', '--name', 'jer', '--mute'])
    expect(opts).toEqual({ offline: true, name: 'jer', mute: true, difficulty: 'hard', server: DEFAULT_SERVER })
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
  it('name and server', () => {
    const opts = parseArgs(['--name', 'jer', '--server', 'wss://x'])
    expect(opts.name).toBe('jer')
    expect(opts.server).toBe('wss://x')
  })
  it('defaults server to the shared fragwait workers.dev host — chess routes live there too', () => {
    expect(parseArgs([]).server).toBe(DEFAULT_SERVER)
    expect(DEFAULT_SERVER).toBe('https://fragwait-server.agthe7.workers.dev')
  })
  it('mute flag', () => {
    expect(parseArgs(['--mute']).mute).toBe(true)
    expect(parseArgs([]).mute).toBe(false)
  })
})
