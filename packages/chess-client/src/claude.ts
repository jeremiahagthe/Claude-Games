// copied from packages/client/src/claude.ts (fragwait) — 2026-07-07
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_DIR = join(homedir(), '.fragwait')

export interface ClaudeListener {
  port: number
  onEvent(cb: (event: string) => void): void
  close(): Promise<void>
}

export async function startClaudeListener(dir = DEFAULT_DIR): Promise<ClaudeListener> {
  mkdirSync(dir, { recursive: true })
  const callbacks: Array<(event: string) => void> = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 4096) { req.destroy() }
    })
    req.on('end', () => {
      try {
        const { event } = JSON.parse(body) as { event?: string }
        if (event !== 'done' && event !== 'attention') throw new Error('bad event')
        res.writeHead(200).end('ok')
        for (const cb of callbacks) cb(event)
      } catch {
        res.writeHead(400).end('bad request')
      }
    })
    req.on('error', () => { try { res.writeHead(400).end() } catch { /* socket gone */ } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const metaPath = join(dir, 'client.json')
  writeFileSync(metaPath, JSON.stringify({ port, pid: process.pid }))
  return {
    port,
    onEvent: (cb) => callbacks.push(cb),
    close: async () => {
      try { if (existsSync(metaPath)) unlinkSync(metaPath) } catch { /* best effort */ }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// A busy-* marker older than this is treated as abandoned (crashed session, force-quit
// terminal, SIGKILL, plugin uninstalled mid-task) rather than "still busy". Without a bound,
// the newest-of-all-markers logic below means one leaked marker makes every future game show
// an ever-growing "Claude working Nh" forever, since only the owning session's own hooks
// (notify.sh) ever clean up its marker on a clean Stop/Notification.
const STALE_MS = 4 * 60 * 60 * 1000 // 4 hours

export function busyElapsedSeconds(dir = DEFAULT_DIR, now = Date.now()): number | null {
  let newest = 0
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('busy-')) continue
      const path = join(dir, f)
      const m = statSync(path).mtimeMs
      if (now - m > STALE_MS) {
        try { unlinkSync(path) } catch { /* best effort prune; another process may have raced us */ }
        continue
      }
      if (m > newest) newest = m
    }
  } catch {
    return null
  }
  return newest === 0 ? null : Math.max(0, (now - newest) / 1000)
}
