import { SupabaseClient } from '@supabase/supabase-js'
import { DBExpense } from '../types'

type HistoryFilter = {
  time_filter?: string | null
  category?: string | null
  user_id?: number
}

function getTimeRange(filter: string): { from: string; to: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (filter) {
    case 'today':
      return {
        from: today.toISOString(),
        to: new Date(today.getTime() + 86400000).toISOString()
      }
    case 'yesterday': {
      const yest = new Date(today.getTime() - 86400000)
      return { from: yest.toISOString(), to: today.toISOString() }
    }
    case 'day_before_yesterday': {
      const dbY = new Date(today.getTime() - 172800000)
      const yest = new Date(today.getTime() - 86400000)
      return { from: dbY.toISOString(), to: yest.toISOString() }
    }
    case 'this_week': {
      const weekStart = new Date(today.getTime() - today.getDay() * 86400000)
      return { from: weekStart.toISOString(), to: new Date(today.getTime() + 86400000).toISOString() }
    }
    default:
      return {
        from: new Date(0).toISOString(),
        to: new Date().toISOString()
      }
  }
}

export async function queryHistory(
  db: SupabaseClient,
  groupId: string,
  filter: HistoryFilter
): Promise<DBExpense[]> {
  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('expense_timestamp', { ascending: false })

  if (filter.time_filter && filter.time_filter !== 'custom') {
    const range = getTimeRange(filter.time_filter)
    query = query
      .gte('expense_timestamp', range.from)
      .lte('expense_timestamp', range.to)
  }

  if (filter.category) {
    query = query.contains('tags', [filter.category.toLowerCase()])
  }

  if (filter.user_id) {
    query = query.eq('payer_telegram_user_id', filter.user_id)
  }

  const { data } = await query
  return (data as DBExpense[]) || []
}
