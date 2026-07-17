import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVER, parseArgs } from '../src/cliArgs.js'

// Verbatim shape of block/snakewait's parseArgs (offline/name/server/seed +
// unknown-flag usage error), MINUS --difficulty (tankwait's offline duel picks
// a fixed bot skill; there is no difficulty flag). DEFAULT_SERVER stays the
// shared fragwait workers.dev host, unchanged from block.

describe('parseArgs defaults', () => {
  it('defaults offline=false, server=DEFAULT_SERVER, no name/seed', () => {
    expect(parseArgs([])).toEqual({ offline: false, server: DEFAULT_SERVER })
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

describe('parseArgs combines flags and rejects unknown ones', () => {
  it('combines multiple flags', () => {
    const opts = parseArgs(['--offline', '--name', 'jer', '--seed', '42'])
    expect(opts).toEqual({ offline: true, name: 'jer', seed: 42, server: DEFAULT_SERVER })
  })
  it('throws a usage error on an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/)
    expect(() => parseArgs(['--bogus'])).toThrow(/usage: tankwait/)
  })
  it('rejects --difficulty (tankwait has no difficulty flag)', () => {
    expect(() => parseArgs(['--difficulty', 'hard'])).toThrow(/unknown flag/)
  })
})
