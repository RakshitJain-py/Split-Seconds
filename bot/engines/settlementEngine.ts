import { BalanceMap, Transaction } from '../types'
import { logEngine } from '../debug/logger'

export function computeMinimalSettlements(balanceMap: BalanceMap): Transaction[] {
  const creditors: [number, number][] = []
  const debtors: [number, number][] = []

  for (const [userId, balance] of balanceMap) {
    if (balance > 0.01) creditors.push([userId, balance])
    else if (balance < -0.01) debtors.push([userId, balance])
  }

  creditors.sort((a, b) => b[1] - a[1])
  debtors.sort((a, b) => a[1] - b[1])
  logEngine('balance_map', Object.fromEntries(balanceMap))

  const transactions: Transaction[] = []
  let i = 0, j = 0

  while (i < creditors.length && j < debtors.length) {
    const credit = creditors[i][1]
    const debt = -debtors[j][1]
    const amount = Math.min(credit, debt)
    transactions.push({
      from: debtors[j][0],
      to: creditors[i][0],
      amount: Math.round(amount * 100) / 100
    })
    creditors[i][1] -= amount
    debtors[j][1] += amount
    if (creditors[i][1] < 0.01) i++
    if (debtors[j][1] > -0.01) j++
  }

  logEngine('settlement_transactions', transactions)
  return transactions
}
