export interface KeyEvent { key: string; kind: 'press' | 'repeat' | 'release' }

const ARROWS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left' }
const CODES: Record<number, string> = { 32: ' ', 27: 'esc', 13: 'enter', 9: 'tab', 127: 'backspace' }
const EVENTS: Record<string, KeyEvent['kind']> = { '1': 'press', '2': 'repeat', '3': 'release' }
const MAX_BUF = 64

export class KeyParser {
  private buf = ''

  feed(chunk: Buffer | string): KeyEvent[] {
    this.buf += chunk.toString('utf8')
    if (this.buf.length > MAX_BUF) this.buf = this.buf.slice(-8) // resync: keep only a plausible partial sequence tail
    const out: KeyEvent[] = []
    while (this.buf.length > 0) {
      const ch = this.buf[0]!
      if (ch === '\x1b') {
        if (this.buf.length === 1) break // wait for more bytes
        if (this.buf[1] !== '[') {
          out.push({ key: 'esc', kind: 'press' })
          this.buf = this.buf.slice(1)
          continue
        }
        // CSI: find final byte (0x40-0x7e) after params
        let end = -1
        for (let i = 2; i < this.buf.length; i++) {
          const c = this.buf.charCodeAt(i)
          if (c >= 0x40 && c <= 0x7e) { end = i; break }
        }
        if (end === -1) break // incomplete, wait
        const params = this.buf.slice(2, end)
        const final = this.buf[end]!
        this.buf = this.buf.slice(end + 1)
        const ev = this.decodeCsi(params, final)
        if (ev) out.push(ev)
        continue
      }
      this.buf = this.buf.slice(1)
      if (ch === '\x03') out.push({ key: 'ctrl-c', kind: 'press' })
      else if (ch === '\x0d') out.push({ key: 'enter', kind: 'press' })
      else if (ch === '\x09') out.push({ key: 'tab', kind: 'press' })
      else if (ch >= ' ' && ch <= '~') out.push({ key: ch.toLowerCase(), kind: 'press' })
      // other control bytes: ignore
    }
    return out
  }

  private decodeCsi(params: string, final: string): KeyEvent | null {
    if (final === 'u') {
      if (params.startsWith('?')) return { key: 'kitty-ack', kind: 'press' }
      const [codePart, modPart] = params.split(';')
      const code = Number(codePart!.split(':')[0])
      const kind = EVENTS[modPart?.split(':')[1] ?? '1'] ?? 'press'
      const named = CODES[code]
      const key = named ?? (code >= 32 && code < 127 ? String.fromCodePoint(code).toLowerCase() : null)
      return key ? { key, kind } : null
    }
    if (final in ARROWS) {
      const kind = EVENTS[params.split(';')[1]?.split(':')[1] ?? '1'] ?? 'press'
      return { key: ARROWS[final]!, kind }
    }
    return null // unknown CSI swallowed
  }
}
