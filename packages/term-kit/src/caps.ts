// extracted from packages/chess-client (originally packages/client) — 2026-07-12
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
