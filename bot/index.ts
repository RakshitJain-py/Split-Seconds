// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Bot Entry Point
// Gate now drives routing. No hardcoded trigger stripping.
// Dispatcher receives raw message — gate inside dispatcher handles all decisions.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { dispatch, db, upsertMember } from './dispatcher'
import { debugBotStart, debugMessageReceived, debugError } from './debug'

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true })

debugBotStart()

// ─── /start command ──────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id

  if (msg.chat.type === 'private') {
    await bot.sendMessage(chatId, 'Add me to a group to get started!')
    return
  }

  const { data: existing } = await db
    .from('groups')
    .select('id, is_linked, bot_alias')
    .eq('telegram_chat_id', chatId)
    .single()

  const alias = existing?.bot_alias || 'bolt'

  if (existing) {
    if (!existing.is_linked) {
      await db.from('groups').update({ is_linked: true }).eq('id', existing.id)
    }
    await bot.sendMessage(chatId,
      `✅ SplitSeconds is active!\n\nTrigger: "${alias}"\n\nExamples:\n• ${alias} raj paid 1200 for hotel\n• ${alias} who owes whom\n• ${alias} settle\n\nOr just say "raj paid 500 for chai" and I'll log it quietly 🤫`
    )
    return
  }

  await db.from('groups').insert({
    telegram_chat_id: chatId,
    name: msg.chat.title || 'My Group',
    admin_telegram_id: userId,
    is_linked: true,
    bot_alias: 'bolt',
    group_mode: 'trip'
  })

  await bot.sendMessage(chatId,
    `🎯 SplitSeconds V2 is now active!\n\nTrigger word: "bolt"\n\nExamples:\n• bolt raj paid 1200 for hotel\n• bolt who owes whom\n• bolt settle\n\nOr just chat naturally — I'll silently log clear expenses 🤫`
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
    const replyToIsBot = msg.reply_to_message?.from?.is_bot || false

    debugMessageReceived({
      chatId:        msg.chat.id,
      chatTitle:     msg.chat.title,
      senderId,
      senderName,
      senderUsername,
      text:          msg.text,
      messageId:     msg.message_id,
      messageDate:   msg.date,
      replyText,
      replyToIsBot,
    })

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
          is_linked: true,
          bot_alias: 'bolt',
          group_mode: 'trip'
        }, { onConflict: 'telegram_chat_id' })
        .select('id')
        .single()
      group = newGroup
    }

    if (!group) return

    // Upsert sender as member
    await upsertMember(group.id, senderId, senderName, senderUsername)

    // Pass raw message to dispatcher — gate inside decides what to do
    const reply = await dispatch(
      msg.chat.id,
      msg.text,
      senderId,
      senderName,
      senderUsername,
      msg.message_id,
      msg.date,
      replyText,
      replyToIsBot
    )

    if (reply) {
      await bot.sendMessage(msg.chat.id, reply, {
        reply_to_message_id: msg.message_id
      })
    }
  } catch (err) {
    debugError('Bot message handler — unhandled', err)
  }
})
