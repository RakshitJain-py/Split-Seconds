// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds — Centralised Debug Logger
//
// ONE file owns ALL console output for the entire pipeline.
// Flip DEBUG to false to go completely silent — nothing else needs to change.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ChatMessage,
  GroupState,
  GateResult,
  ClassifierResult,
  FunctionCall,
  ExecutorResult,
  BriefingPacket,
  NameResolutionResult,
  MemberInfo,
} from './types'

// ─── Master Switch ────────────────────────────────────────────────────────────

export const DEBUG = true   // ← flip to false — silences every debug.* call below

// ─── Internal print (no-ops when DEBUG is off) ────────────────────────────────

function p(...args: unknown[]) {
  if (DEBUG) console.log(...args)
}
function pe(...args: unknown[]) {
  if (DEBUG) console.error(...args)
}

// ─── Visual helpers ───────────────────────────────────────────────────────────

const W = 70  // total width

function line(ch = '─') { return ch.repeat(W) }

function box(title: string, style: 'double' | 'single' = 'single') {
  if (style === 'double') {
    p(`\n╔${'═'.repeat(W - 2)}╗`)
    p(`║  ${title.padEnd(W - 4)}║`)
    p(`╚${'═'.repeat(W - 2)}╝`)
  } else {
    p(`\n┌${line()}┐`)
    p(`│  ${title.padEnd(W - 2)}│`)
    p(`└${line()}┘`)
  }
}

function field(label: string, value: unknown, indent = 2) {
  const pad = ' '.repeat(indent)
  const lbl = label.padEnd(20)
  const val = typeof value === 'object'
    ? JSON.stringify(value, null, 0)
    : String(value ?? '—')
  p(`${pad}${lbl}: ${val}`)
}

function divider() {
  p(`\n${'═'.repeat(W)}`)
}

function subHeader(title: string) {
  p(`\n  ── ${title} ${'─'.repeat(Math.max(0, W - title.length - 6))}`)
}

function tinyList(items: string[], indent = 4) {
  const pad = ' '.repeat(indent)
  items.forEach((it, i) => p(`${pad}[${i + 1}] ${it}`))
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC DEBUG EVENTS — called from dispatcher.ts / index.ts / classifier.ts
//   one import, one call per event, all formatting stays here.
// ─────────────────────────────────────────────────────────────────────────────

// ── PARTITION — separates successive message traces ──────────────────────────

export function debugPartition() {
  if (!DEBUG) return
  p(`\n\n${'▓'.repeat(W)}`)
  p(`${'▓'.repeat(W)}\n`)
}

// ── BOT START ────────────────────────────────────────────────────────────────

export function debugBotStart() {
  if (!DEBUG) return
  box('🚀  SPLITSECONDS BOT STARTED', 'double')
  p(`  DEBUG mode : ON`)
  p(`  Listening  : Telegram polling active\n`)
}

// ── NEW MESSAGE RECEIVED ─────────────────────────────────────────────────────

export function debugMessageReceived(opts: {
  chatId: number
  chatTitle?: string
  senderId: number
  senderName: string
  senderUsername?: string
  text: string
  messageId: number
  messageDate: number
  replyText?: string
  replyToIsBot?: boolean
}) {
  if (!DEBUG) return
  debugPartition()
  box('📨  NEW MESSAGE', 'double')
  field('Chat ID',    opts.chatId)
  field('Chat Title', opts.chatTitle ?? '—')
  field('Sender',     `${opts.senderName}  (ID: ${opts.senderId})`)
  field('Username',   opts.senderUsername ? `@${opts.senderUsername}` : '—')
  field('Msg ID',     opts.messageId)
  field('Timestamp',  new Date(opts.messageDate * 1000).toLocaleTimeString('en-IN'))
  field('Text',       `"${opts.text}"`)
  if (opts.replyText) {
    field('Replying to', `"${opts.replyText.slice(0, 80)}${opts.replyText.length > 80 ? '…' : ''}"`)
    field('Reply→Bot',   opts.replyToIsBot ? 'YES' : 'no')
  }
}

// ── GROUP NOT FOUND ──────────────────────────────────────────────────────────

export function debugNoGroup(chatId: number) {
  if (!DEBUG) return
  box('⚠️  GROUP NOT FOUND')
  field('Chat ID', chatId)
  p(`  → Dispatcher returning null (no group record in DB)`)
}

// ── HOT MEMORY (chatMemory) ───────────────────────────────────────────────────

export function debugHotMemory(chatId: number, messages: ChatMessage[]) {
  if (!DEBUG) return
  box(`🧠  HOT MEMORY  (${messages.length} messages  |  chatId: ${chatId})`)
  if (messages.length === 0) {
    p(`    (empty — first message this session)`)
    return
  }
  messages.forEach((m, i) => {
    const role  = m.role.padEnd(9)
    const who   = (m.telegram_user_id ? `uid:${m.telegram_user_id}` : 'bot').padEnd(12)
    const time  = new Date((m.timestamp || 0) * 1000).toLocaleTimeString('en-IN')
    const text  = m.text.length > 55 ? m.text.slice(0, 55) + '…' : m.text
    p(`    [${String(i + 1).padStart(2)}] ${role} | ${who} | ${time} | "${text}"`)
  })
}

// ── GROUP STATE (warm memory) ─────────────────────────────────────────────────

export function debugGroupState(state: GroupState) {
  if (!DEBUG) return
  box('🗂️   GROUP STATE  (warm memory)')

  // last action
  if (state.last_action) {
    const ago = state.last_action.timestamp
      ? `  (@ ${new Date(state.last_action.timestamp).toLocaleTimeString('en-IN')})`
      : ''
    field('Last action', `${state.last_action.type} — ${state.last_action.summary}${ago}`)
  } else {
    field('Last action', 'none')
  }

  // pending confirmation
  if (state.pending_confirmation) {
    field('Pending ?',   `"${state.pending_confirmation.asked_by_bot.slice(0, 60)}…"`)
    field('Waiting for', `${state.pending_confirmation.parsed_actions.length} action(s)`)
  } else {
    field('Pending ?', 'none')
  }

  // aliases
  const aliases = Object.entries(state.name_aliases)
  field('Name aliases', aliases.length > 0
    ? aliases.map(([k, v]) => `"${k}"→"${v}"`).join(', ')
    : '{}')

  // contributions
  const contribs = Object.entries(state.member_contributions)
  field('Contributions', contribs.length > 0
    ? contribs.map(([n, a]) => `${n}: Rs.${a}`).join(', ')
    : '{}')

  field('Last settle', state.last_settlement_at
    ? new Date(state.last_settlement_at).toLocaleDateString('en-IN')
    : 'never')
}

// ── L1 — GATE ────────────────────────────────────────────────────────────────

export function debugGate(result: GateResult, originalText: string, alias: string) {
  if (!DEBUG) return
  const icon = result.decision === 'directed' ? '🟢'
             : result.decision === 'passive'  ? '🟡'
             : '🔴'
  box(`L1 ─ GATE  ${icon}  →  ${result.decision.toUpperCase()}`)
  field('Bot alias',    alias)
  field('Original msg', `"${originalText}"`)
  field('Decision',     result.decision)
  field('Stripped msg', `"${result.stripped_message}"`)
  field('Reply ctx',    result.is_reply_context ? 'YES — replying to bot' : 'no')
  if (result.decision === 'passive') {
    p(`\n    → Passive: noting in warm memory, NOT calling classifier or writing DB.`)
  }
  if (result.decision === 'ignore') {
    p(`\n    → Ignore: no further processing.`)
  }
}

// ── L2 — CLASSIFIER  Pass 1 (category) ───────────────────────────────────────

export function debugClassifierPass1Start(message: string) {
  if (!DEBUG) return
  box('L2 ─ CLASSIFIER  ·  Pass 1  →  Category')
  field('Input msg', `"${message}"`)
  p(`  → Calling Groq llama-3.3-70b-versatile (temp 0)…`)
}

export function debugClassifierPass1Result(category: string) {
  if (!DEBUG) return
  p(`  ✔  Category resolved : ${category}`)
}

// ── L2 — CLASSIFIER  Pass 2 (function + params) ──────────────────────────────

export function debugClassifierPass2Start(category: string, message: string) {
  if (!DEBUG) return
  box('L2 ─ CLASSIFIER  ·  Pass 2  →  Function & Params')
  field('Category', category)
  field('Input msg', `"${message}"`)
  p(`  → Calling Groq llama-3.3-70b-versatile (temp 0)…`)
}

export function debugClassifierPass2Result(result: ClassifierResult) {
  if (!DEBUG) return
  p(`  ✔  Status : ${result.status}`)
  if (result.status === 'single') {
    field('  Function',   result.function.name, 4)
    field('  Parameters', result.function.parameters, 4)
  } else if (result.status === 'multi') {
    p(`    Actions (${result.actions.length}):`)
    result.actions.forEach((a, i) => p(`      [${i + 1}] ${a.name}  ${JSON.stringify(a.parameters)}`))
    field('  Confirm msg', result.confirmation_message, 4)
  } else if (result.status === 'ambiguous') {
    p(`    Options (${result.options.length}):`)
    result.options.forEach((o, i) => p(`      [${i + 1}] ${o.name}  ${JSON.stringify(o.parameters)}`))
    field('  Question', result.question, 4)
  } else if (result.status === 'social') {
    field('  Subtype',    result.subtype, 4)
    field('  Reply hint', result.reply_hint, 4)
  }
}

export function debugClassifierError(raw: string, err: unknown) {
  if (!DEBUG) return
  pe(`  ✖  Classifier JSON parse FAILED`)
  pe(`     Raw LLM output : ${raw}`)
  pe(`     Error          :`, err)
}

// ── L2 — PENDING CONFIRMATION FLOW ───────────────────────────────────────────

export function debugPendingConfirmation(subtype: string, resolved: 'yes' | 'no') {
  if (!DEBUG) return
  box('L2 ─ PENDING CONFIRMATION RESOLUTION')
  field('Subtype',  subtype)
  field('Resolved', resolved === 'yes' ? 'YES → executing stored actions' : 'NO → clearing pending state')
}

// ── NAME RESOLUTION ───────────────────────────────────────────────────────────

export function debugNameResolution(resolution: NameResolutionResult, members: MemberInfo[]) {
  if (!DEBUG) return
  box('🔤  NAME RESOLUTION')
  field('Known members', members.map(m => m.display_name).join(', ') || '—')
  field('Ambiguous?',    resolution.has_ambiguous_names ? `YES (${resolution.ambiguous_names.length} name(s))` : 'no')
  if (resolution.has_ambiguous_names) {
    resolution.ambiguous_names.forEach(a => {
      const candidates = a.candidates.map(c => c.display_name).join(', ')
      p(`    "${a.input}"  →  candidates: [${candidates}]`)
    })
  }
  if (Object.keys(resolution.new_aliases).length > 0) {
    field('New aliases', resolution.new_aliases)
  }
  field('Resolved fn', resolution.resolved_call.name)
  field('Resolved params', resolution.resolved_call.parameters)
}

// ── L3 — ENGINE CALL ─────────────────────────────────────────────────────────

export function debugEngineCall(fnName: string, params: Record<string, unknown>) {
  if (!DEBUG) return
  box(`L3 ─ ENGINE  →  ${fnName}`)
  field('Function', fnName)
  if (Object.keys(params).length > 0) {
    p(`  Parameters:`)
    Object.entries(params).forEach(([k, v]) =>
      p(`    ${k.padEnd(22)}: ${JSON.stringify(v)}`)
    )
  } else {
    field('Parameters', '(none)')
  }
  p(`  → Executing deterministic engine…`)
}

// ── L3 — ENGINE RESULT ───────────────────────────────────────────────────────

export function debugEngineResult(fnName: string, result: ExecutorResult) {
  if (!DEBUG) return
  const icon = result.success ? '✅' : '❌'
  box(`L3 ─ ENGINE RESULT  ${icon}  ${fnName}`)
  field('Success', result.success)
  if (!result.success) {
    pe(`  ✖  Error : ${result.error}`)
  } else {
    // Pretty print result data
    const data = result.data as Record<string, unknown> | null
    if (data && Object.keys(data).length > 0) {
      subHeader('Result data')
      Object.entries(data).forEach(([k, v]) => {
        if (Array.isArray(v)) {
          p(`    ${k.padEnd(22)}: [${(v as unknown[]).length} items]`)
          ;(v as unknown[]).slice(0, 5).forEach((item, i) =>
            p(`      [${i}] ${JSON.stringify(item)}`)
          )
          if ((v as unknown[]).length > 5) p(`      … +${(v as unknown[]).length - 5} more`)
        } else {
          p(`    ${k.padEnd(22)}: ${JSON.stringify(v)}`)
        }
      })
    } else {
      field('Data', '(empty)')
    }
  }
  // State updates
  const su = result.state_updates
  if (su && Object.keys(su).length > 0) {
    subHeader('State updates queued')
    Object.entries(su).forEach(([k, v]) =>
      p(`    ${k.padEnd(22)}: ${JSON.stringify(v)}`)
    )
  }
}

// ── DUPLICATE DETECTED ────────────────────────────────────────────────────────

export function debugDuplicate(amount: string, desc: string) {
  if (!DEBUG) return
  box('⚠️   DUPLICATE DETECTED')
  field('Amount',      `Rs.${amount}`)
  field('Description', desc)
  p(`  → Asking user to confirm re-log.`)
}

// ── L4 — BRIEFING ─────────────────────────────────────────────────────────────

export function debugBriefing(briefing: BriefingPacket) {
  if (!DEBUG) return
  box('L4 ─ BRIEFING PACKET  →  reply generator')
  field('Situation',    briefing.situation)
  field('What happened', briefing.what_happened)
  field('Group mode',   briefing.group_mode)
  field('Tone guide',   briefing.tone_guide)
  field('Instruction',  briefing.instruction)
  field('Should reply', briefing.should_reply)
  if (briefing.key_values && Object.keys(briefing.key_values).length > 0) {
    subHeader('Key values fed to reply LLM')
    Object.entries(briefing.key_values).forEach(([k, v]) => {
      if (Array.isArray(v)) {
        p(`    ${k.padEnd(22)}: [${(v as unknown[]).length} items]  ${JSON.stringify((v as unknown[]).slice(0, 3))}${(v as unknown[]).length > 3 ? '…' : ''}`)
      } else {
        p(`    ${k.padEnd(22)}: ${JSON.stringify(v)}`)
      }
    })
  }
  if (briefing.conversation_context) {
    subHeader('Conversation context')
    p(`    ${briefing.conversation_context}`)
  }
}

// ── L5 — REPLY GENERATED ─────────────────────────────────────────────────────

export function debugReplyStart() {
  if (!DEBUG) return
  box('L5 ─ REPLY GENERATOR')
  p(`  → Calling Groq llama-3.1-8b-instant (temp 0.3)…`)
}

export function debugReplyResult(reply: string) {
  if (!DEBUG) return
  p(`  ✔  Reply generated:`)
  p(`\n  ┌${'─'.repeat(W - 2)}`)
  reply.split('\n').forEach(line => p(`  │ ${line}`))
  p(`  └${'─'.repeat(W - 2)}`)
}

export function debugReplyError(err: unknown) {
  if (!DEBUG) return
  pe(`  ✖  Reply generator FAILED:`, err)
}

// ── DISPATCH COMPLETE ─────────────────────────────────────────────────────────

export function debugDispatchComplete(reply: string | null) {
  if (!DEBUG) return
  divider()
  if (reply) {
    p(`  ✅  DISPATCH COMPLETE  →  Reply sent to Telegram`)
  } else {
    p(`  🔕  DISPATCH COMPLETE  →  No reply sent (ignored / passive / null)`)
  }
  divider()
}

// ── GENERIC ERROR ─────────────────────────────────────────────────────────────

export function debugError(context: string, err: unknown) {
  if (!DEBUG) return
  box(`❌  ERROR  —  ${context}`)
  pe(`  `, err)
}

// ── STATE SAVE ────────────────────────────────────────────────────────────────

export function debugStateSave(groupId: string, updates: Record<string, unknown>) {
  if (!DEBUG) return
  box('💾  GROUP STATE SAVE')
  field('Group ID', groupId)
  Object.entries(updates).forEach(([k, v]) =>
    p(`    ${k.padEnd(22)}: ${JSON.stringify(v).slice(0, 80)}`)
  )
}
