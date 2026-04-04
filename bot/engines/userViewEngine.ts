import { SupabaseClient } from '@supabase/supabase-js'
import { computeGroupBalances } from './balanceEngine'
import { computeMinimalSettlements } from './settlementEngine'
import { UserBalanceView } from '../types'

export async function computeUserView(
  db: SupabaseClient,
  groupId: string,
  userId: number
): Promise<UserBalanceView> {
  const balances = await computeGroupBalances(db, groupId)
  const settlements = computeMinimalSettlements(balances)

  const owes_to: { user_id: number; amount: number }[] = []
  const owed_by: { user_id: number; amount: number }[] = []

  for (const txn of settlements) {
    if (txn.from === userId) {
      owes_to.push({ user_id: txn.to, amount: txn.amount })
    }
    if (txn.to === userId) {
      owed_by.push({ user_id: txn.from, amount: txn.amount })
    }
  }

  return {
    user_id: userId,
    net_balance: balances.get(userId) || 0,
    owes_to,
    owed_by
  }
}
