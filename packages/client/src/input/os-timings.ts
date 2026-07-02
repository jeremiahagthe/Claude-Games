import { execFileSync } from 'node:child_process'

// Measured key auto-repeat timings of the host OS. On macOS the first repeat
// arrives `initialDelayMs` after a press and subsequent repeats every
// `repeatIntervalMs` (F1). Tier-2 input inference (intent.ts) derives all of
// its hold/phase windows from these, so they are read once at client startup
// and injected into IntentTracker — never read inside the tracker itself,
// which keeps the tracker clock-injectable and fully testable.
export interface OsKeyTimings {
  initialDelayMs: number
  repeatIntervalMs: number
}

// macOS factory defaults (also the fallback whenever the real values are
// unset/unreadable, and on non-darwin platforms).
export const FACTORY_TIMINGS: OsKeyTimings = { initialDelayMs: 500, repeatIntervalMs: 83 }

// `defaults read -g InitialKeyRepeat` / `KeyRepeat` report in ticks of 15ms.
const DEFAULTS_TICK_MS = 15

// Clamps keep a corrupt/pathological defaults value from wedging the derived
// windows: System Settings' real range is initial 225–1800ms, interval
// 30–1800ms, so [150, 2000] / [15, 400] comfortably brackets sane values.
const INITIAL_DELAY_CLAMP_MS = { min: 150, max: 2000 }
const REPEAT_INTERVAL_CLAMP_MS = { min: 15, max: 400 }

// Pure parsing half, exported so tests never shell out: takes the raw stdout
// of each `defaults read` (or null when the read failed / key is unset) and
// produces clamped millisecond timings. Each field falls back to its factory
// value independently — the two defaults keys are independently unset-able.
export function parseKeyTimings(initialRaw: string | null, repeatRaw: string | null): OsKeyTimings {
  return {
    initialDelayMs: convert(initialRaw, INITIAL_DELAY_CLAMP_MS, FACTORY_TIMINGS.initialDelayMs),
    repeatIntervalMs: convert(repeatRaw, REPEAT_INTERVAL_CLAMP_MS, FACTORY_TIMINGS.repeatIntervalMs),
  }
}

function convert(raw: string | null, clamp: { min: number; max: number }, fallback: number): number {
  if (raw === null) return fallback
  const ticks = Number(raw.trim())
  if (!Number.isFinite(ticks) || ticks <= 0) return fallback
  return Math.min(clamp.max, Math.max(clamp.min, ticks * DEFAULTS_TICK_MS))
}

// Thin exec wrapper: any failure (key unset, `defaults` missing, timeout)
// reads as null and parseKeyTimings falls back to factory values.
function readGlobalDefault(key: string): string | null {
  try {
    return execFileSync('defaults', ['read', '-g', key], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

// Reads the host's key-repeat timings. Only darwin exposes them via
// `defaults`; every other platform gets the factory fallback.
export function readOsKeyTimings(platform: string = process.platform): OsKeyTimings {
  if (platform !== 'darwin') return { ...FACTORY_TIMINGS }
  return parseKeyTimings(readGlobalDefault('InitialKeyRepeat'), readGlobalDefault('KeyRepeat'))
}
