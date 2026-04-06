// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Contribution Engine
// Tracks how much each member has actually paid (not balance — raw contribution).
// ─────────────────────────────────────────────────────────────────────────────

import { SupabaseClient } from '@supabase/supabase-js'
import { DBExpense, MemberInfo, ExecutorResult } from '../types'

function memberName(userId: number, members: MemberInfo[]): string {
  const found = members.find(m => m.telegram_user_id === userId)
  return found?.display_name || `User ${userId}`
}

// ── Query contribution (single user or ranking) ─────────────────────────────

export async function queryContribution(
  db: SupabaseClient,
  groupId: string,
  userId: number | null,
  scope: 'single' | 'ranking',
  members: MemberInfo[]
): Promise<ExecutorResult> {
  const { data: expenses } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)

  if (!expenses || expenses.length === 0) {
    return {
      success: true,
      data: { total: 0, contributions: [] },
      state_updates: {}
    }
  }

  // Exclude transfers from contribution calculation
  const nonTransfers = (expenses as DBExpense[]).filter(
    e => !e.tags || !e.tags.includes('transfer')
  )

  const contribMap = new Map<number, number>()
  for (const exp of nonTransfers) {
    const pid = exp.payer_telegram_user_id
    contribMap.set(pid, (contribMap.get(pid) || 0) + Number(exp.amount))
  }

  if (scope === 'single' && userId !== null) {
    const amount = contribMap.get(userId) || 0
    return {
      success: true,
      data: {
        user_name: memberName(userId, members),
        amount: Math.round(amount * 100) / 100,
        total_group: Math.round(nonTransfers.reduce((s, e) => s + Number(e.amount), 0) * 100) / 100
      },
      state_updates: {}
    }
  }

  // Ranking
  const ranked = Array.from(contribMap.entries())
    .map(([uid, amount]) => ({
      name: memberName(uid, members),
      amount: Math.round(amount * 100) / 100
    }))
    .sort((a, b) => b.amount - a.amount)

  const total = ranked.reduce((s, r) => s + r.amount, 0)

  return {
    success: true,
    data: {
      total: Math.round(total * 100) / 100,
      contributions: ranked
    },
    state_updates: {}
  }
}

// ── Query total spent (unsettled group total) ────────────────────────────────

export async function queryTotalSpent(
  db: SupabaseClient,
  groupId: string,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  const { data: expenses } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)

  if (!expenses || expenses.length === 0) {
    return {
      success: true,
      data: { total: 0, count: 0, breakdown_by_member: [] },
      state_updates: {}
    }
  }

  // Exclude transfers
  const nonTransfers = (expenses as DBExpense[]).filter(
    e => !e.tags || !e.tags.includes('transfer')
  )

  const contribMap = new Map<number, number>()
  for (const exp of nonTransfers) {
    const pid = exp.payer_telegram_user_id
    contribMap.set(pid, (contribMap.get(pid) || 0) + Number(exp.amount))
  }

  const breakdown = Array.from(contribMap.entries())
    .map(([uid, amount]) => ({
      name: memberName(uid, members),
      amount: Math.round(amount * 100) / 100
    }))
    .sort((a, b) => b.amount - a.amount)

  const total = breakdown.reduce((s, r) => s + r.amount, 0)

  return {
    success: true,
    data: {
      total: Math.round(total * 100) / 100,
      count: nonTransfers.length,
      breakdown_by_member: breakdown
    },
    state_updates: {}
  }
}
