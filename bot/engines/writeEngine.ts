// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Write Engine
// All DB writes: log_expense, log_transfer, correct_*, trigger_settlement.
// Engines never call LLM. Pure DB operations + deterministic math.
// ─────────────────────────────────────────────────────────────────────────────

import { SupabaseClient } from '@supabase/supabase-js'
import { DBExpense, MemberInfo, ExecutorResult, GroupState } from '../types'
import { getUnsettledExpenses, computeBalancesFromExpenses } from './balanceEngine'
import { computeMinimalSettlements } from './settlementEngine'

// ── Helpers ─────────────────────────────────────────────────────────────────

function memberName(userId: number, members: MemberInfo[]): string {
  const found = members.find(m => m.telegram_user_id === userId)
  return found?.display_name || `User ${userId}`
}

function nameToProvisionalId(name: string): number {
  let hash = 5381
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash) + name.charCodeAt(i)
    hash = hash & hash
  }
  return -(Math.abs(hash) || 1)
}

function resolveMemberId(name: string, members: MemberInfo[]): number | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  const exact = members.find(m => m.display_name.toLowerCase() === lower)
  if (exact) return exact.telegram_user_id
  const partial = members.find(m =>
    m.display_name.toLowerCase().includes(lower) ||
    lower.includes(m.display_name.toLowerCase())
  )
  return partial?.telegram_user_id
}

async function upsertProvisionalMember(
  db: SupabaseClient,
  groupId: string,
  name: string
): Promise<void> {
  const normalized = name.trim().toLowerCase()
  const { data } = await db
    .from('members')
    .select('id')
    .eq('group_id', groupId)
    .ilike('display_name', normalized)
    .limit(1)

  if (data && data.length > 0) return

  const provisionalId = nameToProvisionalId(normalized)
  await db.from('members').upsert(
    {
      group_id: groupId,
      telegram_user_id: provisionalId,
      display_name: name.trim(),
      telegram_username: null
    },
    { onConflict: 'group_id,telegram_user_id' }
  )
}

async function getMembers(db: SupabaseClient, groupId: string): Promise<MemberInfo[]> {
  const { data } = await db
    .from('members')
    .select('telegram_user_id, display_name, telegram_username')
    .eq('group_id', groupId)
  return (data as MemberInfo[]) || []
}

// ── Duplicate detection (Phase 3) ────────────────────────────────────────────
// Returns true if identical expense exists in last 60 seconds.

export async function checkDuplicate(
  db: SupabaseClient,
  groupId: string,
  payerId: number,
  amount: number,
  description: string
): Promise<{ isDuplicate: boolean; existingId?: string }> {
  const since = new Date(Date.now() - 60000).toISOString()

  const { data } = await db
    .from('expenses')
    .select('id')
    .eq('group_id', groupId)
    .eq('payer_telegram_user_id', payerId)
    .eq('amount', amount)
    .ilike('description', description)
    .is('settlement_id', null)
    .gte('created_at', since)
    .limit(1)

  if (data && data.length > 0) {
    return { isDuplicate: true, existingId: data[0].id }
  }
  return { isDuplicate: false }
}

// ── Log Expense ─────────────────────────────────────────────────────────────

export async function logExpense(
  db: SupabaseClient,
  groupId: string,
  senderId: number,
  senderName: string,
  params: {
    payer_name?: string
    amount: number
    description?: string
    participant_names?: string[]
    tags?: string[]
  },
  messageId: number,
  messageDate: number
): Promise<ExecutorResult> {
  const payerName = params.payer_name || senderName
  await upsertProvisionalMember(db, groupId, payerName)

  if (params.participant_names && params.participant_names.length > 0) {
    for (const name of params.participant_names) {
      await upsertProvisionalMember(db, groupId, name)
    }
  }

  const members = await getMembers(db, groupId)
  const payerId = resolveMemberId(payerName, members) || senderId

  // Duplicate check
  const dupCheck = await checkDuplicate(db, groupId, payerId, params.amount, params.description || '')
  if (dupCheck.isDuplicate) {
    return {
      success: false,
      data: null,
      error: `DUPLICATE:${params.amount}:${params.description}`,
      state_updates: {}
    }
  }

  let participantIds: number[] | null = null
  if (params.participant_names && params.participant_names.length > 0) {
    participantIds = params.participant_names
      .map(name => resolveMemberId(name, members))
      .filter((id): id is number => id !== undefined)
  }

  const { data, error } = await db.from('expenses').insert({
    group_id: groupId,
    payer_telegram_user_id: payerId,
    payer_display_name: memberName(payerId, members),
    amount: params.amount,
    description: params.description || '',
    participants: participantIds,
    tags: params.tags || [],
    expense_timestamp: new Date(messageDate * 1000).toISOString(),
    telegram_message_id: messageId
  }).select('id').single()

  if (error) {
    console.error('[writeEngine] Expense insert error:', error)
    return { success: false, data: null, error: 'Failed to save expense.', state_updates: {} }
  }

  const payerDisplayName = memberName(payerId, members)

  return {
    success: true,
    data: {
      expense_id: data?.id,
      payer_name: payerDisplayName,
      amount: params.amount,
      description: params.description || '',
      participants: participantIds
    },
    state_updates: {
      last_action: {
        type: 'log_expense',
        summary: `${payerDisplayName} logged ${params.description || 'expense'} Rs.${params.amount}`,
        expense_id: data?.id,
        timestamp: new Date().toISOString()
      }
    }
  }
}

// ── Log Transfer ────────────────────────────────────────────────────────────

export async function logTransfer(
  db: SupabaseClient,
  groupId: string,
  senderId: number,
  senderName: string,
  params: {
    from_name?: string
    to_name?: string
    amount: number
  }
): Promise<ExecutorResult> {
  const fromName = params.from_name || senderName
  const toName = params.to_name || senderName

  await upsertProvisionalMember(db, groupId, fromName)
  await upsertProvisionalMember(db, groupId, toName)

  const members = await getMembers(db, groupId)
  const fromId = resolveMemberId(fromName, members) || senderId
  const toId = resolveMemberId(toName, members)

  if (!toId) {
    return { success: false, data: null, error: `Couldn't identify "${toName}".`, state_updates: {} }
  }

  const { error } = await db.from('expenses').insert({
    group_id: groupId,
    payer_telegram_user_id: fromId,
    payer_display_name: memberName(fromId, members),
    amount: params.amount,
    description: `transfer to ${memberName(toId, members)}`,
    participants: [toId],
    tags: ['transfer'],
    expense_timestamp: new Date().toISOString()
  })

  if (error) {
    console.error('[writeEngine] Transfer insert error:', error)
    return { success: false, data: null, error: 'Failed to save transfer.', state_updates: {} }
  }

  const fromDisplay = memberName(fromId, members)
  const toDisplay = memberName(toId, members)

  return {
    success: true,
    data: { from_name: fromDisplay, to_name: toDisplay, amount: params.amount },
    state_updates: {
      last_action: {
        type: 'log_transfer',
        summary: `${fromDisplay} → ${toDisplay} Rs.${params.amount}`,
        timestamp: new Date().toISOString()
      }
    }
  }
}

// ── Corrections ─────────────────────────────────────────────────────────────

export async function correctDeleteLast(
  db: SupabaseClient,
  groupId: string,
  state: GroupState
): Promise<ExecutorResult> {
  const { data: last } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!last) {
    return { success: false, data: null, error: 'No recent expense found to remove.', state_updates: {} }
  }

  await db.from('expenses').delete().eq('id', last.id)
  console.log('[writeEngine] ✓ Deleted last expense:', last.id)

  const currentContribs = state.member_contributions || {}
  const payerName = last.payer_display_name || ''
  const currentAmount = currentContribs[payerName] || 0
  const newAmount = Math.max(0, currentAmount - Number(last.amount))

  return {
    success: true,
    data: {
      removed_amount: last.amount,
      removed_description: last.description,
      removed_payer: last.payer_display_name
    },
    state_updates: {
      last_action: {
        type: 'correct',
        summary: `Removed Rs.${last.amount} "${last.description}"`,
        timestamp: new Date().toISOString()
      },
      member_contributions: { ...currentContribs, [payerName]: newAmount }
    }
  }
}

export async function correctDeleteSpecific(
  db: SupabaseClient,
  groupId: string,
  descriptionHint: string,
  state: GroupState
): Promise<ExecutorResult> {
  const { data: expenses } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .ilike('description', `%${descriptionHint}%`)
    .order('created_at', { ascending: false })
    .limit(1)

  if (!expenses || expenses.length === 0) {
    return { success: false, data: null, error: `No expense matching "${descriptionHint}" found.`, state_updates: {} }
  }

  const target = expenses[0]
  await db.from('expenses').delete().eq('id', target.id)
  console.log('[writeEngine] ✓ Deleted specific expense:', target.id)

  const currentContribs = state.member_contributions || {}
  const payerName = target.payer_display_name || ''
  const currentAmount = currentContribs[payerName] || 0
  const newAmount = Math.max(0, currentAmount - Number(target.amount))

  return {
    success: true,
    data: {
      removed_amount: target.amount,
      removed_description: target.description,
      removed_payer: target.payer_display_name
    },
    state_updates: {
      last_action: {
        type: 'correct',
        summary: `Removed Rs.${target.amount} "${target.description}"`,
        timestamp: new Date().toISOString()
      },
      member_contributions: { ...currentContribs, [payerName]: newAmount }
    }
  }
}

// ── Delete ALL matching (Phase 3 fix — "remove all" was only deleting one) ──

export async function correctDeleteAllMatching(
  db: SupabaseClient,
  groupId: string,
  descriptionHint: string,
  state: GroupState
): Promise<ExecutorResult> {
  const { data: expenses } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .ilike('description', `%${descriptionHint}%`)

  if (!expenses || expenses.length === 0) {
    return { success: false, data: null, error: `No expenses matching "${descriptionHint}" found.`, state_updates: {} }
  }

  const ids = (expenses as DBExpense[]).map(e => e.id)
  const totalRemoved = (expenses as DBExpense[]).reduce((s, e) => s + Number(e.amount), 0)

  await db.from('expenses').delete().in('id', ids)
  console.log('[writeEngine] ✓ Deleted', ids.length, 'expenses matching:', descriptionHint)

  let newContribs = { ...(state.member_contributions || {}) }
  for (const exp of (expenses as DBExpense[])) {
    const pName = exp.payer_display_name || ''
    const currentAmount = newContribs[pName] || 0
    newContribs[pName] = Math.max(0, currentAmount - Number(exp.amount))
  }

  return {
    success: true,
    data: {
      count: ids.length,
      description_hint: descriptionHint,
      total_removed: Math.round(totalRemoved * 100) / 100
    },
    state_updates: {
      last_action: {
        type: 'correct',
        summary: `Removed ${ids.length} expense(s) matching "${descriptionHint}". Total Rs.${Math.round(totalRemoved)}`,
        timestamp: new Date().toISOString()
      },
      member_contributions: newContribs
    }
  }
}

export async function correctUpdateAmount(
  db: SupabaseClient,
  groupId: string,
  newAmount: number,
  descriptionHint?: string | null
): Promise<ExecutorResult> {
  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (descriptionHint) {
    query = db
      .from('expenses')
      .select('*')
      .eq('group_id', groupId)
      .is('settlement_id', null)
      .ilike('description', `%${descriptionHint}%`)
      .order('created_at', { ascending: false })
      .limit(1)
  }

  const { data: expenses } = await query
  if (!expenses || expenses.length === 0) {
    return { success: false, data: null, error: 'No expense found to update.', state_updates: {} }
  }

  const target = expenses[0]
  const oldAmount = target.amount
  await db.from('expenses').update({ amount: newAmount }).eq('id', target.id)

  return {
    success: true,
    data: { description: target.description, old_amount: oldAmount, new_amount: newAmount },
    state_updates: {
      last_action: {
        type: 'correct',
        summary: `Updated "${target.description}" Rs.${oldAmount} → Rs.${newAmount}`,
        timestamp: new Date().toISOString()
      }
    }
  }
}

export async function correctUpdatePayer(
  db: SupabaseClient,
  groupId: string,
  newPayerName: string,
  descriptionHint?: string | null
): Promise<ExecutorResult> {
  await upsertProvisionalMember(db, groupId, newPayerName)
  const members = await getMembers(db, groupId)
  const newPayerId = resolveMemberId(newPayerName, members)

  if (!newPayerId) {
    return { success: false, data: null, error: `Couldn't find member "${newPayerName}".`, state_updates: {} }
  }

  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (descriptionHint) {
    query = db
      .from('expenses')
      .select('*')
      .eq('group_id', groupId)
      .is('settlement_id', null)
      .ilike('description', `%${descriptionHint}%`)
      .order('created_at', { ascending: false })
      .limit(1)
  }

  const { data: expenses } = await query
  if (!expenses || expenses.length === 0) {
    return { success: false, data: null, error: 'No expense found to update.', state_updates: {} }
  }

  const target = expenses[0]
  const oldPayer = target.payer_display_name
  await db.from('expenses').update({
    payer_telegram_user_id: newPayerId,
    payer_display_name: memberName(newPayerId, members)
  }).eq('id', target.id)

  return {
    success: true,
    data: { description: target.description, old_payer: oldPayer, new_payer: memberName(newPayerId, members) },
    state_updates: {
      last_action: {
        type: 'correct',
        summary: `Changed payer of "${target.description}" from ${oldPayer} to ${memberName(newPayerId, members)}`,
        timestamp: new Date().toISOString()
      }
    }
  }
}

export async function correctUpdateParticipants(
  db: SupabaseClient,
  groupId: string,
  participantNames: string[],
  descriptionHint?: string | null
): Promise<ExecutorResult> {
  for (const name of participantNames) {
    await upsertProvisionalMember(db, groupId, name)
  }
  const members = await getMembers(db, groupId)
  const participantIds = participantNames
    .map(name => resolveMemberId(name, members))
    .filter((id): id is number => id !== undefined)

  let query = db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (descriptionHint) {
    query = db
      .from('expenses')
      .select('*')
      .eq('group_id', groupId)
      .is('settlement_id', null)
      .ilike('description', `%${descriptionHint}%`)
      .order('created_at', { ascending: false })
      .limit(1)
  }

  const { data: expenses } = await query
  if (!expenses || expenses.length === 0) {
    return { success: false, data: null, error: 'No expense found to update.', state_updates: {} }
  }

  const target = expenses[0]
  await db.from('expenses').update({ participants: participantIds }).eq('id', target.id)
  const newNames = participantIds.map(id => memberName(id, members)).join(', ')

  return {
    success: true,
    data: { description: target.description, new_participants: newNames },
    state_updates: {
      last_action: {
        type: 'correct',
        summary: `Changed split of "${target.description}" to: ${newNames}`,
        timestamp: new Date().toISOString()
      }
    }
  }
}

// ── Settlement ──────────────────────────────────────────────────────────────

export async function executeSettlement(
  db: SupabaseClient,
  groupId: string,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  const expenses = await getUnsettledExpenses(db, groupId)
  if (expenses.length === 0) {
    return {
      success: true,
      data: { all_even: true, total: 0, count: 0, settlements: [] },
      state_updates: { member_contributions: {}, last_settlement_at: new Date().toISOString(), last_action: { type: 'settle', summary: "Checked settlement. Everyone was already even.", timestamp: new Date().toISOString() } }
    }
  }

  const allMemberIds = members.map(m => m.telegram_user_id)
  const balances = computeBalancesFromExpenses(expenses, allMemberIds)
  const txns = computeMinimalSettlements(balances)
  const totalAmount = expenses.reduce((s, e) => s + Number(e.amount), 0)

  const balancesSnapshot: Record<string, number> = {}
  for (const [uid, bal] of balances) balancesSnapshot[String(uid)] = bal

  const { data: settlement } = await db
    .from('settlements')
    .insert({
      group_id: groupId,
      total_amount: totalAmount,
      balances_snapshot: balancesSnapshot,
      transactions_snapshot: txns
    })
    .select('id')
    .single()

  if (settlement) {
    const ids = expenses.map(e => e.id)
    await db.from('expenses').update({ settlement_id: settlement.id }).in('id', ids)
    console.log('[writeEngine] ✓ Settlement created:', settlement.id)
  }

  const settlementEntries = txns.map(t => ({
    from_name: memberName(t.from, members),
    to_name: memberName(t.to, members),
    amount: Math.round(t.amount)
  }))

  return {
    success: true,
    data: { total: Math.round(totalAmount), count: expenses.length, settlements: settlementEntries, all_even: txns.length === 0 },
    state_updates: {
      last_action: {
        type: 'settle',
        summary: `Group settled. Total Rs.${Math.round(totalAmount)}`,
        timestamp: new Date().toISOString()
      },
      member_contributions: {},
      last_settlement_at: new Date().toISOString()
    }
  }
}

// ── Settlement history (Phase 3 — historical query) ─────────────────────────

export async function querySettlementHistory(
  db: SupabaseClient,
  groupId: string,
  members: MemberInfo[]
): Promise<ExecutorResult> {
  const { data: settlements } = await db
    .from('settlements')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (!settlements || settlements.length === 0) {
    return { success: true, data: { history: [] }, state_updates: {} }
  }

  type SettlementRow = {
    created_at: string
    total_amount: number
    transactions_snapshot: { from: number; to: number; amount: number }[]
  }

  const history = (settlements as SettlementRow[]).map(s => {
    const txns = s.transactions_snapshot || []
    return {
      date: new Date(s.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
      total: Math.round(Number(s.total_amount)),
      transactions: txns.map(t => ({
        from_name: memberName(t.from, members),
        to_name: memberName(t.to, members),
        amount: Math.round(t.amount)
      }))
    }
  })

  return {
    success: true,
    data: { history },
    state_updates: {}
  }
}
