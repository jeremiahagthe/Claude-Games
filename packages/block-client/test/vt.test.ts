import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { VtSim } from './vtsim.js'

// THE POSITIONAL-ESCAPE GATE. Positional escapes (ESC[H / ESC[K / ESC[J and the
// col-80 pending-wrap boundary) were a FEEL-GATE-ONLY surface for two shipped
// defects, so this test spawns the REAL built binary headless, feeds its stdout
// through a VT simulator, and asserts the frames repaint in place and stay in
// bounds — the feel-gate surface, now a test.
//
// STALE-DIST RULE: this executes packages/block-client/bin/blockwait.js, which
// loads dist/. Build first: `npm run build -w blockwait-core && npm run build
// -w blockwait`. A stale dist tests stale code.

describe('positional-escape gate (the feel-gate-only surface, now a test)', () => {
  it('headless offline run produces homed, in-bounds 80x24 frames from the REAL binary', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'node',
        ['packages/block-client/bin/blockwait.js', '--offline', '--seed', '1'],
        { env: { ...process.env, COLUMNS: '80', LINES: '24', TERM: 'xterm-256color' }, timeout: 8000, killSignal: 'SIGTERM', maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => (stdout.length > 0 ? resolve(stdout) : reject(err)),
      )
      setTimeout(() => child.kill('SIGTERM'), 3000)
      child.stdin?.end()
    })

    const sim = new VtSim(80, 24)
    sim.feed(out)
    const frames = sim.frames()

    // ~60 frames land in the 3s window (20Hz redraw); >10 proves the renderer
    // repaints in place (ESC[H homes each frame) rather than scrolling. Kept
    // well below the observed count so timing jitter can't make it flaky.
    expect(frames.length).toBeGreaterThan(10)
    for (const frame of frames.slice(2)) {
      expect(frame.length).toBeLessThanOrEqual(24)
      for (const row of frame) expect(row.length).toBeLessThanOrEqual(80)
    }
    // Column-80 defect probe: the last visible column of a full-width row
    // survives with its 80th column intact (a trailing-ESC[K bug would erase it).
    const last = frames.at(-1)!
    expect(last.some((row) => row.trimEnd().length === 80)).toBe(true)
  })
})
