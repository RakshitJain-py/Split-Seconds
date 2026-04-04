import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { customAlphabet } from 'nanoid'
import { dispatch, db, upsertMember } from './dispatcher'
import { logStep, logDB } from './debug/logger'

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true })
const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 6)

// /start command — generate link code
bot.onText(/\/start/, async (msg) => {
  if (msg.chat.type === 'private') {
    await bot.sendMessage(msg.chat.id, 'Add me to a group to get started!')
    return
  }

  const code = nanoid()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

  await db.from('groups').upsert({
    telegram_chat_id: msg.chat.id,
    name: msg.chat.title || 'My Group',
    link_code: code,
    link_code_expires_at: expiresAt,
    is_linked: false
  }, { onConflict: 'telegram_chat_id' })

  await bot.sendMessage(msg.chat.id,
    `SplitSeconds is ready!\n\nYour group code: ${code}\n\nPaste this at ${process.env.BASE_URL}/link to activate your dashboard.\nCode expires in 15 minutes.`
  )
})

// All messages — dispatch through AI pipeline
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.chat.type === 'private') return
    if (msg.text.startsWith('/')) return

    const senderId = msg.from?.id
    if (!senderId) return

    const senderName = msg.from?.first_name || msg.from?.username || 'Unknown'
    const senderUsername = msg.from?.username
    const replyText = msg.reply_to_message?.text

    logStep('incoming_message', { chat_id: msg.chat.id, telegram_user_id: senderId, message_text: msg.text })
    if (replyText) logStep('reply_context', { replied_text: replyText })

    // Upsert member even before dispatch (ensures every sender is tracked)
    let { data: group } = await db
      .from('groups')
      .select('id')
      .eq('telegram_chat_id', msg.chat.id)
      .single()

    // Auto-setup group if it doesn't exist so it works immediately without requiring /start
    if (!group) {
      const code = nanoid()
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
      
      const { data: newGroup } = await db.from('groups').upsert({
        telegram_chat_id: msg.chat.id,
        name: msg.chat.title || 'My Group',
        link_code: code,
        link_code_expires_at: expiresAt,
        is_linked: false
      }, { onConflict: 'telegram_chat_id' }).select('id').single()
      
      group = newGroup
      await bot.sendMessage(msg.chat.id, 'Group auto-registered! You can start adding expenses.')
    }

    if (group) {
      await upsertMember(group.id, senderId, senderName, senderUsername)
      logDB('member_upsert', { telegram_user_id: senderId })
    }

    const reply = await dispatch(
      msg.chat.id,
      msg.text,
      senderId,
      senderName,
      senderUsername,
      msg.message_id,
      msg.date,
      replyText
    )

    if (reply) {
      await bot.sendMessage(msg.chat.id, reply, { reply_to_message_id: msg.message_id })
    }
  } catch (err) {
    console.error('Error processing message:', err)
  }
})

console.log('SplitSeconds bot running...')
