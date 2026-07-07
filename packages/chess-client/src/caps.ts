// copied from packages/client/src/caps.ts (fragwait) — 2026-07-07
export type ColorMode = 'truecolor' | '256' | 'mono'

export function detectColorMode(env: Record<string, string | undefined>): ColorMode {
  if (/truecolor|24bit/i.test(env['COLORTERM'] ?? '')) return 'truecolor'
  if (env['TERM_PROGRAM'] === 'Apple_Terminal') return '256' // Terminal.app has no truecolor
  const term = env['TERM'] ?? ''
  if (term === 'dumb' || term === '') return 'mono'
  return '256'
}

export function viewSize(cols: number, rows: number): { viewCols: number; viewRows: number } {
  return { viewCols: Math.max(40, cols), viewRows: Math.max(12, rows - 3) }
}

// checkwait divergence (feel chess-2): double-size piece rows use VT100 line
// attributes (DECDWL/DECDHL, ESC#3/#4). Only enabled on terminals known to
// implement them — iTerm2 and Apple Terminal. kitty and alacritty
// deliberately don't; tmux strips them; an unsupporting terminal would show
// the piece row twice at single size (broken board), so default off.
export function supportsDoubleSizePieces(env: Record<string, string | undefined>): boolean {
  const p = env['TERM_PROGRAM'] ?? ''
  return p === 'iTerm.app' || p === 'Apple_Terminal'
}
