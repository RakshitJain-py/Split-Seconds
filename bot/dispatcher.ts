// ─────────────────────────────────────────────────────────────────────────────
// Temporary Version Step Down
// Simplified dispatcher — single LLM for action detection, code for math
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import { callBolt, BoltResponse } from './boltLLM'
import { addMessage, getMessages } from './chatMemory'
import { MemberInfo, DBExpense } from './types'

export const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getGroupByChat(chatId: number) {
  const { data } = await db
    .from('groups')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .single()
  return data
}

async function getMembers(groupId: string): Promise<MemberInfo[]> {
  const { data } = await db
    .from('members')
    .select('telegram_user_id, display_name, telegram_username')
    .eq('group_id', groupId)
  return (data as MemberInfo[]) || []
}

export async function upsertMember(
  groupId: string,
  telegramUserId: number,
  displayName: string,
  username?: string
) {
  await db.from('members').upsert(
    {
      group_id: groupId,
      telegram_user_id: telegramUserId,
      display_name: displayName,
      telegram_username: username || null
    },
    { onConflict: 'group_id,telegram_user_id' }
  )
}

function nameToProvisionalId(name: string): number {
  let hash = 5381
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash) + name.charCodeAt(i)
    hash = hash & hash
  }
  return -(Math.abs(hash) || 1)
}

async function upsertProvisionalMember(groupId: string, name: string): Promise<void> {
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

function memberName(userId: number, members: MemberInfo[]): string {
  const found = members.find(m => m.telegram_user_id === userId)
  return found?.display_name || `User ${userId}`
}

async function getUnsettledExpenses(groupId: string): Promise<DBExpense[]> {
  const { data } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('created_at', { ascending: false })
    .limit(50)
  return (data as DBExpense[]) || []
}

// ─── Deterministic Balance Computation ───────────────────────────────────────
// LLMs can't do math. This is the ONLY place balances are calculated.

function computeBalances(expenses: DBExpense[], allMemberIds: number[]): Map<number, number> {
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

    // Ensure payer exists in map
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

  // Round
  for (const [uid, bal] of balances) {
    balances.set(uid, Math.round(bal * 100) / 100)
  }

  return balances
}

type Settlement = { from: number; to: number; amount: number }

function computeSettlements(balances: Map<number, number>): Settlement[] {
  const creditors: { id: number; amount: number }[] = []
  const debtors: { id: number; amount: number }[] = []

  for (const [uid, bal] of balances) {
    if (bal > 0.01) creditors.push({ id: uid, amount: bal })
    else if (bal < -0.01) debtors.push({ id: uid, amount: Math.abs(bal) })
  }

  creditors.sort((a, b) => b.amount - a.amount)
  debtors.sort((a, b) => b.amount - a.amount)

  const txns: Settlement[] = []
  let ci = 0, di = 0

  while (ci < creditors.length && di < debtors.length) {
    const credit = creditors[ci]
    const debt = debtors[di]
    const transfer = Math.min(credit.amount, debt.amount)

    txns.push({
      from: debt.id,
      to: credit.id,
      amount: Math.round(transfer * 100) / 100
    })

    credit.amount -= transfer
    debt.amount -= transfer

    if (credit.amount < 0.01) ci++
    if (debt.amount < 0.01) di++
  }

  return txns
}

// Format balances into a human reply (code, not LLM)
function formatBalanceReply(balances: Map<number, number>, members: MemberInfo[]): string {
  const lines: string[] = []
  let totalSpent = 0

  // Calculate total from expenses perspective
  for (const [uid, bal] of balances) {
    if (uid < 0) continue // skip provisional members with no real activity
    if (bal > 0.01) lines.push(`${memberName(uid, members)}: is owed Rs.${Math.round(bal)}`)
    else if (bal < -0.01) lines.push(`${memberName(uid, members)}: owes Rs.${Math.round(Math.abs(bal))}`)
    else lines.push(`${memberName(uid, members)}: all settled ✓`)
  }

  if (lines.length === 0) return "No expenses recorded yet."

  // Compute who should pay whom
  const settlements = computeSettlements(balances)
  if (settlements.length > 0) {
    lines.push('')
    lines.push('To settle up:')
    for (const s of settlements) {
      lines.push(`  ${memberName(s.from, members)} → ${memberName(s.to, members)}: Rs.${Math.round(s.amount)}`)
    }
  } else {
    lines.push('\nEveryone is even! 🎉')
  }

  return lines.join('\n')
}

function formatTotalReply(expenses: DBExpense[], members: MemberInfo[]): string {
  const nonTransfers = expenses.filter(e => !e.tags || !e.tags.includes('transfer'))
  if (nonTransfers.length === 0) return "No expenses recorded yet."
  const total = nonTransfers.reduce((s, e) => s + Number(e.amount), 0)
  return `Total spent: Rs.${Math.round(total)} across ${nonTransfers.length} expenses.`
}

// ─── Action Handlers ─────────────────────────────────────────────────────────

async function handleExpense(
  bolt: BoltResponse,
  groupId: string,
  senderId: number,
  senderName: string,
  members: MemberInfo[],
  messageId: number,
  messageDate: number
): Promise<void> {
  const exp = bolt.expense
  if (!exp || !exp.amount || exp.amount <= 0) return

  const payerName = exp.payer_name || senderName
  await upsertProvisionalMember(groupId, payerName)

  if (exp.participants && exp.participants.length > 0) {
    for (const name of exp.participants) {
      await upsertProvisionalMember(groupId, name)
    }
  }

  const updatedMembers = await getMembers(groupId)
  const payerId = resolveMemberId(payerName, updatedMembers) || senderId

  let participantIds: number[] | null = null
  if (exp.participants && exp.participants.length > 0) {
    participantIds = exp.participants
      .map(name => resolveMemberId(name, updatedMembers))
      .filter((id): id is number => id !== undefined)
  }

  const { error } = await db.from('expenses').insert({
    group_id: groupId,
    payer_telegram_user_id: payerId,
    payer_display_name: memberName(payerId, updatedMembers),
    amount: exp.amount,
    description: exp.description || '',
    participants: participantIds,
    tags: exp.tags || [],
    expense_timestamp: new Date(messageDate * 1000).toISOString(),
    telegram_message_id: messageId
  })

  if (error) {
    console.error('[dispatch] Expense insert error:', error)
  } else {
    console.log('[dispatch] ✓ Expense logged:', exp.amount, exp.description)
  }
}

async function handleTransfer(
  bolt: BoltResponse,
  groupId: string,
  senderId: number,
  senderName: string,
  members: MemberInfo[]
): Promise<void> {
  const tx = bolt.transfer
  if (!tx || !tx.amount || tx.amount <= 0) return

  const fromName = tx.from || senderName
  const toName = tx.to || senderName

  await upsertProvisionalMember(groupId, fromName)
  await upsertProvisionalMember(groupId, toName)

  const updatedMembers = await getMembers(groupId)
  const fromId = resolveMemberId(fromName, updatedMembers) || senderId
  const toId = resolveMemberId(toName, updatedMembers)

  if (!toId) {
    console.error('[dispatch] Could not resolve transfer recipient:', toName)
    return
  }

  const { error } = await db.from('expenses').insert({
    group_id: groupId,
    payer_telegram_user_id: fromId,
    payer_display_name: memberName(fromId, updatedMembers),
    amount: tx.amount,
    description: `transfer to ${memberName(toId, updatedMembers)}`,
    participants: [toId],
    tags: ['transfer'],
    expense_timestamp: new Date().toISOString()
  })

  if (error) {
    console.error('[dispatch] Transfer insert error:', error)
  } else {
    console.log('[dispatch] ✓ Transfer logged:', fromName, '→', toName, tx.amount)
  }
}

async function handleSettle(
  groupId: string,
  members: MemberInfo[],
  expenses: DBExpense[]
): Promise<string> {

  if (expenses.length === 0) return 'No unsettled expenses to settle.'

  const allMemberIds = members.map(m => m.telegram_user_id)
  const balances = computeBalances(expenses, allMemberIds)
  const txns = computeSettlements(balances)

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
    console.log('[dispatch] ✓ Settlement created:', settlement.id)
  }

  if (txns.length === 0) {
    return `Settlement done! Total: Rs.${Math.round(totalAmount)}. Everyone was even! 🎉`
  }

  const lines = [`Settlement recorded. Total: Rs.${Math.round(totalAmount)}.`, '']
  for (const t of txns) {
    lines.push(`${memberName(t.from, members)} → ${memberName(t.to, members)}: Rs.${Math.round(t.amount)}`)
  }
  lines.push('', 'All expenses marked settled. Fresh start! ✨')
  return lines.join('\n')
}

async function handleCorrection(bolt: BoltResponse, groupId: string, members: MemberInfo[]): Promise<string> {
  const corr = bolt.correction
  if (!corr) return 'Could not understand what to correct.'

  const { data: last } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!last) return 'No recent expense found to correct.'

  if (corr.type === 'delete_last') {
    await db.from('expenses').delete().eq('id', last.id)
    console.log('[dispatch] ✓ Deleted last expense:', last.id)
    return `Removed: Rs.${last.amount} "${last.description}" by ${last.payer_display_name || 'unknown'}.`
  } else if (corr.type === 'update_amount' && corr.new_amount && corr.new_amount > 0) {
    await db.from('expenses').update({ amount: corr.new_amount }).eq('id', last.id)
    console.log('[dispatch] ✓ Updated expense:', last.id, '→', corr.new_amount)
    return `Updated "${last.description}" from Rs.${last.amount} to Rs.${corr.new_amount}.`
  }

  return 'Could not process correction.'
}

// ─── Main Dispatch ───────────────────────────────────────────────────────────

export async function dispatch(
  chatId: number,
  messageText: string,
  senderId: number,
  senderName: string,
  senderUsername: string | undefined,
  messageId: number,
  messageDate: number,
  replyText?: string
): Promise<string | null> {

  const group = await getGroupByChat(chatId)
  if (!group) {
    console.log('[dispatch] No group found for chat', chatId)
    return null
  }

  // Upsert the sender
  await upsertMember(group.id, senderId, senderName, senderUsername)
  const members = await getMembers(group.id)

  // Store message in memory
  addMessage(chatId, {
    role: 'user',
    telegram_user_id: senderId,
    text: messageText,
    message_id: messageId,
    timestamp: messageDate
  })

  const history = getMessages(chatId)

  // Get current expenses for context
  const expenses = await getUnsettledExpenses(group.id)

  // Call the single LLM for action detection
  console.log(`[dispatch] Calling Bolt for: "${messageText}" from ${senderName}`)
  const bolt = await callBolt(messageText, senderName, history, members, expenses)
  console.log('[dispatch] Bolt action:', bolt.action)

  // ── Execute action and build reply ─────────────────────────────────────────
  let reply: string

  switch (bolt.action) {

    case 'log_expense':
      await handleExpense(bolt, group.id, senderId, senderName, members, messageId, messageDate)
      reply = bolt.reply // LLM confirmation is fine for this
      break

    case 'transfer':
      await handleTransfer(bolt, group.id, senderId, senderName, members)
      reply = bolt.reply
      break

    case 'settle':
      // Deterministic — code does the math and formats reply
      reply = await handleSettle(group.id, members, expenses)
      break

    case 'correction':
      // Deterministic — code does the action and formats reply
      reply = await handleCorrection(bolt, group.id, members)
      break

    case 'query': {
      // NEVER trust LLM math — compute balances deterministically
      const allMemberIds = members.map(m => m.telegram_user_id)
      const balances = computeBalances(expenses, allMemberIds)

      // Detect query sub-type from bolt or message
      const msg = messageText.toLowerCase()
      if (msg.includes('total') || msg.includes('kitna hua') || msg.includes('total spent')) {
        reply = formatTotalReply(expenses, members)
      } else {
        // Default: full balance view with settlement plan
        reply = formatBalanceReply(balances, members)
      }
      break
    }

    case 'none':
    default:
      reply = bolt.reply
      break
  }

  // Store bot reply in memory
  if (reply) {
    addMessage(chatId, {
      role: 'assistant',
      text: reply,
      timestamp: Math.floor(Date.now() / 1000)
    })
  }

  return reply || null
}
