// ─────────────────────────────────────────────────────────────────────────────
// Temporary Version Step Down
// Simplified bot entry — trigger word "bolt" activation
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { customAlphabet } from 'nanoid'
import { dispatch, db, upsertMember } from './dispatcher'
import { addMessage } from './chatMemory'

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true })
const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 8)

console.log('SplitSeconds bot (Bolt mode) running...')

// ─── Trigger word detection ──────────────────────────────────────────────────

const TRIGGER_REGEX = /^@?bolt\b/i

function stripTrigger(text: string): string {
  return text.replace(TRIGGER_REGEX, '').trim()
}

function hasTrigger(text: string): boolean {
  return TRIGGER_REGEX.test(text.trim())
}

// ─── /start command ──────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id

  if (msg.chat.type === 'private') {
    await bot.sendMessage(chatId, 'Add me to a group to get started!')
    return
  }

  // Check if group already exists
  const { data: existing } = await db
    .from('groups')
    .select('id, is_linked')
    .eq('telegram_chat_id', chatId)
    .single()

  if (existing) {
    // Mark as linked if not already
    if (!existing.is_linked) {
      await db.from('groups').update({ is_linked: true }).eq('id', existing.id)
    }
    await bot.sendMessage(chatId,
      `✅ SplitSeconds (Bolt) is active!\n\nStart any message with "bolt" to log expenses or ask questions.\n\nExamples:\n• bolt raj paid 1200 for hotel\n• bolt who owes whom\n• bolt settle group`
    )
    return
  }

  // Create new group (auto-linked in step-down mode)
  await db.from('groups').insert({
    telegram_chat_id: chatId,
    name: msg.chat.title || 'My Group',
    admin_telegram_id: userId,
    is_linked: true
  })

  await bot.sendMessage(chatId,
    `🎯 SplitSeconds (Bolt) is now active!\n\nStart any message with "bolt" to log expenses or ask questions.\n\nExamples:\n• bolt raj paid 1200 for hotel\n• bolt received 200 from jay\n• bolt who owes whom\n• bolt settle group`
  )
})

// ─── Main message handler ────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  try {
    if (!msg.text) return
    if (msg.text.startsWith('/')) return
    if (msg.chat.type === 'private') return

    const senderId = msg.from?.id
    if (!senderId) return

    const senderName = msg.from?.first_name || msg.from?.username || `User${senderId}`
    const senderUsername = msg.from?.username
    const replyText = msg.reply_to_message?.text

    // ── Ensure group exists ────────────────────────────────────────────────
    let { data: group } = await db
      .from('groups')
      .select('id')
      .eq('telegram_chat_id', msg.chat.id)
      .single()

    if (!group) {
      const { data: newGroup } = await db
        .from('groups')
        .upsert({
          telegram_chat_id: msg.chat.id,
          name: msg.chat.title || 'My Group',
          is_linked: true
        }, { onConflict: 'telegram_chat_id' })
        .select('id')
        .single()
      group = newGroup
    }

    if (!group) return

    // Upsert sender as member
    await upsertMember(group.id, senderId, senderName, senderUsername)

    // ── Check for trigger word ─────────────────────────────────────────────
    if (!hasTrigger(msg.text)) {
      // No trigger word — store in memory silently, do NOT respond
      addMessage(msg.chat.id, {
        role: 'user',
        telegram_user_id: senderId,
        text: msg.text,
        message_id: msg.message_id,
        timestamp: msg.date
      })
      return
    }

    // Strip trigger word before processing
    const cleanMessage = stripTrigger(msg.text)

    if (!cleanMessage) {
      await bot.sendMessage(msg.chat.id, 'Hey! What can I help with? Try "bolt who owes whom" or "bolt raj paid 500 for dinner"', {
        reply_to_message_id: msg.message_id
      })
      return
    }

    // Dispatch to Bolt LLM
    const reply = await dispatch(
      msg.chat.id,
      cleanMessage,
      senderId,
      senderName,
      senderUsername,
      msg.message_id,
      msg.date,
      replyText
    )

    if (reply) {
      await bot.sendMessage(msg.chat.id, reply, {
        reply_to_message_id: msg.message_id
      })
    }
  } catch (err) {
    console.error('[bot] Unhandled error:', err)
  }
})
