import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVER, parseArgs } from '../src/cliArgs.js'

// Verbatim shape of snakewait's parseArgs (offline/name/server/seed/difficulty
// + unknown-flag usage error), adapted for blockwait's binary name in the
// usage string. DEFAULT_SERVER stays the shared fragwait workers.dev host.

describe('parseArgs defaults', () => {
  it('defaults offline=false, difficulty=easy, server=DEFAULT_SERVER, no name/seed', () => {
    expect(parseArgs([])).toEqual({ offline: false, difficulty: 'easy', server: DEFAULT_SERVER })
  })
  it('defaults to the shared fragwait workers.dev host', () => {
    expect(DEFAULT_SERVER).toBe('https://fragwait-server.agthe7.workers.dev')
  })
})

describe('parseArgs --offline', () => {
  it('sets offline true', () => {
    expect(parseArgs(['--offline']).offline).toBe(true)
  })
})

describe('parseArgs --name', () => {
  it('sets name', () => {
    expect(parseArgs(['--name', 'jer']).name).toBe('jer')
  })
  it('throws when --name is the last arg with no value', () => {
    expect(() => parseArgs(['--name'])).toThrow(/invalid --name/)
  })
})

describe('parseArgs --seed', () => {
  it('sets a numeric seed', () => {
    expect(parseArgs(['--seed', '9']).seed).toBe(9)
  })
  it('throws when --seed is the last arg with no value', () => {
    expect(() => parseArgs(['--seed'])).toThrow(/invalid --seed/)
  })
  it('throws on a non-numeric seed', () => {
    expect(() => parseArgs(['--seed', 'nope'])).toThrow(/invalid --seed/)
  })
})

describe('parseArgs --server', () => {
  it('sets server', () => {
    expect(parseArgs(['--server', 'https://x']).server).toBe('https://x')
  })
  it('throws when --server is the last arg with no value', () => {
    expect(() => parseArgs(['--server'])).toThrow(/invalid --server/)
    expect(() => parseArgs(['--offline', '--server'])).toThrow(/invalid --server/)
  })
})

describe('parseArgs --difficulty', () => {
  it('accepts each valid difficulty value', () => {
    expect(parseArgs(['--difficulty', 'easy']).difficulty).toBe('easy')
    expect(parseArgs(['--difficulty', 'normal']).difficulty).toBe('normal')
    expect(parseArgs(['--difficulty', 'hard']).difficulty).toBe('hard')
  })
  it('throws on an invalid difficulty value', () => {
    expect(() => parseArgs(['--difficulty', 'nightmare'])).toThrow(/invalid --difficulty/)
    expect(() => parseArgs(['--difficulty', 'nightmare'])).toThrow(/easy\|normal\|hard/)
  })
  it('throws when --difficulty is the last arg with no value', () => {
    expect(() => parseArgs(['--difficulty'])).toThrow(/invalid --difficulty/)
  })
})

describe('parseArgs combines flags and rejects unknown ones', () => {
  it('combines multiple flags', () => {
    const opts = parseArgs(['--offline', '--difficulty', 'hard', '--name', 'jer', '--seed', '42'])
    expect(opts).toEqual({ offline: true, name: 'jer', difficulty: 'hard', seed: 42, server: DEFAULT_SERVER })
  })
  it('throws a usage error on an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/)
    expect(() => parseArgs(['--bogus'])).toThrow(/usage: blockwait/)
  })
})
