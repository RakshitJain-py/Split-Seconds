// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — L2 Classifier
// Two-pass approach: category first (fast), then function + params (focused).
// Temperature: 0.0 — classification is deterministic reasoning, not generation.
// ─────────────────────────────────────────────────────────────────────────────

import Groq from 'groq-sdk'
import { ClassifierResult, FunctionCall, MemberInfo, GroupState } from './types'
import {
  debugClassifierPass1Start, debugClassifierPass1Result,
  debugClassifierPass2Start, debugClassifierPass2Result,
  debugClassifierError, debugError,
} from './debug'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_CLASSIFIER })

// ── Strip markdown fences from LLM responses ────────────────────────────────

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

// ── Pass 1: Category selection ───────────────────────────────────────────────

const CATEGORY_SYSTEM = `You are the classifier for SplitSeconds, a group expense-tracking Telegram bot.

Your job: Read the message and return exactly ONE category.

Categories:
- RECORD   — user is reporting money movement (expense paid, transfer, payment)
- QUERY    — user wants info from bot (balances, totals, history, past settlements)
- CORRECT  — user wants to fix/undo something already logged
- CONTROL  — user is triggering a lifecycle action (settle, change bot name)
- SOCIAL   — conversation, greetings, thanks, questions about bot, anything else

Return ONLY a JSON object: { "category": "RECORD" }
No markdown. No explanation. No backticks. Just JSON.`

async function classifyCategory(
  message: string,
  senderName: string,
  members: MemberInfo[],
  state: GroupState,
  replyText?: string
): Promise<string> {
  const memberList = members.map(m => m.display_name).join(', ')
  const lastAction = state.last_action?.summary || 'none'
  const pendingQ = state.pending_confirmation?.asked_by_bot || 'none'
  const replyCtx = replyText ? `\nUser is replying to bot message: "${replyText}"` : ''

  const userContent = `Sender: ${senderName}
Group members: ${memberList || 'none yet'}
Last bot action: ${lastAction}
Pending question from bot: ${pendingQ}${replyCtx}

Message: "${message}"`

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0,
    max_tokens: 30,
    messages: [
      { role: 'system', content: CATEGORY_SYSTEM },
      { role: 'user', content: userContent }
    ]
  })

  const raw = res.choices[0]?.message?.content || '{}'
  const parsed = JSON.parse(stripFences(raw))
  return parsed.category || 'SOCIAL'
}

// ── Pass 2 function definitions by category ──────────────────────────────────

const FUNCTION_DEFS: Record<string, string> = {
  RECORD: `Functions:

log_expense — "A person paid money for something the group shares"
  use_when: ["raj paid 1200 for hotel", "i covered dinner 2500", "aman ne petrol bhara 800", "paid 500 for chai", "split 900 between raj and aman"]
  parameters: { "payer_name": string (who paid; "I"/"main"/"meine"/"my" = sender's name), "amount": number, "description": string, "participant_names": string[] (empty = all members), "tags": string[] (only from #hashtags in message) }

log_transfer — "One person paid another directly to reduce a debt"
  use_when: ["received 200 from jay", "jay gave me 300", "i returned 500 to aman", "raj sent 1000 to aman", "aman paid me back 300", "aman se 300 liye", "jay ko 200 de diye"]
  parameters: { "from_name": string (who paid OUT), "to_name": string (who RECEIVED; null means sender received), "amount": number }`,

  QUERY: `Functions:

query_total_spent — "Get the total sum of all expenses logged (not balances, not who owes whom — just the raw total amount spent)"
  use_when: ["total spent", "kitna kharcha hua", "how much did we spend", "total expenses", "overall total", "trip ka total", "sab milake kitna hua"]
  parameters: { "time_filter": "today" or "yesterday" or "this_week" or "all" }

query_balance_group — "Who owes whom across the whole group"
  use_when: ["who owes whom", "full hisaab", "kitna bacha", "total balance", "everyone's balance", "balance dikhao"]
  parameters: {}

query_balance_user — "What is one specific person's balance"
  use_when: ["raj's balance", "raj ka balance", "how much does aman owe", "mera balance", "what do i owe", "mera kitna banta hai"]
  parameters: { "user_name": string ("mera"/"my"/"I"/"main" = sender's name) }

query_balance_pair — "Balance between exactly two people"
  use_when: ["raj aur aman ka hisaab", "between raj and aman", "raj owes aman how much"]
  parameters: { "user_a": string, "user_b": string }

query_contribution — "How much has someone paid in total (not net balance, actual amount paid)"
  use_when: ["raj ne kitna diya", "who paid most", "contribution ranking", "kisne sabse zyada diya", "aman's total payment"]
  parameters: { "user_name": string | null (null = all members ranked), "scope": "single" or "ranking" }

query_category — "Total spent on a specific tag or category"
  use_when: ["food pe kitna", "how much on petrol", "hotel total", "kitna kharcha on #food"]
  parameters: { "tag": string, "time_filter": "today" or "yesterday" or "this_week" or "all" }

query_time — "Expenses in a time window"
  use_when: ["yesterday's expenses", "kal kitna hua", "last week total", "aaj ka kharcha", "parso ka hisaab"]
  parameters: { "time_filter": "today" or "yesterday" or "day_before_yesterday" or "this_week", "user_name": string or null }

query_expense_list — "Show recent expenses"
  use_when: ["show all expenses", "what did we spend", "recent expenses", "sab expenses bata"]
  parameters: { "limit": number (default 10), "user_name": string or null }

query_settlement_history — "Show past/previous settlement or what was settled before"
  use_when: ["last settlement", "previous hisaab", "pichle settle mein kya tha", "what did we settle", "purana hisaab", "paid history"]
  parameters: {}`,

  CORRECT: `Functions:

correct_delete_last — "Remove the most recently logged expense"
  use_when: ["undo", "remove last", "last wala hatao", "cancel that", "galat tha", "ignore that", "delete last"]
  parameters: {}

correct_delete_specific — "Remove a specific expense by description"
  use_when: ["hotel wala hatao", "remove the petrol entry", "chai expense delete karo", "delete sab petrol wale"]
  parameters: { "description_hint": string }

correct_delete_all_matching — "Remove ALL expenses matching a description"
  use_when: ["remove all petrol entries", "delete sab chai wale", "clear all hotel expenses", "sab [thing] hatao"]
  parameters: { "description_hint": string }

correct_update_amount — "Change the amount of the last or specific expense"
  use_when: ["no it was 600 not 500", "actually 1200 tha", "change to 800", "600 tha 500 nahi"]
  parameters: { "new_amount": number, "description_hint": string or null (null = last expense) }

correct_update_payer — "Change who paid for an expense"
  use_when: ["that was aman not raj", "actually priya paid", "raj ne nahi aman ne diya"]
  parameters: { "new_payer_name": string, "description_hint": string or null }

correct_update_participants — "Change who shares an expense"
  use_when: ["only me and raj", "exclude aman", "split sirf raj aur priya mein", "actually just between us two"]
  parameters: { "participant_names": string[], "description_hint": string or null }`,

  CONTROL: `Functions:

trigger_settlement — "Close current expense cycle, record settlement, start fresh"
  use_when: ["settle up", "clear karte hain", "hisaab kar lo", "sab barabar kar do", "settle group", "ab settle karo", "done mark all settled"]
  parameters: {}

change_name — "Change what the bot is called in this group"
  use_when: ["/changename", "change your name to X", "ab se tera naam X hai"]
  parameters: { "new_name": string }`,

  SOCIAL: `Functions:

conversational — "Greeting, thanks, unrelated chat, question about bot, or a confirmation/rejection response to bot's question"
  use_when: ["hi bolt", "thanks", "can you do X", "yes", "no", "haan", "nahi", general conversation, answers to bot questions]
  parameters: { "subtype": "greeting" or "thanks" or "about_bot" or "unrelated" or "confirmation_yes" or "confirmation_no" }`
}

// ── Pass 2: Function selection + parameter fill ─────────────────────────────

function buildFunctionSystemPrompt(
  category: string,
  senderName: string,
  members: MemberInfo[],
  state: GroupState,
  replyText?: string
): string {
  const memberList = members.map(m => m.display_name).join(', ')
  const lastAction = state.last_action?.summary || 'none'
  const pendingQ = state.pending_confirmation?.asked_by_bot || 'none'
  const replyCtx = replyText
    ? `\nIMPORTANT: User is directly replying to this bot message: "${replyText}". Any correction/update refers to that specific expense, not the most recent one.`
    : ''

  return `You are the function classifier for SplitSeconds, a group expense bot.

Category selected: ${category}
${FUNCTION_DEFS[category] || ''}

Context:
- Sender: ${senderName}
- Group members: ${memberList || 'none yet'}
- Last bot action: ${lastAction}
- Bot pending question: ${pendingQ}${replyCtx}

Rules:
- "I"/"main"/"meine"/"my"/"mera"/"meri" always means the sender: "${senderName}"
- Never compute numbers. Only extract what's in the message.
- If one message clearly has TWO separate actions, set status="multi" with an actions array.
- If two functions are equally possible, set status="ambiguous".
- If this is a yes/no/confirmation response to the pending bot question, set status="clarification_response".
- For SOCIAL, always return status="social".
- For unsupported functions (log_promise, trigger_mark_cycle_done), return status="ignore".

Return ONLY valid JSON. No markdown. No backticks. No explanation.

Schema (return ONE of these):
{ "status": "single", "category": "${category}", "function": { "name": "function_name", "parameters": {...} } }
{ "status": "multi", "actions": [{ "name": "...", "parameters": {...} }, ...], "confirmation_message": "Got it — [summary]. Recording both?" }
{ "status": "ambiguous", "options": [{ "name": "...", "parameters": {...} }, ...], "question": "..." }
{ "status": "clarification_response", "resolves": "yes" | "no" }
{ "status": "social", "subtype": "greeting|thanks|about_bot|unrelated|confirmation_yes|confirmation_no", "reply_hint": "..." }
{ "status": "ignore" }`
}

async function classifyFunction(
  message: string,
  category: string,
  senderName: string,
  members: MemberInfo[],
  state: GroupState,
  replyText?: string
): Promise<ClassifierResult> {
  const systemPrompt = buildFunctionSystemPrompt(category, senderName, members, state, replyText)

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0,
    max_tokens: 400,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Message: "${message}"` }
    ]
  })

  const raw = res.choices[0]?.message?.content || '{}'
  const cleaned = stripFences(raw)

  try {
    const parsed = JSON.parse(cleaned)
    return parsed as ClassifierResult
  } catch (err) {
    debugClassifierError(cleaned, err)
    return { status: 'social', subtype: 'unrelated', reply_hint: 'Did not understand.' }
  }
}

// ── Main classify entry point ────────────────────────────────────────────────

export async function classify(
  message: string,
  senderName: string,
  members: MemberInfo[],
  state: GroupState,
  replyText?: string
): Promise<ClassifierResult> {
  // If there's a pending confirmation, SOCIAL subtype handles yes/no resolution
  // but we still run full classification — dispatcher checks clarification_response status

  try {
    debugClassifierPass1Start(message)
    const category = await classifyCategory(message, senderName, members, state, replyText)
    debugClassifierPass1Result(category)

    debugClassifierPass2Start(category, message)
    const result = await classifyFunction(message, category, senderName, members, state, replyText)
    debugClassifierPass2Result(result)

    return result
  } catch (err) {
    debugError('Classifier — top-level', err)
    return { status: 'social', subtype: 'unrelated', reply_hint: 'Something went wrong.' }
  }
}
