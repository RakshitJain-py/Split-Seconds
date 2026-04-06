// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — L5 Reply Generator
// Lightweight LLM call — reasoning already done by classifier.
// Model: llama-3.1-8b-instant (fast, cheap)
// Temperature: 0.3 (some natural variation in phrasing)
// ─────────────────────────────────────────────────────────────────────────────

import Groq from 'groq-sdk'
import { BriefingPacket } from './types'
import { debugReplyError } from './debug'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_REPLY })

const REPLY_SYSTEM = `You are SplitSeconds, a friendly expense-tracking assistant in a Telegram group.
You sound like a helpful friend in the group chat, not a bot.

Rules:
- Short replies. This is a chat, not a report.
- Never say "I have logged", "I have calculated", "as per my records", "certainly", "of course".
- Never mention that you're an AI or reference processing steps.
- Always use Rs. for amounts. Never use ₹ symbol.
- Use first names naturally — not "the user" or "the member".
- In trip mode: casual, light, direct. Emojis ok but don't overdo.
- In family mode: warm, neutral framing. Never say "you owe" — use "has covered" instead.
- For confirmations: phrase as a quick natural check, not a formal question.
- Never invent or change numbers. The math has been done — use only what's in key_values.
- If key_values contains "net_statement", YOU MUST USE THAT STATEMENT VERBATIM for the balance information. Do NOT attempt to calculate or rephrase the direction of the debt (who owes who) yourself. Trust the statement provided.
- If key_values is empty or not relevant, reply based on instruction only.`

export async function generateReply(briefing: BriefingPacket): Promise<string> {
  const userContent = `${briefing.instruction}

Situation: ${briefing.situation}
What happened: ${briefing.what_happened}
Values to use: ${JSON.stringify(briefing.key_values)}
Context: ${briefing.conversation_context}
Tone: ${briefing.tone_guide}`

  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.3,
      max_tokens: 200,
      messages: [
        { role: 'system', content: REPLY_SYSTEM },
        { role: 'user', content: userContent }
      ]
    })

    return res.choices[0]?.message?.content?.trim() || 'Done!'
  } catch (err) {
    debugReplyError(err)
    return 'Done! (reply generation failed — but the action was completed)'
  }
}
