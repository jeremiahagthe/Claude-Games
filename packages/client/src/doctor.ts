import { detectColorMode } from './caps.js'
import type { OsKeyTimings } from './input/os-timings.js'

// keyTimings: the measured macOS key-repeat values (pass undefined off-darwin,
// where no measurement exists — the line would otherwise report the factory
// fallback as if it had been measured).
export function doctorReport(
  env: Record<string, string | undefined>,
  stdoutIsTTY: boolean,
  cols: number,
  rows: number,
  keyTimings?: OsKeyTimings,
): string {
  const mode = detectColorMode(env)
  const timingLines = keyTimings
    ? [
        `  key repeat: initial delay ${keyTimings.initialDelayMs}ms, interval ${keyTimings.repeatIntervalMs}ms (defaults read -g InitialKeyRepeat / KeyRepeat)`,
        // Tier-2 turning waits out the initial delay before a held turn key
        // reaches full speed, so a slow delay is the single biggest feel lever.
        ...(keyTimings.initialDelayMs > 300
          ? ['              slow: System Settings → Keyboard → "Delay Until Repeat" fastest + "Key Repeat Rate" fastest makes turning far more responsive; kitty/WezTerm/Ghostty/iTerm2 are smoother still']
          : []),
      ]
    : []
  return [
    'fragwait doctor',
    `  tty:        ${stdoutIsTTY ? 'yes' : 'NO - fragwait needs an interactive terminal'}`,
    `  term:       ${env['TERM'] ?? '(unset)'} / ${env['TERM_PROGRAM'] ?? '(unknown program)'}`,
    `  color mode: ${mode}${mode === 'mono' ? ' - expect ASCII-art rendering' : ''}`,
    `  size:       ${cols}x${rows}${cols < 80 || rows < 20 ? ' - small; 100x28+ recommended' : ''}`,
    '  input:      kitty-protocol probe runs at game start; fallback is decay-timer keys',
    '              VS Code users: enable terminal.integrated.enableKittyKeyboardProtocol',
    ...timingLines,
    '  tip:        macOS users can reduce input latency further: defaults write -g InitialKeyRepeat -int 15; defaults write -g KeyRepeat -int 2  (logout required)',
    '  tip:        bigger window + smaller font = higher game resolution',
  ].join('\n')
}
