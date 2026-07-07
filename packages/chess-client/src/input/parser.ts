// copied from packages/client/src/input/parser.ts (fragwait) — 2026-07-07
export interface KeyEvent { key: string; kind: 'press' | 'repeat' | 'release' }

// SGR mouse report (only MouseEvent carries a `type` field, so the union
// discriminates on `'type' in e`). x/y are 1-based terminal cell coordinates.
export interface MouseEvent {
  type: 'mouse'
  x: number
  y: number
  button: 'left' | 'middle' | 'right' | 'none'
  action: 'press' | 'release' | 'motion'
}

export type InputEvent = KeyEvent | MouseEvent

const ARROWS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left' }
const CODES: Record<number, string> = { 32: ' ', 27: 'esc', 13: 'enter', 9: 'tab', 127: 'backspace' }
const EVENTS: Record<string, KeyEvent['kind']> = { '1': 'press', '2': 'repeat', '3': 'release' }
const MAX_BUF = 64

export class KeyParser {
  private buf = ''

  feed(chunk: Buffer | string): InputEvent[] {
    this.buf += chunk.toString('utf8')
    const out: InputEvent[] = []
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
      // Task 9 divergence from the fragwait original: case is PRESERVED here
      // (not lowercased) — chess SAN needs it (Nf3 vs a pawn's plain file
      // letter), unlike fragwait's case-insensitive WASD controls. Callers
      // that want case-insensitive comparison (quit's 'q', arrow-adjacent
      // single-letter shortcuts) must lowercase the key themselves.
      else if (ch >= ' ' && ch <= '~') out.push({ key: ch, kind: 'press' })
      // other control bytes: ignore
    }
    // cap only the unparseable remainder: a real partial sequence is <16 bytes,
    // so anything larger is stuck garbage — drop it entirely, never re-parse it
    if (this.buf.length > MAX_BUF) this.buf = ''
    return out
  }

  private decodeCsi(params: string, final: string): InputEvent | null {
    // SGR mouse: `CSI < b ; x ; y M` (press/motion) or `... m` (release).
    if (params.startsWith('<') && (final === 'M' || final === 'm')) {
      return decodeMouse(params.slice(1), final)
    }
    if (final === 'u') {
      if (params.startsWith('?')) return { key: 'kitty-ack', kind: 'press' }
      const [codePart, modPart] = params.split(';')
      const code = Number(codePart!.split(':')[0])
      const kind = EVENTS[modPart?.split(':')[1] ?? '1'] ?? 'press'
      const named = CODES[code]
      const key = named ?? (code >= 32 && code < 127 ? String.fromCodePoint(code).toLowerCase() : null)
      return key ? { key, kind } : null
    }
    // Focus reporting (DEC ?1004): `CSI I` = focus-in, `CSI O` = focus-out.
    // Modeled as press KeyEvents so offline can drive mouselock re-engage;
    // intent ignores them (not in TRACKED).
    if (final === 'I') return { key: 'focus-in', kind: 'press' }
    if (final === 'O') return { key: 'focus-out', kind: 'press' }
    if (final in ARROWS) {
      const kind = EVENTS[params.split(';')[1]?.split(':')[1] ?? '1'] ?? 'press'
      return { key: ARROWS[final]!, kind }
    }
    return null // unknown CSI swallowed
  }
}

// Decodes the body of an SGR mouse report (`params` is everything between the
// leading `<` and the final `M`/`m`, e.g. "0;10;20"). Returns null — emitting
// nothing — for wheel/trackpad-scroll reports and any malformed frame, never
// throwing and never leaking partial bytes (the caller already stripped the
// full CSI from the buffer via the 0x40-0x7e end-scan, which the `<`/`;`/digit
// params can never trip early).
function decodeMouse(params: string, final: string): MouseEvent | null {
  const parts = params.split(';')
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return null // malformed
  const b = Number(parts[0])
  const x = Number(parts[1])
  const y = Number(parts[2])
  if (b & 64) return null // wheel (64/65, ± motion bit): trackpad scroll must not become input
  const lowBits = b & 3
  const button = lowBits === 0 ? 'left' : lowBits === 1 ? 'middle' : lowBits === 2 ? 'right' : 'none'
  const action = b & 32 ? 'motion' : final === 'M' ? 'press' : 'release'
  return { type: 'mouse', x, y, button, action }
}
