// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Gate (L1)
// Decides if a message is meant for the bot.
// Phase 1: Built but not driving routing. index.ts still uses trigger check.
// Phase 3: Gate drives routing — passive logs go through without trigger word.
// ─────────────────────────────────────────────────────────────────────────────

import { GateResult } from './types'

// ── Financial keywords for passive capture ──────────────────────────────────

const FINANCIAL_KEYWORDS = [
  'paid', 'diya', 'received', 'mila', 'liya', 'dega', 'owes',
  'balance', 'settle', 'kitna', 'total', 'transfer', 'gave', 'owe',
  'bhara', 'kharcha', 'udhar', 'hisaab', 'paisa', 'paise',
  'returned', 'de diye', 'le liye', 'sent', 'covered'
]

// ── Amount pattern — at least one number that looks like money ──────────────

const AMOUNT_PATTERN = /(?:rs\.?\s*|₹\s*)?\d+(?:\.\d{1,2})?(?:k)?/i

// ── Gate Logic ──────────────────────────────────────────────────────────────

export function evaluateGate(
  messageText: string,
  replyToIsBot: boolean,
  botAlias: string,
  botUsername?: string
): GateResult {
  const msg = messageText.trim()
  const lower = msg.toLowerCase()
  const aliasLower = botAlias.toLowerCase()

  // ── 1. Direct triggers → 'directed' ────────────────────────────────────

  // Starts with bot alias: "bolt ..." or "@bolt ..."
  if (lower.startsWith(aliasLower + ' ') || lower === aliasLower) {
    return {
      decision: 'directed',
      stripped_message: msg.replace(new RegExp(`^@?${escapeRegex(aliasLower)}\\s*`, 'i'), '').trim(),
      is_reply_context: false
    }
  }

  if (lower.startsWith('@' + aliasLower + ' ') || lower === '@' + aliasLower) {
    return {
      decision: 'directed',
      stripped_message: msg.replace(new RegExp(`^@${escapeRegex(aliasLower)}\\s*`, 'i'), '').trim(),
      is_reply_context: false
    }
  }

  // Starts with @botusername
  if (botUsername) {
    const usernameLower = botUsername.toLowerCase()
    if (lower.startsWith('@' + usernameLower + ' ') || lower === '@' + usernameLower) {
      return {
        decision: 'directed',
        stripped_message: msg.replace(new RegExp(`^@${escapeRegex(usernameLower)}\\s*`, 'i'), '').trim(),
        is_reply_context: false
      }
    }
  }

  // Contains alias + ends with "?" — question directed at bot
  if (lower.includes(aliasLower) && lower.endsWith('?')) {
    return {
      decision: 'directed',
      stripped_message: msg,
      is_reply_context: false
    }
  }

  // Reply to a bot message
  if (replyToIsBot) {
    return {
      decision: 'directed',
      stripped_message: msg,
      is_reply_context: true
    }
  }

  // ── 2. Financial passive capture → 'passive' ──────────────────────────

  const hasFinancialKeyword = FINANCIAL_KEYWORDS.some(kw => lower.includes(kw))
  const hasAmount = AMOUNT_PATTERN.test(lower)

  if (hasFinancialKeyword && hasAmount) {
    return {
      decision: 'passive',
      stripped_message: msg,
      is_reply_context: false
    }
  }

  // ── 3. Everything else → 'ignore' ─────────────────────────────────────

  return {
    decision: 'ignore',
    stripped_message: msg,
    is_reply_context: false
  }
}

// ── Utility ─────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
