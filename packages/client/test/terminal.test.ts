import { describe, expect, it } from 'vitest'
import { TerminalSession } from '../src/terminal.js'

function removeListenersAddedSince(event: string, before: readonly (() => void)[]): void {
  for (const fn of process.listeners(event)) {
    if (!before.includes(fn as () => void)) process.removeListener(event, fn as (...args: unknown[]) => void)
  }
}

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

  it('installExitGuards is idempotent — a second call does not stack duplicate process listeners', () => {
    const { stdin, stdout } = fakeStreams()
    const t = new TerminalSession(stdin, stdout)

    const sigintBefore = [...process.listeners('SIGINT')] as (() => void)[]
    const sigtermBefore = [...process.listeners('SIGTERM')] as (() => void)[]
    const exitBefore = [...process.listeners('exit')] as (() => void)[]
    const uncaughtBefore = [...process.listeners('uncaughtException')] as (() => void)[]

    try {
      t.installExitGuards(() => {})
      const sigintAfter1 = process.listenerCount('SIGINT')
      const sigtermAfter1 = process.listenerCount('SIGTERM')

      t.installExitGuards(() => {})
      const sigintAfter2 = process.listenerCount('SIGINT')
      const sigtermAfter2 = process.listenerCount('SIGTERM')

      expect(sigintAfter2).toBe(sigintAfter1)
      expect(sigtermAfter2).toBe(sigtermAfter1)
    } finally {
      removeListenersAddedSince('SIGINT', sigintBefore)
      removeListenersAddedSince('SIGTERM', sigtermBefore)
      removeListenersAddedSince('exit', exitBefore)
      removeListenersAddedSince('uncaughtException', uncaughtBefore)
    }
  })
})
