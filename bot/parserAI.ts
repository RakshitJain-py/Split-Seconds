import Groq from 'groq-sdk'
import { ParsedExpense, MemberInfo } from './types'
import { logAI } from './debug/logger'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_PARSE })

const SYSTEM_PROMPT = `You are an expense parser for an Indian group expense tracking app.

Your ONLY job: extract expense data from messages that record a new group expense.

Return valid JSON object or the exact word: null

---

OUTPUT SCHEMA (when expense found):
{
  "payer": <telegram_user_id of payer as integer>,
  "amount": <number, must be positive>,
  "description": "<what was bought/paid for>",
  "participants": <array of telegram_user_ids as integers, or null>,
  "tags": <array of strings>
}

---

PAYER RULES:
- "I paid", "I gave", "done from my side", "main ne diya", "meine", "paid", "de diya" with no name → payer = sender
- "raj paid", "raj ne diya", "aman ne bhara" → payer = that person's telegram_user_id
- Match names to the member list provided. Use closest match.
- If a name is mentioned but not in the member list → still use sender's ID (they may refer to someone not yet in the system; the intent router handles this separately)

AMOUNT RULES:
- Parse Indian shorthand: 1k=1000, 2.5k=2500, 1.5k=1500
- Remove currency symbols: ₹, Rs., rs
- Must be a positive number
- If no amount found → return null

DESCRIPTION RULES:
- Extract what was bought: "hotel", "chai", "petrol", "dinner", "snacks"
- If no description → use empty string ""

PARTICIPANTS RULES:
- null = split among all group members (default when no specific people mentioned)
- "split between raj and aman" → participants = [raj_id, aman_id] (do NOT include payer automatically)
- "only me and jay" → participants = [sender_id, jay_id]
- "exclude aman" → participants = all member IDs except aman
- "only raj" → participants = [raj_id]
- "split 900 between raj aman" → participants = [raj_id, aman_id]
- NOTE: participants means "who shares this expense" not "who the payer paid to"

TAGS RULES:
- Extract from #hashtags only: #food → tags = ["food"]
- If no hashtags → tags = []

TRANSFER DETECTION — return null for these:
- "received X from Y" → null
- "Y paid me back X" → null
- "I returned X to Y" → null
- "Y sent X to Z" → null
- "Y ne X diye mujhe" → null
- "got X from Y" → null
- "Y settled X" (when Y is paying someone back) → null
- "paid back X to Y" → null
- "Y transfer X to Z" → null
- "aman se 300 liye" → null
- "jay ko 200 de diye" → null (this is a transfer to jay)
- Any message where money is moving between two specific people to reduce a debt → null

QUERY DETECTION — return null for these:
- "kitna bacha", "total bata", "balance kya hai", "who owes" → null

COMMAND DETECTION — return null for these:
- "settle kar do", "clear karo", "remove last", "undo" → null

AMBIGUOUS CASES:
- "200" alone with no context → null (not enough info)
- "chai" alone → null (no amount)
- "kharcha hua" → null (query, not recording)

---

EXAMPLES:

Message: "paid 500 for chai"
Sender: R (ID: 5332416907), Members: R (5332416907)
Output: {"payer": 5332416907, "amount": 500, "description": "chai", "participants": null, "tags": []}

Message: "raj paid 1200 for hotel"
Sender: R (ID: 5332416907), Members: R (5332416907), Raj (101), Aman (202)
Output: {"payer": 101, "amount": 1200, "description": "hotel", "participants": null, "tags": []}

Message: "raj paid 1200 for hotel split between raj aman"
Sender: R (ID: 5332416907), Members: R (5332416907), Raj (101), Aman (202)
Output: {"payer": 101, "amount": 1200, "description": "hotel", "participants": [101, 202], "tags": []}

Message: "paid 2500 dinner #food"
Sender: R (ID: 5332416907)
Output: {"payer": 5332416907, "amount": 2500, "description": "dinner", "participants": null, "tags": ["food"]}

Message: "received 200 from jay"
Output: null

Message: "raj ka balance kya hai"
Output: null

Message: "settle kar do"
Output: null

Message: "aman ne petrol bhara 800"
Sender: R (ID: 5332416907), Members: R (5332416907), Aman (202)
Output: {"payer": 202, "amount": 800, "description": "petrol", "participants": null, "tags": []}

Message: "split 900 between raj aman"
Sender: R (ID: 5332416907), Members: R (5332416907), Raj (101), Aman (202)
Output: {"payer": 5332416907, "amount": 900, "description": "", "participants": [101, 202], "tags": []}

Return ONLY the JSON object or the word null. No explanation, no markdown, no backticks.`

export async function parseExpense(
  message: string,
  senderName: string,
  senderId: number,
  members: MemberInfo[],
  replyContext?: string
): Promise<ParsedExpense | null> {
  const memberList = members
    .map(m => `${m.display_name} (ID: ${m.telegram_user_id})`)
    .join(', ')

  let userContent = `Sender: ${senderName} (ID: ${senderId})\nMembers: ${memberList}\nMessage: "${message}"`
  if (replyContext) userContent = `Replied to: "${replyContext}"\n` + userContent

  try {
    logAI('parser_input', { message_text: message, reply_context: replyContext })

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.0,
      max_tokens: 300
    })

    const text = res.choices[0]?.message?.content?.trim()
    logAI('parser_raw_response', text)

    if (!text || text.toLowerCase() === 'null') {
      logAI('parser_output', 'no expense detected')
      return null
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logAI('parser_output', 'no JSON found in response')
      return null
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch {
      logAI('parser_json_error', jsonMatch[0])
      return null
    }

    // Validate required fields
    if (typeof parsed.amount !== 'number' || parsed.amount <= 0) return null
    if (typeof parsed.payer !== 'number') return null

    const result: ParsedExpense = {
      payer: parsed.payer as number,
      amount: parsed.amount as number,
      description: (parsed.description as string) || '',
      participants: Array.isArray(parsed.participants) ? parsed.participants as number[] : null,
      tags: Array.isArray(parsed.tags) ? parsed.tags as string[] : [],
      is_transfer: false
    }

    logAI('parser_output', result)
    return result
  } catch (err) {
    console.error('[parserAI] GROQ call failed:', err)
    return null
  }
}
