// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — L4 Briefer
// Pure TypeScript context assembler. NO LLM calls. NO side effects.
// Turns engine results + state into a clean BriefingPacket for L5.
// ─────────────────────────────────────────────────────────────────────────────

import { BriefingPacket, ClassifierResult, ExecutorResult, GroupState, ChatMessage, MemberInfo } from './types'

// ── Tone guide by group mode and action ─────────────────────────────────────

function getToneGuide(groupMode: string, functionName: string, success: boolean): string {
  if (!success) {
    return 'Apologetic but helpful. Offer what went wrong and suggest next step. One sentence.'
  }

  const base = groupMode === 'family'
    ? 'Warm, neutral. Never say "you owe". Use "has covered" instead of "owes". No judgment.'
    : 'Casual, direct. Use first names. Light and conversational. Short.'

  if (functionName.startsWith('log_') || functionName.startsWith('correct_')) {
    return `${base} Confirm what was done. One line is enough.`
  }
  if (functionName.startsWith('query_')) {
    return `${base} Facts first. No fluff. Clear numbers.`
  }
  if (functionName === 'trigger_settlement') {
    return `${base} Celebratory but brief. List who pays whom. Fresh start note.`
  }
  if (functionName === 'conversational') {
    return `${base} Match the energy of the message. Don't be robotic.`
  }
  return base
}

// ── Build conversation context from hot memory + GroupState ─────────────────

function buildConversationContext(
  hotMemory: ChatMessage[],
  state: GroupState,
  members: MemberInfo[]
): string {
  const parts: string[] = []

  if (state.last_action) {
    parts.push(`Last action: ${state.last_action.summary}`)
  }

  if (state.last_settlement_at) {
    const d = new Date(state.last_settlement_at)
    parts.push(`Last settled: ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`)
  }

  const memberCount = members.filter(m => m.telegram_user_id > 0).length
  parts.push(`${memberCount} member${memberCount !== 1 ? 's' : ''} in group`)

  // Last 2 messages for context
  const recentMsgs = hotMemory.slice(-4).filter(m => m.role === 'user')
  if (recentMsgs.length > 0) {
    const msgSummary = recentMsgs.map(m => `"${m.text}"`).join(', ')
    parts.push(`Recent: ${msgSummary}`)
  }

  return parts.join('. ')
}

// ── Build what_happened summary from executor result ────────────────────────

function buildWhatHappened(functionName: string, result: ExecutorResult): string {
  if (!result.success) {
    return `Failed: ${result.error || 'Unknown error'}`
  }

  const data = result.data as Record<string, unknown>

  switch (functionName) {
    case 'log_expense':
      return `Logged expense: ${data.payer_name} paid Rs.${data.amount} for "${data.description}"`

    case 'log_transfer':
      return `Logged transfer: ${data.from_name} → ${data.to_name} Rs.${data.amount}`

    case 'query_balance_group': {
      const balances = data.balances as { name: string; balance: number }[]
      const settlements = data.settlements as { from_name: string; to_name: string; amount: number }[]
      const singleMember = (balances || []).filter(b => Math.abs(b.balance) > 0.01).length === 0
      if (singleMember || (balances || []).length <= 1) {
        return `Only one member in group or no unsettled expenses.`
      }
      const settleStr = (settlements || []).map(s => `${s.from_name} pays ${s.to_name} Rs.${Math.round(s.amount)}`).join('; ')
      return `Group balance computed. ${settleStr || 'Everyone is even.'}`
    }

    case 'query_balance_user': {
      const owes = data.owes_to as { name: string; amount: number }[]
      const owed = data.owed_by as { name: string; amount: number }[]
      const net = data.net_balance as number
      const name = data.user_name as string

      let statement = ""
      if (Math.abs(net) < 0.01) {
        statement = "is all settled up"
      } else if (net > 0) {
        const payers = (owed || []).map(o => `${o.name} owes them Rs.${Math.round(o.amount)}`).join(', ')
        statement = `is owed Rs.${Math.round(net)} total (specifically: ${payers})`
      } else {
        const recipients = (owes || []).map(o => `${o.name} Rs.${Math.round(o.amount)}`).join(', ')
        statement = `owes Rs.${Math.round(Math.abs(net))} total (specifically: to ${recipients})`
      }

      return `${name}'s balance: ${name} ${statement}.`
    }

    case 'query_balance_pair':
      return `Between ${data.user_a} and ${data.user_b}: ${data.net === 0 ? 'even' : `${data.direction} Rs.${Math.round(data.net as number)}`}`

    case 'query_contribution': {
      const contribs = data.contributions as { name: string; amount: number }[]
      if (data.user_name) {
        return `${data.user_name} contributed Rs.${data.amount} total out of group's Rs.${data.total_group}.`
      }
      return `Contribution ranking: ${(contribs || []).map((c, i) => `${i + 1}. ${c.name} Rs.${c.amount}`).join(', ')}`
    }

    case 'query_total_spent':
      return `Total group spending: Rs.${data.total} across ${data.count} expenses.`

    case 'query_category':
      return `Tag "${data.tag}": Rs.${data.total} across ${data.count} expenses.`

    case 'query_time': {
      const exps = data.expenses as { description: string; amount: number }[]
      return `${data.time_filter}: Rs.${data.total} across ${data.count} expenses. ${(exps || []).slice(0, 3).map(e => `${e.description} Rs.${e.amount}`).join(', ')}`
    }

    case 'query_expense_list': {
      const exps = data.expenses as { description: string; amount: number; payer: string }[]
      return `${data.count} unsettled expenses. Recent: ${(exps || []).slice(0, 5).map(e => `${e.payer}: Rs.${e.amount} "${e.description}"`).join('; ')}`
    }

    case 'query_settlement_history': {
      const history = data.history as { date: string; total: number; transactions: { from_name: string; to_name: string; amount: number }[] }[]
      if (!history || history.length === 0) return 'No past settlements found.'
      const last = history[0]
      return `Last settlement on ${last.date}: total Rs.${last.total}. Transactions: ${last.transactions.map(t => `${t.from_name} → ${t.to_name} Rs.${t.amount}`).join(', ')}`
    }

    case 'trigger_settlement': {
      const settles = data.settlements as { from_name: string; to_name: string; amount: number }[]
      if (data.all_even) return `Settlement done — everyone was even! Total: Rs.${data.total}`
      return `Settled! Total Rs.${data.total}. Pay: ${(settles || []).map(s => `${s.from_name} → ${s.to_name} Rs.${Math.round(s.amount)}`).join(', ')}`
    }

    case 'correct_delete_last':
      return `Removed: Rs.${data.removed_amount} "${data.removed_description}" by ${data.removed_payer}`

    case 'correct_delete_specific':
      return `Removed: Rs.${data.removed_amount} "${data.removed_description}"`

    case 'correct_delete_all_matching': {
      const count = data.count as number
      return `Removed ${count} expense${count !== 1 ? 's' : ''} matching "${data.description_hint}". Total removed: Rs.${data.total_removed}`
    }

    case 'correct_update_amount':
      return `Updated "${data.description}" from Rs.${data.old_amount} to Rs.${data.new_amount}`

    case 'correct_update_payer':
      return `Changed payer of "${data.description}" from ${data.old_payer} to ${data.new_payer}`

    case 'correct_update_participants':
      return `Updated split of "${data.description}" to: ${data.new_participants}`

    case 'change_name':
      return `Bot name changed to "${data.new_name}"`

    default:
      return `${functionName} executed.`
  }
}

// ── Build instruction for reply generator ───────────────────────────────────

function buildInstruction(functionName: string, result: ExecutorResult, senderName: string): string {
  if (!result.success) {
    return `Tell ${senderName} something went wrong (${result.error || 'unknown error'}) and suggest what to try.`
  }

  const data = result.data as Record<string, unknown>

  switch (functionName) {
    case 'log_expense':
      return `Confirm to the group that the expense was logged. Be brief.`

    case 'log_transfer':
      return `Confirm the transfer was recorded. One line.`

    case 'query_balance_group': {
      const balances = data.balances as { name: string; balance: number }[]
      const uniqueActive = (balances || []).filter(b => Math.abs(b.balance) > 0.01)
      if (uniqueActive.length === 0) {
        return `Tell the group everyone is even. Keep it short and celebratory.`
      }
      const memberCount = (balances || []).length
      if (memberCount <= 1) {
        return `Tell them there's only one member so no balances to show yet.`
      }
      return `Show the group's balance. List who owes whom and to-settle transactions. Use key_values exactly.`
    }

    case 'query_balance_user': {
      const net = data.net_balance as number
      const userName = data.user_name as string
      if (Math.abs(net) < 0.01) {
        return `Tell ${senderName} that ${userName} is all settled up.`
      }
      return `Tell ${senderName} about ${userName}'s balance. Lead with net amount, then breakdown of who they owe and who owes them.`
    }

    case 'query_balance_pair':
      return `Tell the result of the balance check between the two people. Use key_values.`

    case 'query_contribution':
      return `Share the contribution info. If ranking, make it feel like a leaderboard. Keep it light.`

    case 'query_total_spent':
      return `State the total amount the group has spent. Do not mention balances or debts.`

    case 'query_category':
      return `Report how much was spent on that category. Include count if more than one.`

    case 'query_time':
      return `Summarize expenses for that time period. Total first, then a few examples.`

    case 'query_expense_list':
      return `List the expenses cleanly. Number them if more than 3.`

    case 'query_settlement_history':
      return `Tell the user about the past settlement. Include date, total, and who paid whom.`

    case 'trigger_settlement': {
      const allEven = data.all_even as boolean
      const count = data.count as number
      if (allEven) return `Tell group settlement is done, everyone was even.`
      return `Announce the settlement. List who pays whom. ${count} expenses cleared. Mark it as a fresh start.`
    }

    case 'correct_delete_last':
    case 'correct_delete_specific':
    case 'correct_delete_all_matching':
      return `Confirm what was removed. One sentence.`

    case 'correct_update_amount':
    case 'correct_update_payer':
    case 'correct_update_participants':
      return `Confirm what was changed. Show old → new.`

    case 'change_name':
      return `Confirm the bot's new name in a fun way.`

    case 'conversational':
      return `Respond naturally to the message. Match the energy. reply_hint: ${(data.reply_hint as string) || ''}`

    default:
      return `Reply naturally based on what happened.`
  }
}

// ── Main briefer entry point ─────────────────────────────────────────────────

export function buildBriefing(
  functionName: string,
  executorResult: ExecutorResult,
  state: GroupState,
  hotMemory: ChatMessage[],
  senderName: string,
  members: MemberInfo[],
  groupMode?: string
): BriefingPacket {
  const mode = groupMode || 'trip'
  const data = { ... (executorResult.data as Record<string, unknown> || {}) }

  // Bug 3 Fix: Feed explicit polarity statement to LLM and PRUNE numeric data
  if (functionName === 'query_balance_user') {
    const net = data.net_balance as number;
    const name = data.user_name as string;
    const owes = data.owes_to as { name: string; amount: number }[]
    const owed = data.owed_by as { name: string; amount: number }[]

    if (name !== undefined) {
      let statement = ""
      if (Math.abs(net || 0) < 0.01) {
        statement = `${name} is all settled up. Rs.0 balance.`
      } else if (net > 0) {
        const payers = (owed || []).map(o => `${o.name} owes them Rs.${Math.round(o.amount)}`).join(', ')
        statement = `${name} is owed Rs.${Math.round(net)} total. Specifically: ${payers}.`
      } else {
        const recipients = (owes || []).map(o => `Rs.${Math.round(o.amount)} to ${o.name}`).join(', ')
        statement = `${name} owes Rs.${Math.round(Math.abs(net))} total. Specifically: ${recipients}.`
      }
      data.net_statement = statement

      // CRITICAL: Delete raw numbers so LLM cannot hallucinate its own math/direction
      delete data.net_balance;
      delete data.owes_to;
      delete data.owed_by;
    }
  }

  return {
    situation: `${senderName} triggered ${functionName.replace(/_/g, ' ')}`,
    what_happened: buildWhatHappened(functionName, executorResult),
    key_values: data,
    conversation_context: buildConversationContext(hotMemory, state, members),
    group_mode: mode,
    tone_guide: getToneGuide(mode, functionName, executorResult.success),
    instruction: buildInstruction(functionName, executorResult, senderName),
    should_reply: true,
    is_confirmation_request: false
  }
}

// ── Social briefing (no executor result) ────────────────────────────────────

export function buildSocialBriefing(
  subtype: string,
  replyHint: string,
  state: GroupState,
  hotMemory: ChatMessage[],
  senderName: string,
  members: MemberInfo[],
  groupMode?: string
): BriefingPacket {
  const mode = groupMode || 'trip'
  return {
    situation: `${senderName} sent a social message (${subtype})`,
    what_happened: `No engine action. Social interaction: ${subtype}`,
    key_values: { subtype, reply_hint: replyHint },
    conversation_context: buildConversationContext(hotMemory, state, members),
    group_mode: mode,
    tone_guide: getToneGuide(mode, 'conversational', true),
    instruction: `Respond naturally. reply_hint: "${replyHint}". Match the energy. Don't be robotic.`,
    should_reply: true,
    is_confirmation_request: false
  }
}

// ── Error briefing ──────────────────────────────────────────────────────────

export function buildErrorBriefing(
  error: string,
  senderName: string,
  groupMode?: string
): BriefingPacket {
  return {
    situation: `Error occurred while processing ${senderName}'s message`,
    what_happened: `Error: ${error}`,
    key_values: { error },
    conversation_context: '',
    group_mode: groupMode || 'trip',
    tone_guide: 'Apologetic but brief. Offer to retry.',
    instruction: `Tell ${senderName} something went slightly wrong. Keep it short and friendly.`,
    should_reply: true,
    is_confirmation_request: false
  }
}
