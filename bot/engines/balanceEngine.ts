// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Balance Engine
// Pure deterministic balance computation. No LLM. No side effects.
// ─────────────────────────────────────────────────────────────────────────────

import { SupabaseClient } from '@supabase/supabase-js'
import { DBExpense, MemberInfo, Transaction, ExecutorResult } from '../types'
import { computeMinimalSettlements } from './settlementEngine'

// ── Core balance computation (from expense rows) ────────────────────────────

export function computeBalancesFromExpenses(
  expenses: DBExpense[],
  allMemberIds: number[]
): Map<number, number> {
  const balances = new Map<number, number>()

  // Initialize all members to 0
  for (const uid of allMemberIds) {
    balances.set(uid, 0)
  }

  for (const exp of expenses) {
    const payerId = exp.payer_telegram_user_id
    const amount = Number(exp.amount)

    // Who shares this expense?
    let participantIds: number[]
    if (exp.participants && exp.participants.length > 0) {
      participantIds = exp.participants
    } else {
      // Empty/null = split among ALL members
      participantIds = allMemberIds
    }

    // Ensure payer exists in map (may be provisional)
    if (!balances.has(payerId)) balances.set(payerId, 0)

    // Payer gets credited (they paid out money)
    balances.set(payerId, (balances.get(payerId) || 0) + amount)

    // Each participant gets debited their share
    const share = amount / participantIds.length
    for (const pid of participantIds) {
      if (!balances.has(pid)) balances.set(pid, 0)
      balances.set(pid, (balances.get(pid) || 0) - share)
    }
  }

  // Round to 2 decimal places
  for (const [uid, bal] of balances) {
    balances.set(uid, Math.round(bal * 100) / 100)
  }

  return balances
}

// ── Fetch all unsettled expenses (NO LIMIT) ─────────────────────────────────

export async function getUnsettledExpenses(
  db: SupabaseClient,
  groupId: string
): Promise<DBExpense[]> {
  const { data } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('created_at', { ascending: false })
  return (data as DBExpense[]) || []
}

// ── High-level: compute group balances from DB ──────────────────────────────

export async function computeGroupBalances(
  db: SupabaseClient,
  groupId: string,
  members: MemberInfo[]
): Promise<Map<number, number>> {
  const expenses = await getUnsettledExpenses(db, groupId)
  const allMemberIds = members.map(m => m.telegram_user_id)
  return computeBalancesFromExpenses(expenses, allMemberIds)
}

// ── Engine entry points (return ExecutorResult) ─────────────────────────────

export async function executeGroupBalances(
  db: SupabaseClient,
  groupId: string,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  const balances = await computeGroupBalances(db, groupId, members)
  const settlements = computeMinimalSettlements(balances)

  const balanceEntries: { name: string; balance: number }[] = []
  for (const [uid, bal] of balances) {
    const member = members.find(m => m.telegram_user_id === uid)
    if (uid < 0 && Math.abs(bal) < 0.01) continue // skip inactive provisional
    balanceEntries.push({
      name: member?.display_name || `User ${uid}`,
      balance: bal
    })
  }

  const settlementEntries = settlements.map(s => ({
    from_name: members.find(m => m.telegram_user_id === s.from)?.display_name || `User ${s.from}`,
    to_name: members.find(m => m.telegram_user_id === s.to)?.display_name || `User ${s.to}`,
    amount: s.amount
  }))

  return {
    success: true,
    data: { balances: balanceEntries, settlements: settlementEntries },
    state_updates: {}
  }
}

export async function executeUserBalance(
  db: SupabaseClient,
  groupId: string,
  userId: number,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  const balances = await computeGroupBalances(db, groupId, members)
  const settlements = computeMinimalSettlements(balances)

  const userBalance = balances.get(userId) || 0
  const member = members.find(m => m.telegram_user_id === userId)
  const userName = member?.display_name || `User ${userId}`

  const owes_to: { name: string; amount: number }[] = []
  const owed_by: { name: string; amount: number }[] = []

  for (const txn of settlements) {
    if (txn.from === userId) {
      owes_to.push({
        name: members.find(m => m.telegram_user_id === txn.to)?.display_name || `User ${txn.to}`,
        amount: txn.amount
      })
    }
    if (txn.to === userId) {
      owed_by.push({
        name: members.find(m => m.telegram_user_id === txn.from)?.display_name || `User ${txn.from}`,
        amount: txn.amount
      })
    }
  }

  return {
    success: true,
    data: { user_name: userName, net_balance: userBalance, owes_to, owed_by },
    state_updates: {}
  }
}

export async function executePairBalance(
  db: SupabaseClient,
  groupId: string,
  userAId: number,
  userBId: number,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  const balances = await computeGroupBalances(db, groupId, members)
  const settlements = computeMinimalSettlements(balances)

  const nameA = members.find(m => m.telegram_user_id === userAId)?.display_name || `User ${userAId}`
  const nameB = members.find(m => m.telegram_user_id === userBId)?.display_name || `User ${userBId}`

  // Find transactions between these two
  const pairTxns = settlements.filter(
    s => (s.from === userAId && s.to === userBId) || (s.from === userBId && s.to === userAId)
  )

  if (pairTxns.length === 0) {
    return {
      success: true,
      data: { user_a: nameA, user_b: nameB, net: 0, direction: 'even' },
      state_updates: {}
    }
  }

  const txn = pairTxns[0]
  const fromName = members.find(m => m.telegram_user_id === txn.from)?.display_name || `User ${txn.from}`
  const toName = members.find(m => m.telegram_user_id === txn.to)?.display_name || `User ${txn.to}`

  return {
    success: true,
    data: {
      user_a: nameA,
      user_b: nameB,
      net: txn.amount,
      direction: `${fromName} owes ${toName}`,
      from_name: fromName,
      to_name: toName
    },
    state_updates: {}
  }
}
