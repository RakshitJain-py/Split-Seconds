// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Full Pipeline Dispatcher
// Orchestrates all 5 layers: Gate → Classifier → Executor → Briefer → Reply
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import { addMessage, getMessages } from './chatMemory'
import { MemberInfo, FunctionCall, ExecutorResult, GroupState } from './types'
import { loadGroupState, saveGroupState, updateContributions } from './groupState'
import { evaluateGate } from './gate'
import { classify } from './classifier'
import { resolveNames, buildNameClarificationMessage } from './nameResolver'
import { buildBriefing, buildSocialBriefing, buildErrorBriefing } from './briefer'
import { generateReply } from './replyGenerator'
import {
  debugNoGroup, debugGroupState, debugHotMemory, debugGate,
  debugError, debugPendingConfirmation,
  debugNameResolution, debugEngineCall, debugEngineResult, debugDuplicate,
  debugBriefing, debugReplyStart, debugReplyResult,
  debugStateSave, debugDispatchComplete,
} from './debug'

// Engines
import { executeGroupBalances, executeUserBalance, executePairBalance } from './engines/balanceEngine'
import {
  logExpense, logTransfer,
  correctDeleteLast, correctDeleteSpecific, correctDeleteAllMatching,
  correctUpdateAmount, correctUpdatePayer, correctUpdateParticipants,
  executeSettlement, querySettlementHistory
} from './engines/writeEngine'
import { queryContribution, queryTotalSpent } from './engines/contribEngine'
import { queryCategory, queryTime, queryExpenseList } from './engines/filterEngine'

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

// ─── Execute a single FunctionCall via the correct engine ───────────────────

async function executeFunction(
  fnCall: FunctionCall,
  groupId: string,
  members: MemberInfo[],
  senderId: number,
  senderName: string,
  state: GroupState,
  messageId: number,
  messageDate: number,
  replyToIsBot: boolean
): Promise<ExecutorResult> {
  const p = fnCall.parameters as Record<string, unknown>

  switch (fnCall.name) {

    // ── RECORD ──────────────────────────────────────────────────────────────
    case 'log_expense':
      return logExpense(db, groupId, senderId, senderName, {
        payer_name: (p.payer_name as string) || senderName,
        amount: p.amount as number,
        description: p.description as string,
        participant_names: p.participant_names as string[] | undefined,
        tags: p.tags as string[] | undefined
      }, messageId, messageDate)

    case 'log_transfer':
      return logTransfer(db, groupId, senderId, senderName, {
        from_name: p.from_name as string,
        to_name: p.to_name as string,
        amount: p.amount as number
      })

    // ── QUERY ────────────────────────────────────────────────────────────────
    case 'query_balance_group':
      return executeGroupBalances(db, groupId, members)

    case 'query_balance_user': {
      const userName = (p.user_name as string) || senderName
      const targetMember = members.find(m =>
        m.display_name.toLowerCase() === userName.toLowerCase()
      )
      const targetId = targetMember?.telegram_user_id || senderId
      return executeUserBalance(db, groupId, targetId, members)
    }

    case 'query_balance_pair': {
      const mA = members.find(m => m.display_name.toLowerCase() === (p.user_a as string)?.toLowerCase())
      const mB = members.find(m => m.display_name.toLowerCase() === (p.user_b as string)?.toLowerCase())
      if (!mA || !mB) {
        return { success: false, data: null, error: `Couldn't find both members.`, state_updates: {} }
      }
      return executePairBalance(db, groupId, mA.telegram_user_id, mB.telegram_user_id, members)
    }

    case 'query_contribution': {
      const userName = p.user_name as string | null
      const scope = (p.scope as 'single' | 'ranking') || 'ranking'
      let userId: number | null = null
      if (userName) {
        const m = members.find(m => m.display_name.toLowerCase() === userName.toLowerCase())
        userId = m?.telegram_user_id || senderId
      }
      return queryContribution(db, groupId, userId, scope, members)
    }

    case 'query_total_spent':
      return queryTotalSpent(db, groupId, members)

    case 'query_category':
      return queryCategory(db, groupId, p.tag as string, p.time_filter as string, members)

    case 'query_time': {
      const userName = p.user_name as string | null
      let userId: number | null = null
      if (userName) {
        const m = members.find(m => m.display_name.toLowerCase() === userName.toLowerCase())
        userId = m?.telegram_user_id || null
      }
      return queryTime(db, groupId, p.time_filter as string, userId, members)
    }

    case 'query_expense_list': {
      const userName = p.user_name as string | null
      let userId: number | null = null
      if (userName) {
        const m = members.find(m => m.display_name.toLowerCase() === userName.toLowerCase())
        userId = m?.telegram_user_id || null
      }
      return queryExpenseList(db, groupId, (p.limit as number) || 10, userId, members)
    }

    case 'query_settlement_history':
      return querySettlementHistory(db, groupId, members)

    // ── CORRECT ──────────────────────────────────────────────────────────────
    case 'correct_delete_last':
      if (!replyToIsBot) {
        return { success: false, data: null, error: 'Please reply directly to the specific bot receipt you want to undo, or name the expense explicitly (e.g., "undo petrol").', state_updates: {} }
      }
      return correctDeleteLast(db, groupId, state)

    case 'correct_delete_specific':
      return correctDeleteSpecific(db, groupId, p.description_hint as string, state)

    case 'correct_delete_all_matching':
      return correctDeleteAllMatching(db, groupId, p.description_hint as string, state)

    case 'correct_update_amount':
      return correctUpdateAmount(db, groupId, p.new_amount as number, p.description_hint as string | null)

    case 'correct_update_payer':
      return correctUpdatePayer(db, groupId, p.new_payer_name as string, p.description_hint as string | null)

    case 'correct_update_participants':
      return correctUpdateParticipants(db, groupId, p.participant_names as string[], p.description_hint as string | null)

    // ── CONTROL ──────────────────────────────────────────────────────────────
    case 'trigger_settlement':
      return executeSettlement(db, groupId, members)

    case 'change_name': {
      const newName = p.new_name as string
      await db.from('groups').update({ bot_alias: newName }).eq('id', groupId)
      return {
        success: true,
        data: { new_name: newName },
        state_updates: {
          last_action: {
            type: 'control',
            summary: `Bot name changed to "${newName}"`,
            timestamp: new Date().toISOString()
          }
        }
      }
    }

    default:
      return { success: false, data: null, error: `Unknown function: ${fnCall.name}`, state_updates: {} }
  }
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
  replyText?: string,
  replyToIsBot?: boolean
): Promise<string | null> {

  // 0. Load group + state
  const group = await getGroupByChat(chatId)
  if (!group) {
    debugNoGroup(chatId)
    debugDispatchComplete(null)
    return null
  }

  const state = await loadGroupState(db, group.id)
  debugGroupState(state)

  await upsertMember(group.id, senderId, senderName, senderUsername)
  const members = await getMembers(group.id)

  // Hot memory
  addMessage(chatId, {
    role: 'user',
    telegram_user_id: senderId,
    text: messageText,
    message_id: messageId,
    timestamp: messageDate
  })
  const hotMemory = getMessages(chatId)
  debugHotMemory(chatId, hotMemory)

  // L1 — Gate
  const botAlias = group.bot_alias || 'bolt'
  const gate = evaluateGate(messageText, replyToIsBot || false, botAlias)
  debugGate(gate, messageText, botAlias)

  if (gate.decision === 'ignore') {
    debugDispatchComplete(null)
    return null
  }

  // ── Passive: memory only — NO classifier, NO DB write ────────────────────
  // The group is casually discussing money. We note it in warm memory so the
  // classifier has context if the user later explicitly asks the bot to log it.
  // Nothing is written to the expenses table until a directed trigger fires.
  if (gate.decision === 'passive') {
    const passiveMention = `${senderName}: "${messageText}" (noted, not logged)`
    const existingMentions: string[] = (state as Record<string, unknown>).passive_mentions as string[] || []
    const updatedMentions = [...existingMentions.slice(-4), passiveMention] // keep last 5
    await saveGroupState(db, group.id, { passive_mentions: updatedMentions } as Record<string, unknown>)
    debugDispatchComplete(null)
    return null
  }

  // L2 — Classify
  let classification
  try {
    classification = await classify(gate.stripped_message, senderName, members, state, replyText)
  } catch (err) {
    debugError('Dispatcher — Classifier threw', err)
    const briefing = buildErrorBriefing('Classifier failed', senderName, group.group_mode)
    return generateReply(briefing)
  }

  // ── Handle pending confirmation (resolve yes/no to stored actions) ──────────
  if (state.pending_confirmation && classification.status === 'social') {
    const subtype = (classification as { status: 'social'; subtype: string }).subtype
    if (subtype === 'confirmation_yes') {
      debugPendingConfirmation(subtype, 'yes')
      // Execute the stored pending actions
      const pending = state.pending_confirmation
      const results: ExecutorResult[] = []
      for (const action of pending.parsed_actions) {
        debugEngineCall(action.name, action.parameters as Record<string, unknown>)
        const result = await executeFunction(action, group.id, members, senderId, senderName, state, messageId, messageDate, replyToIsBot || false)
        debugEngineResult(action.name, result)
        // Bug 1: ensure state_updates has pending_confirmation: null
        if (result.success) {
           result.state_updates.pending_confirmation = null
        }
        results.push(result)
      }
      const allGood = results.every(r => r.success)
      const combined = allGood
        ? results.map(r => { const d = r.data as Record<string, unknown>; return (d?.description as string) || '' }).filter(Boolean).join(', ')
        : results.find(r => !r.success)?.error || 'Error'

      const stateUpdate = results.find(r => Object.keys(r.state_updates).length > 0)?.state_updates || {}
      await saveGroupState(db, group.id, { ...stateUpdate, pending_confirmation: null })

      const briefing = buildSocialBriefing('confirmation_yes', allGood ? `Done! Logged: ${combined}` : combined, state, hotMemory, senderName, members, group.group_mode)
      debugBriefing(briefing)
      debugReplyStart()
      const reply = await generateReply(briefing)
      debugReplyResult(reply)
      addMessage(chatId, { role: 'assistant', text: reply, timestamp: Math.floor(Date.now() / 1000) })
      debugDispatchComplete(reply)
      return reply
    }

    if (subtype === 'confirmation_no') {
      debugPendingConfirmation(subtype, 'no')
      await saveGroupState(db, group.id, { pending_confirmation: null })
      const briefing = buildSocialBriefing('confirmation_no', 'Cancelled. Nothing was saved.', state, hotMemory, senderName, members, group.group_mode)
      debugBriefing(briefing)
      debugReplyStart()
      const reply = await generateReply(briefing)
      debugReplyResult(reply)
      addMessage(chatId, { role: 'assistant', text: reply, timestamp: Math.floor(Date.now() / 1000) })
      debugDispatchComplete(reply)
      return reply
    }
  }

  // ── Handle multi-action (ask confirmation before executing) ─────────────────
  if (classification.status === 'multi') {
    const confirmMsg = classification.confirmation_message
    await saveGroupState(db, group.id, {
      pending_confirmation: {
        asked_by_bot: confirmMsg,
        parsed_actions: classification.actions,
        waiting_since: new Date().toISOString()
      }
    })
    addMessage(chatId, { role: 'assistant', text: confirmMsg, timestamp: Math.floor(Date.now() / 1000) })
    debugDispatchComplete(confirmMsg)
    return confirmMsg
  }

  // ── Handle ambiguous (ask before doing anything) ────────────────────────────
  if (classification.status === 'ambiguous') {
    const question = classification.question
    await saveGroupState(db, group.id, {
      pending_confirmation: {
        asked_by_bot: question,
        parsed_actions: classification.options,
        waiting_since: new Date().toISOString()
      }
    })
    addMessage(chatId, { role: 'assistant', text: question, timestamp: Math.floor(Date.now() / 1000) })
    debugDispatchComplete(question)
    return question
  }

  // ── Handle social ────────────────────────────────────────────────────────────
  if (classification.status === 'social') {
    const replyHint = (classification as { status: 'social'; reply_hint: string }).reply_hint
    const subtype = (classification as { status: 'social'; subtype: string }).subtype
    const briefing = buildSocialBriefing(subtype, replyHint, state, hotMemory, senderName, members, group.group_mode)
    debugBriefing(briefing)
    debugReplyStart()
    const reply = await generateReply(briefing)
    debugReplyResult(reply)
    addMessage(chatId, { role: 'assistant', text: reply, timestamp: Math.floor(Date.now() / 1000) })
    debugDispatchComplete(reply)
    return reply
  }

  // ── Handle ignore ────────────────────────────────────────────────────────────
  if (classification.status === 'ignore') {
    debugDispatchComplete(null)
    return null
  }

  // ── L3 — Execute (single function call) ─────────────────────────────────────
  if (classification.status !== 'single') return null

  const fnCall: FunctionCall = classification.function

  // Name resolution
  const nameResolution = resolveNames(fnCall, members, state.name_aliases)
  debugNameResolution(nameResolution, members)
  if (nameResolution.has_ambiguous_names) {
    const clarification = buildNameClarificationMessage(nameResolution.ambiguous_names)
    await saveGroupState(db, group.id, {
      pending_confirmation: {
        asked_by_bot: clarification,
        parsed_actions: [fnCall],
        waiting_since: new Date().toISOString()
      }
    })
    addMessage(chatId, { role: 'assistant', text: clarification, timestamp: Math.floor(Date.now() / 1000) })
    debugDispatchComplete(clarification)
    return clarification
  }

  // Save any new aliases discovered during resolution
  if (Object.keys(nameResolution.new_aliases).length > 0) {
    await saveGroupState(db, group.id, {
      name_aliases: { ...state.name_aliases, ...nameResolution.new_aliases }
    })
  }

  debugEngineCall(nameResolution.resolved_call.name, nameResolution.resolved_call.parameters as Record<string, unknown>)
  const executorResult = await executeFunction(
    nameResolution.resolved_call,
    group.id,
    members,
    senderId,
    senderName,
    state,
    messageId,
    messageDate,
    replyToIsBot || false
  )
  debugEngineResult(nameResolution.resolved_call.name, executorResult)

  // Bug 1 Fix: Clear pending confirmation deadlock automatically upon any successful new command
  if (executorResult.success) {
    executorResult.state_updates.pending_confirmation = null
  }

  // ── Duplicate detected — ask user ───────────────────────────────────────────
  if (!executorResult.success && executorResult.error?.startsWith('DUPLICATE:')) {
    const [, amount, desc] = executorResult.error.split(':')
    debugDuplicate(amount, desc)
    const dupMsg = `Looks like I already recorded Rs.${amount} "${desc}" just now — log it again?`
    await saveGroupState(db, group.id, {
      pending_confirmation: {
        asked_by_bot: dupMsg,
        parsed_actions: [fnCall],
        waiting_since: new Date().toISOString()
      }
    })
    addMessage(chatId, { role: 'assistant', text: dupMsg, timestamp: Math.floor(Date.now() / 1000) })
    debugDispatchComplete(dupMsg)
    return dupMsg
  }

  // ── Update member contributions if expense logged ────────────────────────────
  if (fnCall.name === 'log_expense' && executorResult.success) {
    const p = fnCall.parameters as Record<string, unknown>
    const payerName = (p.payer_name as string) || senderName
    executorResult.state_updates.member_contributions = updateContributions(
      state.member_contributions,
      payerName,
      p.amount as number
    )
  }

  // L4 — Brief
  const briefing = buildBriefing(
    fnCall.name,
    executorResult,
    state,
    hotMemory,
    senderName,
    members,
    group.group_mode
  )
  debugBriefing(briefing)

  // (Passive messages never reach here — they exit early above)

  // L5 — Reply
  debugReplyStart()
  const reply = await generateReply(briefing)
  debugReplyResult(reply)

  // Save state
  if (Object.keys(executorResult.state_updates).length > 0) {
    debugStateSave(group.id, executorResult.state_updates as Record<string, unknown>)
    await saveGroupState(db, group.id, executorResult.state_updates)
  }

  addMessage(chatId, { role: 'assistant', text: reply, timestamp: Math.floor(Date.now() / 1000) })
  debugDispatchComplete(reply)
  return reply
}
