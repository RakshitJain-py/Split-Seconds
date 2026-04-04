import Groq from 'groq-sdk'
import { Intent, MemberInfo } from './types'
import { logAI } from './debug/logger'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_INTENT })

const SYSTEM_PROMPT = `You are an intent classifier for an Indian bill-splitting bot.
Detect what the user wants. Return a JSON array of intents. Max 3 intents per message.

Each intent schema:
{
  "type": one of ["RECORD_EXPENSE","RECORD_TRANSFER","GROUP_BALANCES","USER_BALANCE","PAIR_BALANCE","SETTLEMENT_PLAN","USER_CONTRIBUTION","CONTRIBUTION_RANKING","CATEGORY_TOTAL","CATEGORY_PAYER","TIME_FILTERED_SPEND","TIME_FILTERED_PAYER","TRIGGER_SETTLEMENT","CORRECT_LAST","CORRECT_BY_DESCRIPTION","UNKNOWN"],
  "actor": "<name or null>",
  "counterparty": "<name or null>",
  "category": "<tag or null>",
  "time_filter": "today" | "yesterday" | "this_week" | "custom" | null,
  "temporal_mode": "past" | "current" | "settlement" | null,
  "confidence": <0.0 to 1.0>
}

Rules:
- Do NOT compute numbers. Only classify intent.
- If message contains an expense statement → RECORD_EXPENSE.
- "settle kar do", "clear karte hain" → TRIGGER_SETTLEMENT.
- "kitna kharcha", "total bata" → GROUP_BALANCES.
- "raj ka balance" → USER_BALANCE with actor="raj".
- "raj aur priya ka hisaab" → PAIR_BALANCE with actor="raj", counterparty="priya".
- "food pe kitna" → CATEGORY_TOTAL with category="food".
- "kal kisne petrol bhara" → TIME_FILTERED_PAYER with time_filter="yesterday", category="petrol".
- "last wala galat tha" → CORRECT_LAST.
- If unsure → UNKNOWN with low confidence.`

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
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1,
      max_tokens: 400
    })

    const text = res.choices[0]?.message?.content?.trim()
    logAI('intent_raw_response', text)

    if (!text) return [{ type: 'UNKNOWN', confidence: 0 }]

    let intents: Intent[]
    const arrayMatch = text.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      try {
        intents = JSON.parse(arrayMatch[0]) as Intent[]
      } catch (jsonErr) {
        logAI('intent_json_parse_error', { raw: arrayMatch[0], error: String(jsonErr) })
        return [{ type: 'UNKNOWN', confidence: 0 }]
      }
      const result = intents.slice(0, 3)
      logAI('intent_output', result)
      return result
    }

    const objMatch = text.match(/\{[\s\S]*\}/)
    if (objMatch) {
      try {
        const single = JSON.parse(objMatch[0]) as Intent
        logAI('intent_output', [single])
        return [single]
      } catch (jsonErr) {
        logAI('intent_json_parse_error', { raw: objMatch[0], error: String(jsonErr) })
        return [{ type: 'UNKNOWN', confidence: 0 }]
      }
    }

    logAI('intent_output', 'no array or object found in response')
    return [{ type: 'UNKNOWN', confidence: 0 }]
  } catch (err) {
    console.error('[intentRouter] GROQ call failed:', err)
    logAI('intent_error', String(err))
    return [{ type: 'UNKNOWN', confidence: 0 }]
  }
}
