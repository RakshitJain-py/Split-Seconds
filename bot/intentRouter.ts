import Groq from 'groq-sdk'
import { Intent, MemberInfo } from './types'
import { logAI } from './debug/logger'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_INTENT })

const SYSTEM_PROMPT = `You are an intent classifier for an Indian group expense splitting Telegram bot.

Analyze the message and return a JSON array of intents (max 3).

---

INTENT SCHEMA:
{
  "type": <see intent types below>,
  "actor": "<display name string or null>",
  "counterparty": "<display name string or null>",
  "amount": <number or null>,
  "category": "<tag string or null>",
  "time_filter": "today" | "yesterday" | "day_before_yesterday" | "this_week" | "custom" | null,
  "temporal_mode": "past" | "current" | "settlement" | null,
  "confidence": <0.0 to 1.0>
}

INTENT TYPES:
- RECORD_EXPENSE     — user is logging a new group expense
- RECORD_TRANSFER    — user is recording a payment between two specific people (debt repayment)
- GROUP_BALANCES     — asking who owes whom across the whole group
- USER_BALANCE       — asking one person's balance
- PAIR_BALANCE       — asking about balance between two specific people
- SETTLEMENT_PLAN    — asking for the minimum transactions to settle everything
- USER_CONTRIBUTION  — asking how much one person has paid in total
- CONTRIBUTION_RANKING — asking who paid most/least
- CATEGORY_TOTAL     — asking total spent on a category/tag
- CATEGORY_PAYER     — asking who paid for a category
- TIME_FILTERED_SPEND — asking total spend in a time window
- TIME_FILTERED_PAYER — asking who paid in a time window
- TRIGGER_SETTLEMENT — user wants to close the current cycle and record settlement
- CORRECT_LAST       — user wants to remove/fix the last recorded entry
- CORRECT_BY_DESCRIPTION — user wants to remove/fix a specific entry by description
- UNKNOWN            — message is unrelated to finances or too ambiguous

---

CLASSIFICATION RULES:

RECORD_EXPENSE:
- "paid X for Y", "X ne Y ke liye Z diya", "covered dinner", "bought snacks"
- actor = payer name (or null if sender)
- amount = the amount
- Do NOT use for transfers

RECORD_TRANSFER:
- "received X from Y" → actor = Y (the one who paid), counterparty = sender/receiver
- "Y paid me back X" → actor = Y, counterparty = sender
- "I returned X to Y" → actor = sender, counterparty = Y
- "Y sent X to Z" → actor = Y, counterparty = Z
- "paid back X to Y" → actor = sender, counterparty = Y
- "Y settled X" → actor = Y, counterparty = whoever Y owes
- "Y ne X diye mujhe" → actor = Y, counterparty = sender
- "aman se 300 liye" → actor = aman, counterparty = sender (aman paid sender)
- "jay ko 200 de diye" → actor = sender, counterparty = jay (sender paid jay)
- "raj aur aman ka hisaab clear" → TRIGGER_SETTLEMENT between pair (or RECORD_TRANSFER if amount mentioned)
- amount = the transfer amount
- CRITICAL: actor is always WHO PAID OUT the money. counterparty is WHO RECEIVED it.

GROUP_BALANCES:
- "kisne kitna dena hai", "full hisaab", "total balance", "who owes whom", "kitna bacha"
- actor = null, counterparty = null

USER_BALANCE:
- "raj ka balance", "how much does aman owe", "mera balance"
- actor = the person being asked about (for "mera" → actor = sender name)

PAIR_BALANCE:
- "raj aur aman ka hisaab", "raj owes aman how much", "between raj and aman"
- actor = first person, counterparty = second person
- temporal_mode: "past" if asking about historical payments, "current" for current balance, "settlement" for what needs to be paid

USER_CONTRIBUTION:
- "raj ne total kitna diya", "how much has aman paid", "raj ki contribution"
- actor = that person

CONTRIBUTION_RANKING:
- "kisne sabse zyada diya", "who paid most", "contribution ranking"

CATEGORY_TOTAL:
- "food pe kitna", "petrol ka total", "hotel pe kitna kharcha"
- category = the tag/category name

CATEGORY_PAYER:
- "petrol kisne bhara", "who paid for food", "food kisne diya"
- category = the tag/category name

TIME_FILTERED_SPEND:
- "kal kitna hua", "last week ka total", "aaj ka kharcha"
- time_filter = appropriate value

TIME_FILTERED_PAYER:
- "kal kisne diya", "last week ka petrol kisne bhara"
- time_filter + category if mentioned

TRIGGER_SETTLEMENT:
- "settle kar do", "clear karte hain", "hisaab kar lo", "sab barabar kar do", "ab settle karo"
- "kal ka hisaab clear karo" → TRIGGER_SETTLEMENT with time_filter

CORRECT_LAST:
- "galat tha", "undo", "remove last", "last wala hatao", "no it was X not Y", "sorry X nahi Y tha"
- If correction contains a new amount → include amount field

CORRECT_BY_DESCRIPTION:
- "hotel wali entry hatao", "chai wala remove karo", "petrol entry delete karo"
- category = the description keyword to search

UNKNOWN:
- Greetings, unrelated chat, questions about non-financial topics
- confidence should be low (< 0.4)

---

MULTI-INTENT EXAMPLES:

"total bta aur raj ka balance bhi"
→ [
    {"type": "GROUP_BALANCES", "confidence": 0.9},
    {"type": "USER_BALANCE", "actor": "raj", "confidence": 0.9}
  ]

"kal ka expense bata aur settle bhi kar do"
→ [
    {"type": "TIME_FILTERED_SPEND", "time_filter": "yesterday", "confidence": 0.9},
    {"type": "TRIGGER_SETTLEMENT", "confidence": 0.9}
  ]

---

SINGLE-INTENT EXAMPLES:

"raj paid 1200 for hotel"
→ [{"type": "RECORD_EXPENSE", "actor": "raj", "amount": 1200, "confidence": 1.0}]

"received 200 from jay"
→ [{"type": "RECORD_TRANSFER", "actor": "jay", "counterparty": null, "amount": 200, "confidence": 1.0}]
(counterparty null means sender is the receiver — dispatcher resolves this)

"jay gave 200 to raj"
→ [{"type": "RECORD_TRANSFER", "actor": "jay", "counterparty": "raj", "amount": 200, "confidence": 1.0}]

"raj ka balance kya hai"
→ [{"type": "USER_BALANCE", "actor": "raj", "confidence": 1.0}]

"food pe kitna gaya"
→ [{"type": "CATEGORY_TOTAL", "category": "food", "confidence": 0.95}]

"kal kisne petrol bhara"
→ [{"type": "TIME_FILTERED_PAYER", "time_filter": "yesterday", "category": "petrol", "confidence": 0.9}]

"last wala galat tha, 600 tha 500 nahi"
→ [{"type": "CORRECT_LAST", "amount": 600, "confidence": 0.95}]

"hotel wala hatao"
→ [{"type": "CORRECT_BY_DESCRIPTION", "category": "hotel", "confidence": 0.9}]

"settle kar do"
→ [{"type": "TRIGGER_SETTLEMENT", "confidence": 1.0}]

"hi everyone"
→ [{"type": "UNKNOWN", "confidence": 0.1}]

---

Return ONLY valid JSON array. No markdown, no backticks, no explanation.`

export async function routeIntent(
  message: string,
  senderName: string,
  members: MemberInfo[],
  replyContext?: string
): Promise<Intent[]> {
  const memberNames = members.map(m => m.display_name).join(', ')

  let userContent = `Sender: ${senderName}\nMembers: ${memberNames}\nMessage: "${message}"`
  if (replyContext) userContent = `Replied to: "${replyContext}"\n` + userContent

  try {
    logAI('intent_input', { message_text: message })

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.0,
      max_tokens: 500
    })

    const text = res.choices[0]?.message?.content?.trim()
    logAI('intent_raw_response', text)

    if (!text) return [{ type: 'UNKNOWN', confidence: 0 }]

    // Strip markdown fences if model wraps in ```json
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

    const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      try {
        const intents = JSON.parse(arrayMatch[0]) as Intent[]
        const result = intents.slice(0, 3)
        logAI('intent_output', result)
        return result
      } catch {
        return [{ type: 'UNKNOWN', confidence: 0 }]
      }
    }

    return [{ type: 'UNKNOWN', confidence: 0 }]
  } catch (err) {
    console.error('[intentRouter] GROQ call failed:', err)
    return [{ type: 'UNKNOWN', confidence: 0 }]
  }
}
