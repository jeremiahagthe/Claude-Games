import { describe, expect, it } from 'vitest'
import { initialState } from 'checkwait-core'
import type { ChessState } from 'checkwait-core'
import { INITIAL_SELECT_STATE, selectStep, type SelectState } from '../src/select.js'

describe('selectStep', () => {
  it('click own piece then click a legal target: produces the move', () => {
    const s = initialState()
    const r1 = selectStep(s, INITIAL_SELECT_STATE, { kind: 'click', square: 12 }, 'w') // e2 pawn
    expect(r1.move).toBeNull()
    expect(r1.sel.selected).toBe(12)

    const r2 = selectStep(s, r1.sel, { kind: 'click', square: 28 }, 'w') // e4
    expect(r2.move).toEqual({ from: 12, to: 28 })
    expect(r2.sel.selected).toBeNull()
  })

  it('clicking a legal target with only one candidate move does not set pendingPromotion', () => {
    const s = initialState()
    const r1 = selectStep(s, INITIAL_SELECT_STATE, { kind: 'click', square: 12 }, 'w')
    const r2 = selectStep(s, r1.sel, { kind: 'click', square: 20 }, 'w') // e3, single push
    expect(r2.move).toEqual({ from: 12, to: 20 })
    expect(r2.sel.pendingPromotion).toBeNull()
  })

  it('clicking elsewhere (not a legal target, not own piece) clears the selection', () => {
    const s = initialState()
    const r1 = selectStep(s, INITIAL_SELECT_STATE, { kind: 'click', square: 12 }, 'w') // e2
    const r2 = selectStep(s, r1.sel, { kind: 'click', square: 45 }, 'w') // f6, empty & not a legal target
    expect(r2.move).toBeNull()
    expect(r2.sel.selected).toBeNull()
  })

  it('clicking a different own piece (not a legal target) reselects it instead of clearing', () => {
    const s = initialState()
    const r1 = selectStep(s, INITIAL_SELECT_STATE, { kind: 'click', square: 12 }, 'w') // e2
    expect(r1.sel.selected).toBe(12)
    const r2 = selectStep(s, r1.sel, { kind: 'click', square: 11 }, 'w') // d2, own piece, not a legal target of e2
    expect(r2.move).toBeNull()
    expect(r2.sel.selected).toBe(11)
  })

  it('promotion via picker: clicking a promotion-rank target sets pendingPromotion, and a promo event resolves it', () => {
    // White pawn on e7 (52), empty e8 (60): only pawn push available, 4 promotion candidates.
    const board = initialState().board.slice()
    board[52] = { type: 'p', color: 'w' }
    board[12] = null // clear the original e2 pawn so there's exactly one white pawn move set here
    board[60] = null
    const s: ChessState = { ...initialState(), board, turn: 'w' }

    const r1 = selectStep(s, INITIAL_SELECT_STATE, { kind: 'click', square: 52 }, 'w')
    expect(r1.sel.selected).toBe(52)

    const r2 = selectStep(s, r1.sel, { kind: 'click', square: 60 }, 'w')
    expect(r2.move).toBeNull()
    expect(r2.sel.pendingPromotion).toEqual({ from: 52, to: 60 })
    expect(r2.sel.selected).toBeNull()

    const r3 = selectStep(s, r2.sel, { kind: 'promo', piece: 'q' }, 'w')
    expect(r3.move).toEqual({ from: 52, to: 60, promotion: 'q' })
    expect(r3.sel.pendingPromotion).toBeNull()
  })

  it("typed 'Nf3' when legal (white to move) parses and emits the move", () => {
    const s = initialState()
    const r = selectStep(s, INITIAL_SELECT_STATE, { kind: 'typed', text: 'Nf3' }, 'w')
    expect(r.move).toEqual({ from: 6, to: 21 }) // g1 -> f3
  })

  it("typed input is rejected when it's the opponent's turn", () => {
    const s: ChessState = { ...initialState(), turn: 'b' }
    const r = selectStep(s, INITIAL_SELECT_STATE, { kind: 'typed', text: 'Nf3' }, 'w')
    expect(r.move).toBeNull()
  })

  it('typed input that names no legal move returns null (never throws)', () => {
    const s = initialState()
    const r = selectStep(s, INITIAL_SELECT_STATE, { kind: 'typed', text: 'Qh5' }, 'w')
    expect(r.move).toBeNull()
  })

  it('cursor + enter path: cursor moves onto own piece, enter selects; cursor moves to target, enter moves', () => {
    let sel: SelectState = { ...INITIAL_SELECT_STATE, cursor: 12 } // start cursor on e2
    const s = initialState()

    const r1 = selectStep(s, sel, { kind: 'enter' }, 'w')
    expect(r1.move).toBeNull()
    expect(r1.sel.selected).toBe(12)
    sel = r1.sel

    const r2 = selectStep(s, sel, { kind: 'cursor', dir: 'up' }, 'w') // e2 -> e3
    sel = r2.sel
    expect(sel.cursor).toBe(20)
    const r3 = selectStep(s, sel, { kind: 'cursor', dir: 'up' }, 'w') // e3 -> e4
    sel = r3.sel
    expect(sel.cursor).toBe(28)

    const r4 = selectStep(s, sel, { kind: 'enter' }, 'w')
    expect(r4.move).toEqual({ from: 12, to: 28 })
    expect(r4.sel.selected).toBeNull()
  })
})
