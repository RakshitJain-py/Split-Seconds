import Groq from 'groq-sdk'
import { EngineResult, MemberInfo, ChatMessage } from './types'
import { logAI } from './debug/logger'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_CHAT })

const SYSTEM_PROMPT = `You are SplitSeconds, a friendly expense-splitting assistant in a Telegram group.

You receive structured data from financial engines and must format it as a natural reply.

RULES:
- Keep replies short and natural. This is a chat, not a report.
- Never change any number. Use exactly what you are given.
- Always use Rs. for amounts (not ₹ symbol, not USD, not rupees).
- Do not add disclaimers, explanations of how you work, or meta-commentary.
- Do not say "I calculated" or "according to my records" — just give the info.
- If recording an expense or transfer: one short line confirming it. Example: "Got it, Rs.500 for chai logged."
- If showing balances: list clearly, one person per line.
- If showing settlement plan: list transactions clearly.
- If a correction was made: confirm what was changed/removed.
- If an error occurred (member not found, etc.): explain briefly and naturally.
- English only for MVP. No Hinglish required.
- Sound human, not robotic. "Got it" over "Confirmed". "All even!" over "Balance is zero."`

export async function generateReply(
  originalMessage: string,
  senderName: string,
  results: EngineResult[],
  history: ChatMessage[],
  members: MemberInfo[],
  replyContext?: string
): Promise<string> {
  const summaries = results.map(r => r.summary).filter(Boolean).join('\n\n')

  const recentHistory = history.slice(-6).map(m =>
    m.role === 'user'
      ? `User: ${m.text}`
      : `Bot: ${m.text}`
  ).join('\n')

  let userContent = `Recent chat:\n${recentHistory}\n\nCurrent message: "${originalMessage}" (from ${senderName})`
  if (replyContext) userContent += `\nReplied to: "${replyContext}"`
  userContent += `\n\nEngine output:\n${summaries}`

  try {
    logAI('chatLLM_input', { context_length: history.length, summaries })

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.3,
      max_tokens: 300
    })

    const reply = res.choices[0]?.message?.content?.trim() || 'Something went wrong, try again.'
    logAI('chatLLM_output', reply)
    return reply
  } catch (err) {
    console.error('[chatLLM] GROQ call failed:', err)
    return 'Had trouble responding, try again in a moment.'
  }
}
