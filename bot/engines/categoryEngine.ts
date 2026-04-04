import { SupabaseClient } from '@supabase/supabase-js'
import { DBExpense } from '../types'

type CategoryStats = {
  tag: string
  total: number
  count: number
  payers: { user_id: number; amount: number }[]
}

export async function computeCategoryStats(
  db: SupabaseClient,
  group_id: string,
  tag: string,
  time_range?: { start: string; end: string }
): Promise<CategoryStats> {
  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', group_id)
    .is('settlement_id', null)
    .contains('tags', [tag])

  if (time_range) {
    query = query.gte('expense_timestamp', time_range.start).lte('expense_timestamp', time_range.end)
  }

  const { data: expenses } = await query

  if (!expenses || expenses.length === 0) {
    return { tag, total: 0, count: 0, payers: [] }
  }

  const payerMap: Map<number, number> = new Map()
  let total = 0

  for (const exp of expenses as DBExpense[]) {
    total += exp.amount
    payerMap.set(exp.payer_telegram_user_id, (payerMap.get(exp.payer_telegram_user_id) || 0) + exp.amount)
  }

  const payers = Array.from(payerMap.entries()).map(([user_id, amount]) => ({ user_id, amount }))
  return { tag, total, count: expenses.length, payers }
}
