// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Settlement Engine
// Greedy creditor-debtor matching. Pure function, no DB calls.
// ─────────────────────────────────────────────────────────────────────────────

import { Transaction } from '../types'

export function computeMinimalSettlements(
  balances: Map<number, number>
): Transaction[] {
  const creditors: { id: number; amount: number }[] = []
  const debtors: { id: number; amount: number }[] = []

  for (const [uid, bal] of balances) {
    if (bal > 0.01) creditors.push({ id: uid, amount: bal })
    else if (bal < -0.01) debtors.push({ id: uid, amount: Math.abs(bal) })
  }

  creditors.sort((a, b) => b.amount - a.amount)
  debtors.sort((a, b) => b.amount - a.amount)

  const transactions: Transaction[] = []
  let ci = 0, di = 0

  while (ci < creditors.length && di < debtors.length) {
    const credit = creditors[ci]
    const debt = debtors[di]
    const transfer = Math.min(credit.amount, debt.amount)

    transactions.push({
      from: debt.id,
      to: credit.id,
      amount: Math.round(transfer * 100) / 100
    })

    credit.amount -= transfer
    debt.amount -= transfer

    if (credit.amount < 0.01) ci++
    if (debt.amount < 0.01) di++
  }

  return transactions
}
