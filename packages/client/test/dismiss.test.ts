import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { waitForPress } from '../src/input/dismiss.js'
import { KeyParser } from '../src/input/parser.js'

// M1 root cause: the final scoreboard's "press any key" waited on RAW stdin
// data, but the terminal is still in any-motion mouse tracking (?1003h) +
// focus reporting (?1004h) + kitty keyboard mode at that point — so mouse
// motion, focus changes, and the release of a key held when the match ended
// all dismissed the scoreboard instantly. waitForPress parses stdin through
// the session's KeyParser and resolves ONLY on a real key press or a mouse
// BUTTON press.

function mkStdin(): EventEmitter & { off: EventEmitter['removeListener'] } {
  return new EventEmitter() as EventEmitter & { off: EventEmitter['removeListener'] }
}

async function settled(p: Promise<void>): Promise<boolean> {
  let done = false
  void p.then(() => { done = true })
  await new Promise((r) => setImmediate(r))
  return done
}

describe('waitForPress — M1 scoreboard dismissal', () => {
  it('does NOT resolve on mouse motion reports', async () => {
    const stdin = mkStdin()
    const p = waitForPress(stdin as unknown as NodeJS.ReadStream, new KeyParser())
    stdin.emit('data', Buffer.from('\x1b[<35;42;7M')) // any-motion, no button
    stdin.emit('data', Buffer.from('\x1b[<35;43;7M'))
    expect(await settled(p)).toBe(false)
  })

  it('does NOT resolve on focus-in/focus-out reports', async () => {
    const stdin = mkStdin()
    const p = waitForPress(stdin as unknown as NodeJS.ReadStream, new KeyParser())
    stdin.emit('data', Buffer.from('\x1b[O')) // focus-out
    stdin.emit('data', Buffer.from('\x1b[I')) // focus-in
    expect(await settled(p)).toBe(false)
  })

  it('does NOT resolve on a kitty key RELEASE (a key held when the match ended)', async () => {
    const stdin = mkStdin()
    const p = waitForPress(stdin as unknown as NodeJS.ReadStream, new KeyParser())
    stdin.emit('data', Buffer.from('\x1b[119;1:3u')) // release of held w
    expect(await settled(p)).toBe(false)
  })

  it('resolves on a plain key press', async () => {
    const stdin = mkStdin()
    const p = waitForPress(stdin as unknown as NodeJS.ReadStream, new KeyParser())
    stdin.emit('data', Buffer.from('a'))
    expect(await settled(p)).toBe(true)
  })

  it('resolves on a mouse BUTTON press (a click is deliberate)', async () => {
    const stdin = mkStdin()
    const p = waitForPress(stdin as unknown as NodeJS.ReadStream, new KeyParser())
    stdin.emit('data', Buffer.from('\x1b[<0;10;5M')) // left press
    expect(await settled(p)).toBe(true)
  })

  it('does NOT resolve on a mouse button release, then resolves on the next press', async () => {
    const stdin = mkStdin()
    const p = waitForPress(stdin as unknown as NodeJS.ReadStream, new KeyParser())
    stdin.emit('data', Buffer.from('\x1b[<0;10;5m')) // left RELEASE (match-end click residue)
    expect(await settled(p)).toBe(false)
    stdin.emit('data', Buffer.from(' '))
    expect(await settled(p)).toBe(true)
  })

  it('detaches its data listener after resolving', async () => {
    const stdin = mkStdin()
    const p = waitForPress(stdin as unknown as NodeJS.ReadStream, new KeyParser())
    stdin.emit('data', Buffer.from('a'))
    await p
    expect(stdin.listenerCount('data')).toBe(0)
  })

  it('is split-chunk safe: a motion report split across chunks never dismisses', async () => {
    const stdin = mkStdin()
    const p = waitForPress(stdin as unknown as NodeJS.ReadStream, new KeyParser())
    stdin.emit('data', Buffer.from('\x1b[<35;4'))
    stdin.emit('data', Buffer.from('2;7M'))
    expect(await settled(p)).toBe(false)
    stdin.emit('data', Buffer.from('\x1b[113;1u')) // kitty press of q
    expect(await settled(p)).toBe(true)
  })
})
