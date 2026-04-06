import 'dotenv/config'
import { dispatch, db } from './dispatcher'
import * as fs from 'fs'

const DUMMY_CHAT = -100111222333;
const SENDER_ID = 111;
const SENDER_NAME = "Aman";
const SENDER_USERNAME = "aman_dev";

const messages = [
  "bolt paid 500 for chai",
  "bolt raj paid 800 for petrol",
  "bolt who owes whom",
  "bolt raj's balance",
  "bolt total spent",
  "bolt undo",
  "bolt settle group",
  "bolt who owes whom",
  "bolt paid 500 for chai" // Redundant log AFTER settle — should work
];

async function run() {
  console.log("=== STARTING SPLITSECONDS V2 TEST SUITE ===");

  // 1. Ensure group exists
  let { data: group } = await db
      .from('groups')
      .select('id')
      .eq('telegram_chat_id', DUMMY_CHAT)
      .single()

  if (!group) {
    const { data: newGroup, error } = await db
      .from('groups')
      .upsert({
        telegram_chat_id: DUMMY_CHAT,
        name: 'Test Group',
        is_linked: true,
        bot_alias: 'bolt',
        group_mode: 'trip'
      }, { onConflict: 'telegram_chat_id' })
      .select('id')
      .single()
    if (error) {
       console.error("ERROR CREATING GROUP:", error);
       return;
    }
    group = newGroup
  }

  // 2. Iterate messages sequentially with slight delays
  const botReplies: Record<string, string | null> = {};

  let counter = 1;
  for (const msg of messages) {
    console.log(`\n\n=== [${counter++}/${messages.length}] SENDING: "${msg}" ===`);
    const isUndo = msg === "bolt undo";
    const reply = await dispatch(
      DUMMY_CHAT,
      msg,
      SENDER_ID,
      SENDER_NAME,
      SENDER_USERNAME,
      1000 + counter,
      Math.floor(Date.now() / 1000),
      undefined,
      isUndo
    );
    botReplies[msg] = reply;
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log("\n\n=== TEST SUITE COMPLETE. FETCHING DB STATE ===");
  const { data: exps } = await db.from('expenses').select('*');
  const { data: mems } = await db.from('members').select('*');
  const { data: sets } = await db.from('settlements').select('*');
  const { data: acts } = await db.from('groups').select('group_state').eq('telegram_chat_id', DUMMY_CHAT).single();

  const report = {
    botReplies,
    expenses: exps,
    members: mems,
    settlements: sets,
    groupState: acts
  };

  fs.writeFileSync('test_report.json', JSON.stringify(report, null, 2));
  console.log("Report written to test_report.json");
}

run().catch(console.error);
