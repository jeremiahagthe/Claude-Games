import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { busyElapsedSeconds, startClaudeListener } from '../src/claude.js'

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
})
