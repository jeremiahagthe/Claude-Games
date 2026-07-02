import { detectColorMode } from './caps.js'

export function doctorReport(env: Record<string, string | undefined>, stdoutIsTTY: boolean, cols: number, rows: number): string {
  const mode = detectColorMode(env)
  return [
    'fragwait doctor',
    `  tty:        ${stdoutIsTTY ? 'yes' : 'NO - fragwait needs an interactive terminal'}`,
    `  term:       ${env['TERM'] ?? '(unset)'} / ${env['TERM_PROGRAM'] ?? '(unknown program)'}`,
    `  color mode: ${mode}${mode === 'mono' ? ' - expect ASCII-art rendering' : ''}`,
    `  size:       ${cols}x${rows}${cols < 80 || rows < 20 ? ' - small; 100x28+ recommended' : ''}`,
    '  input:      kitty-protocol probe runs at game start; fallback is decay-timer keys',
    '              VS Code users: enable terminal.integrated.enableKittyKeyboardProtocol',
  ].join('\n')
}
