import { createClient } from '@supabase/supabase-js'
import { parseExpense } from './parserAI'
import { routeIntent } from './intentRouter'
import { generateReply } from './chatLLM'
import { addMessage, getMessages } from './chatMemory'
import { computeGroupBalances } from './engines/balanceEngine'
import { computeMinimalSettlements } from './engines/settlementEngine'
import { computeUserView } from './engines/userViewEngine'
import { computeCategoryStats } from './engines/categoryEngine'
import { queryHistory } from './engines/historyEngine'
import { Intent, EngineResult, MemberInfo, ChatMessage, DBExpense } from './types'
import { logStep, logEngine, logDB, logAI } from './debug/logger'

export const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// --- helpers ---

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

function resolveMemberId(name: string, members: MemberInfo[]): number | undefined {
  const lower = name.toLowerCase()
  const exact = members.find(m => m.display_name.toLowerCase() === lower)
  if (exact) return exact.telegram_user_id
  const partial = members.find(m => m.display_name.toLowerCase().includes(lower))
  if (partial) return partial.telegram_user_id
  return undefined
}

function memberName(userId: number, members: MemberInfo[]): string {
  const found = members.find(m => m.telegram_user_id === userId)
  return found?.display_name || `User ${userId}`
}

// --- intent processor ---

async function processIntent(
  intent: Intent,
  groupId: string,
  members: MemberInfo[],
  senderId: number
): Promise<EngineResult> {
  switch (intent.type) {
    case 'GROUP_BALANCES': {
      const balances = await computeGroupBalances(db, groupId)
      const lines: string[] = []
      for (const [uid, bal] of balances) {
        const name = memberName(uid, members)
        if (bal > 0.01) lines.push(`${name}: gets back Rs.${bal.toFixed(0)}`)
        else if (bal < -0.01) lines.push(`${name}: owes Rs.${Math.abs(bal).toFixed(0)}`)
        else lines.push(`${name}: settled`)
      }
      return { type: 'GROUP_BALANCES', data: Object.fromEntries(balances), summary: `Group balances:\n${lines.join('\n')}` }
    }

    case 'USER_BALANCE': {
      const targetId = intent.actor ? resolveMemberId(intent.actor, members) : senderId
      if (!targetId) return { type: 'USER_BALANCE', data: null, summary: `Could not find member "${intent.actor}"` }
      const view = await computeUserView(db, groupId, targetId)
      const name = memberName(targetId, members)
      let summary = `${name}'s balance: Rs.${view.net_balance.toFixed(0)}\n`
      if (view.owes_to.length > 0) summary += `Owes: ${view.owes_to.map(o => `Rs.${o.amount} to ${memberName(o.user_id, members)}`).join(', ')}\n`
      if (view.owed_by.length > 0) summary += `Owed by: ${view.owed_by.map(o => `Rs.${o.amount} from ${memberName(o.user_id, members)}`).join(', ')}`
      return { type: 'USER_BALANCE', data: view, summary }
    }

    case 'PAIR_BALANCE': {
      const actorId = intent.actor ? resolveMemberId(intent.actor, members) : senderId
      const counterId = intent.counterparty ? resolveMemberId(intent.counterparty, members) : undefined
      if (!actorId || !counterId) return { type: 'PAIR_BALANCE', data: null, summary: 'Could not identify both members' }
      const balances = await computeGroupBalances(db, groupId)
      const settlements = computeMinimalSettlements(balances)
      const relevant = settlements.filter(t =>
        (t.from === actorId && t.to === counterId) || (t.from === counterId && t.to === actorId)
      )
      const aName = memberName(actorId, members)
      const cName = memberName(counterId, members)
      const summary = relevant.length === 0
        ? `${aName} and ${cName} are even`
        : relevant.map(t => `${memberName(t.from, members)} owes Rs.${t.amount} to ${memberName(t.to, members)}`).join('\n')
      return { type: 'PAIR_BALANCE', data: relevant, summary }
    }

    case 'SETTLEMENT_PLAN': {
      const balances = await computeGroupBalances(db, groupId)
      const txns = computeMinimalSettlements(balances)
      const summary = txns.length === 0
        ? 'Everyone is even — no settlements needed'
        : 'To settle up:\n' + txns.map(t => `${memberName(t.from, members)} → ${memberName(t.to, members)}: Rs.${t.amount}`).join('\n')
      return { type: 'SETTLEMENT_PLAN', data: txns, summary }
    }

    case 'USER_CONTRIBUTION':
    case 'CONTRIBUTION_RANKING': {
      const { data: expenses } = await db.from('expenses').select('*').eq('group_id', groupId).is('settlement_id', null)
      if (!expenses || expenses.length === 0) return { type: intent.type, data: null, summary: 'No expenses recorded yet' }
      const contribs: Map<number, number> = new Map()
      for (const exp of expenses as DBExpense[]) {
        contribs.set(exp.payer_telegram_user_id, (contribs.get(exp.payer_telegram_user_id) || 0) + exp.amount)
      }
      if (intent.type === 'USER_CONTRIBUTION') {
        const targetId = intent.actor ? resolveMemberId(intent.actor, members) : senderId
        if (!targetId) return { type: intent.type, data: null, summary: `Could not find member "${intent.actor}"` }
        const amt = contribs.get(targetId) || 0
        return { type: intent.type, data: amt, summary: `${memberName(targetId, members)} has paid a total of Rs.${amt.toFixed(0)}` }
      }
      const ranked = Array.from(contribs.entries()).sort((a, b) => b[1] - a[1])
      const lines = ranked.map(([uid, amt], i) => `${i + 1}. ${memberName(uid, members)}: Rs.${amt.toFixed(0)}`)
      return { type: intent.type, data: ranked, summary: `Contribution ranking:\n${lines.join('\n')}` }
    }

    case 'CATEGORY_TOTAL':
    case 'CATEGORY_PAYER': {
      const cat = intent.category || 'misc'
      const stats = await computeCategoryStats(db, groupId, cat)
      if (stats.count === 0) return { type: intent.type, data: stats, summary: `No expenses found with tag "${cat}"` }
      let summary = `Tag "${cat}": Rs.${stats.total.toFixed(0)} total across ${stats.count} expenses`
      if (intent.type === 'CATEGORY_PAYER' && stats.payers.length > 0) {
        summary += '\n' + stats.payers.map(p => `${memberName(p.user_id, members)}: Rs.${p.amount.toFixed(0)}`).join('\n')
      }
      return { type: intent.type, data: stats, summary }
    }

    case 'TIME_FILTERED_SPEND':
    case 'TIME_FILTERED_PAYER': {
      const history = await queryHistory(db, groupId, {
        time_filter: intent.time_filter,
        category: intent.category
      })
      if (history.length === 0) return { type: intent.type, data: [], summary: 'No expenses found for that time period' }
      const total = history.reduce((s, e) => s + e.amount, 0)
      let summary = `${history.length} expenses totaling Rs.${total.toFixed(0)}`
      if (intent.type === 'TIME_FILTERED_PAYER') {
        const payerMap: Map<number, number> = new Map()
        for (const exp of history) payerMap.set(exp.payer_telegram_user_id, (payerMap.get(exp.payer_telegram_user_id) || 0) + exp.amount)
        summary += '\n' + Array.from(payerMap.entries()).map(([uid, amt]) => `${memberName(uid, members)}: Rs.${amt.toFixed(0)}`).join('\n')
      }
      return { type: intent.type, data: history, summary }
    }

    case 'TRIGGER_SETTLEMENT': {
      const balances = await computeGroupBalances(db, groupId)
      const txns = computeMinimalSettlements(balances)
      const { data: unsettled } = await db.from('expenses').select('id, amount').eq('group_id', groupId).is('settlement_id', null)
      if (!unsettled || unsettled.length === 0) return { type: 'TRIGGER_SETTLEMENT', data: null, summary: 'No unsettled expenses to settle' }
      const totalAmount = unsettled.reduce((s: number, e: { amount: number }) => s + Number(e.amount), 0)
      const balancesSnapshot: Record<string, number> = {}
      for (const [uid, bal] of balances) balancesSnapshot[String(uid)] = bal
      const { data: settlement } = await db.from('settlements').insert({
        group_id: groupId, total_amount: totalAmount,
        balances_snapshot: balancesSnapshot, transactions_snapshot: txns
      }).select('id').single()
      if (settlement) {
        const ids = unsettled.map((e: { id: string }) => e.id)
        await db.from('expenses').update({ settlement_id: settlement.id }).in('id', ids)
      }
      const summary = txns.length === 0
        ? `Settlement recorded. Total: Rs.${totalAmount.toFixed(0)}. Everyone is even!`
        : `Settlement recorded. Total: Rs.${totalAmount.toFixed(0)}.\n` + txns.map(t => `${memberName(t.from, members)} → ${memberName(t.to, members)}: Rs.${t.amount}`).join('\n')
      return { type: 'TRIGGER_SETTLEMENT', data: { settlement, txns }, summary }
    }

    case 'CORRECT_LAST': {
      const { data: last } = await db.from('expenses').select('*').eq('group_id', groupId).is('settlement_id', null).order('expense_timestamp', { ascending: false }).limit(1).single()
      if (!last) return { type: 'CORRECT_LAST', data: null, summary: 'No recent expense found to correct' }
      await db.from('expenses').delete().eq('id', last.id)
      return { type: 'CORRECT_LAST', data: last, summary: `Deleted last expense: Rs.${last.amount} for "${last.description}" by ${memberName(last.payer_telegram_user_id, members)}` }
    }

    case 'CORRECT_BY_DESCRIPTION': {
      const desc = intent.category || ''
      const { data: matches } = await db.from('expenses').select('*').eq('group_id', groupId).is('settlement_id', null).ilike('description', `%${desc}%`).order('expense_timestamp', { ascending: false }).limit(1).single()
      if (!matches) return { type: 'CORRECT_BY_DESCRIPTION', data: null, summary: `No expense found matching "${desc}"` }
      await db.from('expenses').delete().eq('id', matches.id)
      return { type: 'CORRECT_BY_DESCRIPTION', data: matches, summary: `Deleted expense: Rs.${matches.amount} for "${matches.description}" by ${memberName(matches.payer_telegram_user_id, members)}` }
    }

    default:
      return { type: 'UNKNOWN', data: null, summary: '' }
  }
}

// --- main dispatch ---

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
    console.log('[dispatch] No group found for chat', chatId, '— ignoring message')
    return null
  }

  console.log(`[dispatch] Group found: ${group.id} | sender: ${senderName} (${senderId})`)

  await upsertMember(group.id, senderId, senderName, senderUsername)
  const members = await getMembers(group.id)
  console.log(`[dispatch] Members in group: ${members.map(m => m.display_name).join(', ') || '(none yet)'}`)

  addMessage(chatId, {
    role: 'user', telegram_user_id: senderId,
    text: messageText, message_id: messageId, timestamp: messageDate
  })

  const history = getMessages(chatId)
  const engineResults: EngineResult[] = []

  // AI Layer 1: parse expense
  console.log('[dispatch] Calling parseExpense...')
  const parsed = await parseExpense(messageText, senderName, senderId, members, replyText)
  console.log('[dispatch] parseExpense result:', parsed)

  if (parsed) {
    const { error: dbErr } = await db.from('expenses').insert({
      group_id: group.id, payer_telegram_user_id: parsed.payer, amount: parsed.amount,
      description: parsed.description, participants: parsed.participants,
      tags: parsed.tags, expense_timestamp: new Date(messageDate * 1000).toISOString(),
      telegram_message_id: messageId, payer_display_name: memberName(parsed.payer, members)
    })
    if (dbErr) {
      console.error('[dispatch] DB insert error:', dbErr)
    } else {
      logDB('db_write', { table: 'expenses', action: 'insert' })
    }
    engineResults.push({
      type: 'RECORD_EXPENSE', data: parsed,
      summary: `Logged: Rs.${parsed.amount} for "${parsed.description}" paid by ${memberName(parsed.payer, members)}`
    })
  }

  // AI Layer 2: route intent
  console.log('[dispatch] Calling routeIntent...')
  const intents = await routeIntent(messageText, senderName, members, replyText)
  console.log('[dispatch] routeIntent result:', intents)

  // Filter out RECORD_EXPENSE (already handled by parser above) and low-confidence UNKNOWN
  const nonExpenseIntents = intents.filter(i => i.type !== 'RECORD_EXPENSE' && i.type !== 'UNKNOWN')
  console.log('[dispatch] actionable intents:', nonExpenseIntents)

  for (const intent of nonExpenseIntents) {
    logStep('processing_intent', intent.type)
    logEngine('engine_call', intent.type)
    const result = await processIntent(intent, group.id, members, senderId)
    logEngine('engine_result', result)
    engineResults.push(result)
  }

  // If nothing happened, skip reply
  if (engineResults.length === 0) {
    console.log('[dispatch] No engine results — skipping reply')
    return null
  }

  // AI Layer 3: generate reply
  console.log('[dispatch] Calling generateReply with', engineResults.length, 'result(s)...')
  logAI('chatLLM_input', { context_length: history.length })
  const reply = await generateReply(messageText, senderName, engineResults, history, members, replyText)
  logAI('chatLLM_output', reply)
  console.log('[dispatch] Final reply:', reply)

  addMessage(chatId, { role: 'assistant', text: reply, timestamp: Math.floor(Date.now() / 1000) })

  return reply
}
