import { SupabaseClient } from '@supabase/supabase-js'
import { DBExpense, HistoryFilter } from '../types'

function getTimeRange(filter: string): { start: string; end: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (filter) {
    case 'today':
      return {
        start: today.toISOString(),
        end: new Date(today.getTime() + 86400000).toISOString()
      }
    case 'yesterday': {
      const yesterday = new Date(today.getTime() - 86400000)
      return { start: yesterday.toISOString(), end: today.toISOString() }
    }
    case 'this_week': {
      const day = today.getDay()
      const monday = new Date(today.getTime() - (day === 0 ? 6 : day - 1) * 86400000)
      return { start: monday.toISOString(), end: new Date(now.getTime() + 86400000).toISOString() }
    }
    default:
      return { start: new Date(0).toISOString(), end: new Date(now.getTime() + 86400000).toISOString() }
  }
}

export async function queryHistory(
  db: SupabaseClient,
  group_id: string,
  filter: HistoryFilter
): Promise<DBExpense[]> {
  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', group_id)
    .is('settlement_id', null)
    .order('expense_timestamp', { ascending: false })

  if (filter.time_filter) {
    if (filter.time_filter === 'custom' && filter.custom_start && filter.custom_end) {
      query = query.gte('expense_timestamp', filter.custom_start).lte('expense_timestamp', filter.custom_end)
    } else {
      const range = getTimeRange(filter.time_filter)
      query = query.gte('expense_timestamp', range.start).lte('expense_timestamp', range.end)
    }
  }

  if (filter.user_id) {
    query = query.eq('payer_telegram_user_id', filter.user_id)
  }

  if (filter.category) {
    query = query.contains('tags', [filter.category])
  }

  const { data } = await query
  return (data as DBExpense[]) || []
}
