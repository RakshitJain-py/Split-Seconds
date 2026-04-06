import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const DUMMY_CHAT = -100111222333;

async function clear() {
  console.log("=== CLEARING TEST DATA ===");
  
  const { data: group } = await db.from('groups').select('id').eq('telegram_chat_id', DUMMY_CHAT).single();
  if (group) {
    await db.from('expenses').delete().eq('group_id', group.id);
    await db.from('settlements').delete().eq('group_id', group.id);
    await db.from('groups').update({ group_state: {} }).eq('id', group.id);
    console.log("Cleared expenses, settlements and group_state for test group.");
  } else {
    console.log("Test group not found, nothing to clear.");
  }
}

clear().catch(console.error);
