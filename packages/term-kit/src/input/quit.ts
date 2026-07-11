// extracted from packages/chess-client (originally packages/client) — 2026-07-12
// Feel-12: quitting mid-match must never be a single keystroke. Q sits next to
// W and the pointer is hidden in mouselock, so a fat-fingered Q (or an Enter
// while the Claude banner armed it) instantly exited a live match with no
// scoreboard (video-verified at 2:26 remaining). A quit-intent press now only
// ARMS this confirm window — the HUD flashes "press again to quit" — and the
// quit happens on a second press strictly inside the window. Ctrl-C stays an
// instant escape hatch and never routes through here.
export const QUIT_CONFIRM_MS = 2000

export class QuitConfirm {
  private armedUntil = -Infinity

  constructor(private now: () => number) {}

  // A quit-intent key press. Returns true when this press CONFIRMS (a prior
  // press armed the window and this one landed inside it); otherwise (re)arms
  // the window and returns false.
  request(): boolean {
    const t = this.now()
    if (t < this.armedUntil) return true
    this.armedUntil = t + QUIT_CONFIRM_MS
    return false
  }

  // Live while the window is open — drives the HUD "press again to quit" hint.
  get armed(): boolean {
    return this.now() < this.armedUntil
  }
}
