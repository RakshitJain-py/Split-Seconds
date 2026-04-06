// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Filter Engine
// Category + time filtered queries. Pure DB queries, no LLM.
// ─────────────────────────────────────────────────────────────────────────────

import { SupabaseClient } from '@supabase/supabase-js'
import { DBExpense, MemberInfo, ExecutorResult } from '../types'

// ── Time range helper ───────────────────────────────────────────────────────

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

function memberName(userId: number, members: MemberInfo[]): string {
  const found = members.find(m => m.telegram_user_id === userId)
  return found?.display_name || `User ${userId}`
}

// ── Query by category ───────────────────────────────────────────────────────

export async function queryCategory(
  db: SupabaseClient,
  groupId: string,
  tag: string,
  timeFilter: string,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .contains('tags', [tag.toLowerCase()])

  if (timeFilter && timeFilter !== 'all') {
    const range = getTimeRange(timeFilter)
    query = query
      .gte('expense_timestamp', range.from)
      .lte('expense_timestamp', range.to)
  }

  const { data: expenses } = await query

  if (!expenses || expenses.length === 0) {
    return {
      success: true,
      data: { tag, total: 0, count: 0, payers: [] },
      state_updates: {}
    }
  }

  const payerMap = new Map<number, number>()
  let total = 0

  for (const exp of expenses as DBExpense[]) {
    total += Number(exp.amount)
    const pid = exp.payer_telegram_user_id
    payerMap.set(pid, (payerMap.get(pid) || 0) + Number(exp.amount))
  }

  const payers = Array.from(payerMap.entries())
    .map(([userId, amount]) => ({ name: memberName(userId, members), amount }))
    .sort((a, b) => b.amount - a.amount)

  return {
    success: true,
    data: {
      tag,
      total: Math.round(total * 100) / 100,
      count: expenses.length,
      payers
    },
    state_updates: {}
  }
}

// ── Query by time ───────────────────────────────────────────────────────────

export async function queryTime(
  db: SupabaseClient,
  groupId: string,
  timeFilter: string,
  userId: number | null,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  const range = getTimeRange(timeFilter)

  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .gte('expense_timestamp', range.from)
    .lte('expense_timestamp', range.to)
    .order('expense_timestamp', { ascending: false })

  if (userId) {
    query = query.eq('payer_telegram_user_id', userId)
  }

  const { data: expenses } = await query

  if (!expenses || expenses.length === 0) {
    return {
      success: true,
      data: { time_filter: timeFilter, total: 0, count: 0, expenses: [] },
      state_updates: {}
    }
  }

  const total = expenses.reduce((s: number, e: DBExpense) => s + Number(e.amount), 0)
  const expenseList = expenses.map((e: DBExpense) => ({
    amount: Number(e.amount),
    description: e.description,
    payer: memberName(e.payer_telegram_user_id, members),
    tags: e.tags
  }))

  return {
    success: true,
    data: {
      time_filter: timeFilter,
      total: Math.round(total * 100) / 100,
      count: expenses.length,
      expenses: expenseList
    },
    state_updates: {}
  }
}

// ── Query expense list ──────────────────────────────────────────────────────

export async function queryExpenseList(
  db: SupabaseClient,
  groupId: string,
  limit: number,
  userId: number | null,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('created_at', { ascending: false })
    .limit(limit || 10)

  if (userId) {
    query = query.eq('payer_telegram_user_id', userId)
  }

  const { data: expenses } = await query

  if (!expenses || expenses.length === 0) {
    return {
      success: true,
      data: { count: 0, expenses: [] },
      state_updates: {}
    }
  }

  const expenseList = (expenses as DBExpense[]).map(e => ({
    amount: Number(e.amount),
    description: e.description,
    payer: memberName(e.payer_telegram_user_id, members),
    tags: e.tags,
    timestamp: e.expense_timestamp
  }))

  return {
    success: true,
    data: { count: expenseList.length, expenses: expenseList },
    state_updates: {}
  }
}
