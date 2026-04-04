/**
 * Pipeline smoke test — run with: npx tsx __test_pipeline.ts
 * Tests the full AI chain: parser → intentRouter → chatLLM
 * Does NOT write to Supabase or send Telegram messages.
 */
import 'dotenv/config'
import { parseExpense } from './parserAI'
import { routeIntent } from './intentRouter'
import { generateReply } from './chatLLM'
import { MemberInfo } from './types'

const FAKE_MEMBERS: MemberInfo[] = [
  { telegram_user_id: 111111111, display_name: 'Raj', telegram_username: 'raj_test' },
  { telegram_user_id: 222222222, display_name: 'Priya', telegram_username: 'priya_test' },
  { telegram_user_id: 333333333, display_name: 'Aryan', telegram_username: 'aryan_test' },
]

const TESTS = [
  {
    label: 'Expense message',
    message: 'paid 1200 for hotel',
    senderName: 'Raj',
    senderId: 111111111,
  },
  {
    label: 'Balance query',
    message: 'kitna owed hai',
    senderName: 'Priya',
    senderId: 222222222,
  },
  {
    label: 'Settlement trigger',
    message: 'settle kar do sab',
    senderName: 'Aryan',
    senderId: 333333333,
  },
  {
    label: 'Random chat (should produce no expense)',
    message: 'ok fine',
    senderName: 'Raj',
    senderId: 111111111,
  },
]

async function runTest(t: typeof TESTS[0]) {
  console.log('\n' + '='.repeat(60))
  console.log(`TEST: ${t.label}`)
  console.log(`Message: "${t.message}"`)
  console.log('='.repeat(60))

  // Layer 1: Parser
  console.log('\n--- Parser ---')
  let parsed
  try {
    parsed = await parseExpense(t.message, t.senderName, t.senderId, FAKE_MEMBERS)
    console.log('parsed:', parsed)
  } catch (e) {
    console.error('Parser threw:', e)
    parsed = null
  }

  // Layer 2: Intent Router
  console.log('\n--- Intent Router ---')
  let intents
  try {
    intents = await routeIntent(t.message, t.senderName, FAKE_MEMBERS)
    console.log('intents:', intents)
  } catch (e) {
    console.error('IntentRouter threw:', e)
    intents = []
  }

  // Layer 3: Chat LLM (only if we'd have results)
  const engineResults = []
  if (parsed) {
    engineResults.push({
      type: 'RECORD_EXPENSE',
      data: parsed,
      summary: `Logged: Rs.${parsed.amount} for "${parsed.description}"`
    })
  }
  const actionable = (intents as { type: string; confidence: number }[]).filter(
    (i) => i.type !== 'RECORD_EXPENSE' && i.type !== 'UNKNOWN'
  )
  if (actionable.length > 0) {
    engineResults.push({ type: actionable[0].type, data: null, summary: `[simulated ${actionable[0].type} result]` })
  }

  if (engineResults.length > 0) {
    console.log('\n--- ChatLLM ---')
    try {
      const reply = await generateReply(t.message, t.senderName, engineResults, [], FAKE_MEMBERS)
      console.log('reply:', reply)
    } catch (e) {
      console.error('ChatLLM threw:', e)
    }
  } else {
    console.log('\nNo engine results → would return null (no reply sent)')
  }
}

async function main() {
  for (const t of TESTS) {
    await runTest(t)
  }
  console.log('\n' + '='.repeat(60))
  console.log('All tests complete.')
}

main().catch(console.error)
