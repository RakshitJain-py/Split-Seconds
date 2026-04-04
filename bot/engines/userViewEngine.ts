import { SupabaseClient } from '@supabase/supabase-js'
import { computeGroupBalances } from './balanceEngine'
import { computeMinimalSettlements } from './settlementEngine'

type UserView = {
  user_id: number
  net_balance: number
  owes_to: { user_id: number; amount: number }[]
  owed_by: { user_id: number; amount: number }[]
}

export async function computeUserView(
  db: SupabaseClient,
  group_id: string,
  user_id: number
): Promise<UserView> {
  const balances = await computeGroupBalances(db, group_id)
  const settlements = computeMinimalSettlements(balances)

  const owes_to: { user_id: number; amount: number }[] = []
  const owed_by: { user_id: number; amount: number }[] = []

  for (const txn of settlements) {
    if (txn.from === user_id) owes_to.push({ user_id: txn.to, amount: txn.amount })
    if (txn.to === user_id) owed_by.push({ user_id: txn.from, amount: txn.amount })
  }

  return {
    user_id,
    net_balance: balances.get(user_id) || 0,
    owes_to,
    owed_by
  }
}
