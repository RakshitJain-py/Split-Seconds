// ─────────────────────────────────────────────────────────────────────────────
// Temporary Version Step Down
// Single LLM ("Bolt") — replaces parserAI, intentRouter, engines, chatLLM
// ─────────────────────────────────────────────────────────────────────────────

import Groq from 'groq-sdk'
import { ChatMessage, MemberInfo, DBExpense } from './types'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_CHAT })

// ─── Response Schema ─────────────────────────────────────────────────────────

export type BoltResponse = {
  action: 'log_expense' | 'transfer' | 'settle' | 'query' | 'correction' | 'none'
  expense?: {
    payer_name: string
    amount: number
    participants: string[]
    description: string
    tags: string[]
  }
  transfer?: {
    from: string
    to: string
    amount: number
  }
  correction?: {
    type: 'delete_last' | 'update_amount'
    new_amount?: number
  }
  reply: string
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Bolt, a concise expense-splitting assistant in a Telegram group chat.

You receive:
- The current message (trigger word "bolt" already stripped)
- Recent chat history for context
- List of group members with their names
- All unsettled expenses currently stored in the database

You must ALWAYS respond with a valid JSON object. Never respond with plain text.

─── JSON SCHEMA ───

{
  "action": "log_expense" | "transfer" | "settle" | "query" | "correction" | "none",
  "expense": {
    "payer_name": "<name of who paid>",
    "amount": <positive number>,
    "participants": ["<name1>", "<name2>"],
    "description": "<what was bought>",
    "tags": ["<tag1>"]
  },
  "transfer": {
    "from": "<name of person who sent money>",
    "to": "<name of person who received money>",
    "amount": <positive number>
  },
  "correction": {
    "type": "delete_last" | "update_amount",
    "new_amount": <number or omit>
  },
  "reply": "<natural language reply to send in chat>"
}

Only include the relevant sub-object for the action. Always include "action" and "reply".

─── ACTION RULES ───

LOG_EXPENSE (action = "log_expense"):
When someone records a group expense.
Examples:
- "raj paid 1200 for hotel" → payer_name: "raj", amount: 1200, description: "hotel", participants: [] (empty = split among all)
- "paid 500 for chai" → payer_name = sender (I'll tell you who sent it), amount: 500
- "raj paid 900 for dinner split between raj and aman" → participants: ["raj", "aman"]
- "aman ne petrol bhara 800" → payer_name: "aman", amount: 800, description: "petrol"
- "split 900 between raj aman" → payer_name = sender, participants: ["raj", "aman"]
- "paid 2500 dinner #food" → tags: ["food"]

Rules:
- If no payer name mentioned, payer = the sender
- If no participants listed, participants = [] (means everyone in group shares)
- Parse Indian shorthand: 1k=1000, 2.5k=2500
- Remove currency symbols: ₹, Rs., rs
- participants = WHO SHARES THE COST, not who the payer paid to
- tags only from #hashtags
- Amount MUST be a positive number. If you can't find a valid amount, action = "none"

TRANSFER (action = "transfer"):
When money moves between two people to settle a debt.
Examples:
- "received 200 from jay" → from: "jay", to: sender
- "jay paid me back 300" → from: "jay", to: sender
- "I returned 500 to aman" → from: sender, to: "aman"
- "jay gave 200 to raj" → from: "jay", to: "raj"
- "jay ko 200 de diye" → from: sender, to: "jay"
- "aman se 300 liye" → from: "aman", to: sender

Rules:
- "from" = person who PAID OUT money
- "to" = person who RECEIVED money
- Amount must be positive

SETTLE (action = "settle"):
When user wants to close the current expense cycle and mark everything settled.
Examples:
- "settle group", "settle karo", "clear karte hain", "sab barabar karo", "hisaab kar lo"

For settle, look at the expenses data I provide. Calculate:
1. Each person's net balance = (total they paid) - (total they owe as participant)
2. If participants is empty array, expense is split among ALL members equally
3. List who owes whom and how much
Include the settlement summary in your reply.

QUERY (action = "query"):
When user asks about balances, totals, or history. DO NOT modify data.
Examples:
- "who owes whom" / "kisne kitna dena hai" → compute balances from expense data
- "raj balance" / "raj ka balance" → compute raj's net position
- "total spent" / "total kitna hua" → sum all expense amounts
- "how much on food" → filter by tags

For ALL query responses, you MUST compute the answer from the expense data I provide:
1. For balances: net = (what person paid) - (their share of all expenses they participated in)
   - If participants is empty [], ALL members share that expense equally
   - If participants has names, only those people share it
2. For totals: sum the amounts
3. Positive balance = person is owed money (paid more than their share)
4. Negative balance = person owes money (paid less than their share)

CORRECTION (action = "correction"):
When user wants to fix or remove an entry.
Examples:
- "undo", "remove last", "galat tha", "last wala hatao" → type: "delete_last"
- "no it was 600 not 500", "amount 600 tha" → type: "update_amount", new_amount: 600

NONE (action = "none"):
For greetings, general chat, unclear messages, or when you can't determine intent.
Always still provide a friendly reply.
- "I may have misunderstood, could you rephrase?" if genuinely unsure

─── TONE ───

- Concise, natural, human
- English only
- Use Rs. for currency (not ₹ symbol)
- "Got it" over "Confirmed". "All even!" over "Balance is zero."
- One-liner confirmations for expenses: "Logged Rs.1200 hotel, split between Raj and Aman."
- Never say "according to my records" or "I calculated"
- Never hallucinate numbers. Only use amounts from the message or the expense data provided.

─── IMPORTANT ───

- ALWAYS return valid JSON. No markdown, no backticks wrapping the JSON, no explanation outside JSON.
- If you're unsure about an amount or intent, set action to "none" and ask in reply.
- Never invent expense data that wasn't in the message or provided data.`

// ─── Main Function ───────────────────────────────────────────────────────────

export async function callBolt(
  message: string,
  senderName: string,
  history: ChatMessage[],
  members: MemberInfo[],
  expenses: DBExpense[]
): Promise<BoltResponse> {

  const memberList = members.map(m => m.display_name).join(', ')

  const recentHistory = history.slice(-10).map(m =>
    m.role === 'user' ? `${m.text}` : `Bolt: ${m.text}`
  ).join('\n')

  const expenseList = expenses.length === 0
    ? 'No expenses recorded yet.'
    : expenses.map(e => {
        const parts = e.participants && e.participants.length > 0
          ? `split among IDs: [${e.participants.join(', ')}]`
          : 'split among everyone'
        const tags = e.tags && e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''
        return `- Rs.${e.amount} "${e.description || 'unnamed'}" paid by ${e.payer_display_name || 'unknown'} (ID:${e.payer_telegram_user_id}), ${parts}${tags}`
      }).join('\n')

  const userContent = `Sender: ${senderName}
Group members: ${memberList || 'none yet'}

Recent chat:
${recentHistory || '(no history)'}

Current unsettled expenses:
${expenseList}

Message: "${message}"`

  try {
    console.log('[bolt] Calling LLM...')

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2,
      max_tokens: 600
    })

    const text = res.choices[0]?.message?.content?.trim()
    console.log('[bolt] Raw LLM response:', text)

    if (!text) {
      return { action: 'none', reply: 'Something went wrong, try again.' }
    }

    // Strip markdown fences if model wraps in ```json
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error('[bolt] No JSON found in response')
      return { action: 'none', reply: text }
    }

    const parsed = JSON.parse(jsonMatch[0]) as BoltResponse

    // Validate action
    const validActions = ['log_expense', 'transfer', 'settle', 'query', 'correction', 'none']
    if (!validActions.includes(parsed.action)) {
      parsed.action = 'none'
    }

    if (!parsed.reply) {
      parsed.reply = 'Done.'
    }

    return parsed
  } catch (err) {
    console.error('[bolt] LLM call failed:', err)
    return { action: 'none', reply: 'Had trouble thinking, try again in a moment.' }
  }
}
