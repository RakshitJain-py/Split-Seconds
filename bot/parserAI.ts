import Groq from 'groq-sdk'
import { ParsedExpense, MemberInfo } from './types'
import { logAI } from './debug/logger'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_PARSE })

const SYSTEM_PROMPT = `You are an expense parser for an Indian bill-splitting app.
Extract expense info from chat messages. Return ONLY valid JSON or the word "null".

Output schema:
{
  "payer": <telegram_user_id of payer as number>,
  "amount": <number>,
  "description": "<string>",
  "participants": <array of telegram_user_ids as numbers, or null for everyone>,
  "tags": <array of strings from #hashtags>
}

Rules:
- "I paid", "I gave", "done from my side", "main", "meine" means payer is the message sender.
- Handle Indian amounts: 1k=1000, 2.5k=2500, rupee prefix is fine.
- Tags come from #hashtags in the message.
- If no expense detected, return the word null.
- participants null means split among everyone in the group.
- Match names to members using the member list provided. Return their telegram_user_id.
- If only partial name match exists (e.g. "raj" matches "Rajesh"), use closest match.
- "split between X and Y" means participants = [X_id, Y_id, payer_id].
- All monetary values must be numbers, not strings.
- Do NOT calculate or split amounts. Return the raw total amount paid.`

export async function parseExpense(
  message: string,
  senderName: string,
  senderId: number,
  members: MemberInfo[],
  replyContext?: string
): Promise<ParsedExpense | null> {
  const memberList = members.map(m => `${m.display_name} (ID: ${m.telegram_user_id})`).join(', ')

  let userContent = `Sender: ${senderName} (ID: ${senderId})\nMembers: ${memberList}\nMessage: "${message}"`
  if (replyContext) userContent = `Replied to: "${replyContext}"\n` + userContent

  try {
    logAI('parser_input', { message_text: message, reply_context: replyContext })
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1,
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
    } catch (jsonErr) {
      logAI('parser_json_parse_error', { raw: jsonMatch[0], error: String(jsonErr) })
      return null
    }

    if (typeof parsed.amount !== 'number' || parsed.amount <= 0) {
      logAI('parser_output', { reason: 'invalid amount', parsed })
      return null
    }
    if (typeof parsed.payer !== 'number') {
      logAI('parser_output', { reason: 'invalid payer', parsed })
      return null
    }

    const result = {
      payer: parsed.payer as number,
      amount: parsed.amount as number,
      description: (parsed.description as string) || '',
      participants: Array.isArray(parsed.participants) ? parsed.participants as number[] : null,
      tags: Array.isArray(parsed.tags) ? parsed.tags as string[] : []
    }
    logAI('parser_output', result)
    return result
  } catch (err) {
    console.error('[parserAI] GROQ call failed:', err)
    logAI('parser_error', String(err))
    return null
  }
}
