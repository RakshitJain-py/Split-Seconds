import { SupabaseClient } from '@supabase/supabase-js'
import { CategoryStats, DBExpense } from '../types'

export async function computeCategoryStats(
  db: SupabaseClient,
  groupId: string,
  tag: string,
  timeRange?: { from: string; to: string }
): Promise<CategoryStats> {
  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .contains('tags', [tag.toLowerCase()])

  if (timeRange) {
    query = query
      .gte('expense_timestamp', timeRange.from)
      .lte('expense_timestamp', timeRange.to)
  }

  const { data: expenses } = await query

  if (!expenses || expenses.length === 0) {
    return { tag, total: 0, count: 0, payers: [] }
  }

  const payerMap = new Map<number, number>()
  let total = 0

  for (const exp of expenses as DBExpense[]) {
    total += Number(exp.amount)
    const pid = exp.payer_telegram_user_id
    payerMap.set(pid, (payerMap.get(pid) || 0) + Number(exp.amount))
  }

  const payers = Array.from(payerMap.entries())
    .map(([user_id, amount]) => ({ user_id, amount }))
    .sort((a, b) => b.amount - a.amount)

  return {
    tag,
    total: Math.round(total * 100) / 100,
    count: expenses.length,
    payers
  }
}
