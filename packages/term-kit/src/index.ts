// termwait: shared terminal plumbing extracted from packages/chess-client
// (originally packages/client) for reuse across fragwait/checkwait/bomber.
export { TerminalSession } from './terminal.js'
export type { ColorMode } from './caps.js'
export { detectColorMode, viewSize } from './caps.js'
export type { ClaudeListener } from './claude.js'
export { DEFAULT_DIR, startClaudeListener, busyElapsedSeconds } from './claude.js'
export type { KeyEvent, MouseEvent, InputEvent } from './input/parser.js'
export { KeyParser } from './input/parser.js'
export { QUIT_CONFIRM_MS, QuitConfirm } from './input/quit.js'
export { waitForPress } from './input/dismiss.js'
