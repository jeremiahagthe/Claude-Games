import { describe, expect, it } from 'vitest'
import { TerminalSession } from '../src/terminal.js'

function fakeStreams() {
  const written: string[] = []
  const stdin = { isTTY: true, setRawMode: (on: boolean) => { calls.push(`raw:${on}`) }, resume() {}, pause() {} } as unknown as NodeJS.ReadStream
  const calls: string[] = []
  const stdout = { write: (s: string) => { written.push(s); return true }, columns: 80, rows: 24 } as unknown as NodeJS.WriteStream
  return { stdin, stdout, written, calls }
}

describe('TerminalSession', () => {
  it('enter emits alt-screen + kitty push; restore pops in reverse and is idempotent', () => {
    const { stdin, stdout, written } = fakeStreams()
    const t = new TerminalSession(stdin, stdout)
    t.enter()
    const all = written.join('')
    expect(all).toContain('\x1b[?1049h')
    expect(all).toContain('\x1b[?25l')
    expect(all).toContain('\x1b[>2u')
    written.length = 0
    t.restore()
    t.restore() // second call must be a no-op
    const rest = written.join('')
    expect(rest).toContain('\x1b[<u')
    expect(rest).toContain('\x1b[?25h')
    expect(rest).toContain('\x1b[?1049l')
    expect(rest.indexOf('\x1b[<u')).toBeLessThan(rest.indexOf('\x1b[?1049l')) // pop kitty before leaving alt screen
    expect(rest.match(/\x1b\[\?1049l/g)).toHaveLength(1) // idempotent
  })
})
