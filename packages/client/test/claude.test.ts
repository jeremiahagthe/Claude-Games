import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { busyElapsedSeconds, startClaudeListener } from '../src/claude.js'
import net from 'node:net'

describe('startClaudeListener', () => {
  it('writes client.json and delivers POSTed events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    const listener = await startClaudeListener(dir)
    const meta = JSON.parse(readFileSync(join(dir, 'client.json'), 'utf8'))
    expect(meta.port).toBe(listener.port)
    expect(meta.pid).toBe(process.pid)

    const got = new Promise<string>((resolve) => listener.onEvent(resolve))
    const res = await fetch(`http://127.0.0.1:${listener.port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'done' }),
    })
    expect(res.status).toBe(200)
    expect(await got).toBe('done')
    await listener.close()
  })
  it('rejects garbage without crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    const listener = await startClaudeListener(dir)
    const res = await fetch(`http://127.0.0.1:${listener.port}/event`, { method: 'POST', body: 'not json' })
    expect(res.status).toBe(400)
    await listener.close()
  })
  it('an aborted request does not crash the listener process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    const listener = await startClaudeListener(dir)
    // open a raw socket, send partial headers+body, then destroy mid-request
    await new Promise<void>((resolve) => {
      const sock = net.createConnection(listener.port, '127.0.0.1', () => {
        sock.write('POST /event HTTP/1.1\r\ncontent-length: 100\r\n\r\n{"ev')
        setTimeout(() => { sock.destroy(); resolve() }, 50)
      })
    })
    await new Promise((r) => setTimeout(r, 100))
    // listener still alive and serving
    const res = await fetch(`http://127.0.0.1:${listener.port}/event`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'done' }),
    })
    expect(res.status).toBe(200)
    await listener.close()
  })
})

describe('busyElapsedSeconds', () => {
  it('returns seconds since newest busy file, null when none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    expect(busyElapsedSeconds(dir)).toBeNull()
    const f = join(dir, 'busy-abc123')
    writeFileSync(f, '')
    const past = (Date.now() - 90_000) / 1000
    utimesSync(f, past, past)
    const s = busyElapsedSeconds(dir)
    expect(s).toBeGreaterThanOrEqual(89)
    expect(s).toBeLessThanOrEqual(95)
  })

  it('ignores and prunes a marker older than the staleness bound (crashed session)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    const f = join(dir, 'busy-crashed')
    writeFileSync(f, '')
    const fiveHoursAgo = (Date.now() - 5 * 60 * 60 * 1000) / 1000 // beyond the 4h staleness bound
    utimesSync(f, fiveHoursAgo, fiveHoursAgo)
    expect(busyElapsedSeconds(dir)).toBeNull()
    expect(existsSync(f)).toBe(false) // best-effort pruned in the same pass
  })

  it('reports the fresh marker and ignores a stale one when both are present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    const stale = join(dir, 'busy-crashed')
    writeFileSync(stale, '')
    const fiveHoursAgo = (Date.now() - 5 * 60 * 60 * 1000) / 1000
    utimesSync(stale, fiveHoursAgo, fiveHoursAgo)
    const fresh = join(dir, 'busy-active')
    writeFileSync(fresh, '')
    const ninetySecondsAgo = (Date.now() - 90_000) / 1000
    utimesSync(fresh, ninetySecondsAgo, ninetySecondsAgo)
    const s = busyElapsedSeconds(dir)
    expect(s).toBeGreaterThanOrEqual(89)
    expect(s).toBeLessThanOrEqual(95)
    expect(existsSync(stale)).toBe(false) // pruned even though a fresh marker also exists
  })
})
