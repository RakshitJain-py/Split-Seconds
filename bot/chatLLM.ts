import Groq from 'groq-sdk'
import { ChatMessage, EngineResult, MemberInfo } from './types'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_CHAT })

const SYSTEM_PROMPT = `You are a friendly Indian bill-splitting assistant in a Telegram group.

Rules:
- Respond naturally in English. Keep it casual and friendly.
- You will receive structured data from the system. Use ONLY those numbers.
- NEVER modify, calculate, or invent numbers.
- NEVER generate amounts not present in the data.
- Use member names from the data provided.
- If confused, say: "wait, I didn't get that — say again?"
- Do NOT produce robotic help menus.
- Keep responses concise — this is Telegram, not an essay.
- Use Rs. for currency amounts.
- If settlement triggered, summarize the transactions clearly.
- If no data available, say so naturally.`

export async function generateReply(
  userMessage: string,
  senderName: string,
  engineResults: EngineResult[],
  conversationHistory: ChatMessage[],
  members: MemberInfo[],
  replyContext?: string
): Promise<string> {
  const memberMap = members.map(m => `${m.display_name} (ID: ${m.telegram_user_id})`).join(', ')

  const historyMessages = conversationHistory.slice(-10).map(msg => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.text
  }))

  const dataContext = engineResults.length > 0
    ? `\n\nSystem data (use ONLY these numbers):\n${engineResults.map(r => r.summary).join('\n')}`
    : ''

  const replyCtx = replyContext ? `\n\nUser is replying to: "${replyContext}"` : ''

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: SYSTEM_PROMPT + `\n\nGroup members: ${memberMap}` },
    ...historyMessages,
    { role: 'user', content: `${senderName}: "${userMessage}"${replyCtx}${dataContext}` }
  ]

  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages,
      temperature: 0.6,
      max_tokens: 500
    })
    const reply = res.choices[0]?.message?.content?.trim() || "wait, I didn't get that — say again?"
    return reply
  } catch (err) {
    console.error('[chatLLM] GROQ call failed:', err)
    return "something went wrong on my end, try again in a sec"
  }
}
