import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  const { code } = await req.json()

  if (!code || typeof code !== 'string' || code.length !== 8) {
    return NextResponse.json({ error: 'Invalid code format' }, { status: 400 })
  }

  // Find group with this code
  const { data: group, error } = await db
    .from('groups')
    .select('*')
    .eq('link_code', code)
    .single()

  if (error || !group) {
    return NextResponse.json(
      { error: 'Code not found. Make sure you typed it correctly.' },
      { status: 404 }
    )
  }

  // Check expiry
  if (group.link_code_expires_at && new Date(group.link_code_expires_at) < new Date()) {
    return NextResponse.json(
      { error: 'Code has expired. Send /start in your group to get a new one.' },
      { status: 410 }
    )
  }

  // Check if already linked
  if (group.is_linked) {
    return NextResponse.json(
      { error: 'This group is already linked.' },
      { status: 409 }
    )
  }

  // Mark as linked and invalidate code
  const { error: updateErr } = await db
    .from('groups')
    .update({
      is_linked: true,
      link_code: null,
      link_code_expires_at: null
    })
    .eq('id', group.id)

  if (updateErr) {
    console.error('[api/link-group] update error:', updateErr)
    return NextResponse.json({ error: 'Failed to link group. Please try again.' }, { status: 500 })
  }

  // Notify the Telegram group
  const botToken = process.env.TELEGRAM_BOT_TOKEN!
  const telegramMsg = `✅ Group linked successfully! SplitSeconds is now active.\n\nStart logging expenses naturally — just type what was paid.`

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: group.telegram_chat_id, text: telegramMsg })
    })
  } catch (err) {
    // Non-fatal — group is linked even if notification fails
    console.error('[api/link-group] telegram notify error:', err)
  }

  return NextResponse.json({
    message: 'Group linked! Check your Telegram group.',
    group_id: group.id
  })
}
