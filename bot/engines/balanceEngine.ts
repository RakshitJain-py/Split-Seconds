import { SupabaseClient } from '@supabase/supabase-js'
import { BalanceMap, DBExpense } from '../types'
import { logEngine } from '../debug/logger'

export async function computeGroupBalances(
  db: SupabaseClient,
  group_id: string
): Promise<BalanceMap> {
  const { data: expenses } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', group_id)
    .is('settlement_id', null)

  const { data: members } = await db
    .from('members')
    .select('telegram_user_id')
    .eq('group_id', group_id)

  if (!expenses || !members) return new Map()

  const memberIds = members.map((m: { telegram_user_id: number }) => m.telegram_user_id)
  const balances: BalanceMap = new Map()

  for (const id of memberIds) {
    balances.set(id, 0)
  }

  for (const exp of expenses as DBExpense[]) {
    const participants = exp.participants || memberIds
    const share = exp.amount / participants.length
    balances.set(exp.payer_telegram_user_id, (balances.get(exp.payer_telegram_user_id) || 0) + exp.amount)
    for (const p of participants) {
      balances.set(p, (balances.get(p) || 0) - share)
    }
  }

  logEngine('group_balances', Object.fromEntries(balances))
  return balances
}
