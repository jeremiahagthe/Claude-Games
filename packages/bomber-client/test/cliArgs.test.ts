import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVER, parseArgs } from '../src/cliArgs.js'

// Mirrors packages/chess-client/test/cliArgs.test.ts, adapted for boomwait's
// flag set (checkwait has no --mute; fragwait's packages/client does).

describe('parseArgs --difficulty', () => {
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
  it('defaults server to the shared fragwait workers.dev host — bomber routes live there too', () => {
    expect(parseArgs([]).server).toBe(DEFAULT_SERVER)
    expect(DEFAULT_SERVER).toBe('https://fragwait-server.agthe7.workers.dev')
  })
  it('throws when --server is the last arg with no value, instead of assigning undefined', () => {
    expect(() => parseArgs(['--server'])).toThrow(/invalid --server/)
    expect(() => parseArgs(['--offline', '--server'])).toThrow(/invalid --server/)
  })
  it('--mute defaults to false, set true with the flag', () => {
    expect(parseArgs([]).mute).toBe(false)
    expect(parseArgs(['--mute']).mute).toBe(true)
  })
})
