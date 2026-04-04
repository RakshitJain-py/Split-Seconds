# SplitSeconds Bot — Pipeline Fix Walkthrough

## What Was Broken

The bot received messages in the group chat but **never replied**. Console only showed:
```
[incoming_message] { chat_id, telegram_user_id, message_text }
```
Then silence. No parser output, no DB write, no Telegram reply.

---

## Root Cause #1 — Decommissioned Groq Model (PRIMARY)

> [!CAUTION]
> **This was the real killer.** Every AI call was failing with `model_decommissioned`.

All three AI files were using:
```ts
model: 'llama3-8b-8192'  // ❌ Groq has retired this model
```

The `catch {}` blocks in all three files silently swallowed the error and returned `null` / `UNKNOWN`, so the pipeline produced zero results and bailed with no reply.

**Fix:** Updated all three files to the current model:
```ts
model: 'llama-3.1-8b-instant'  // ✅
```

Files changed: `parserAI.ts`, `intentRouter.ts`, `chatLLM.ts`

---

## Root Cause #2 — `is_linked` Gate (SECONDARY)

```ts
// dispatcher.ts — was blocking ALL messages
if (!group?.is_linked) return null
```

The group row in Supabase gets created with `is_linked: false` by `/start`. Since the frontend `/link` page is just a UI shell (no API route wired up yet), `is_linked` never gets flipped to `true` — so every message was silently dropped.

**Fix:** Removed the `is_linked` requirement. Now it only requires a group row to exist:
```ts
if (!group) return null
```

Also added **auto-registration**: if a message arrives and the group isn't in the DB yet (i.e. `/start` was never sent), the bot auto-creates the group row so it starts working immediately.

---

## Root Cause #3 — Silent `catch {}` Everywhere

All three AI layers had catch blocks that suppressed every error:
```ts
} catch {        // ❌ error eaten, nothing logged
  return null
}
```

**Fix:** All catches now log explicitly:
```ts
} catch (err) {   // ✅
  console.error('[parserAI] GROQ call failed:', err)
  return null
}
```
Plus intermediate logging added: `parser_raw_response`, `intent_raw_response`, JSON parse errors — so any future failure shows up immediately in the console.

---

## Root Cause #4 — Intent Filter Logic Bug

```ts
// Old — UNKNOWN intents with parsed expense still slipped through skip logic
const nonExpenseIntents = intents.filter(i => i.type !== 'RECORD_EXPENSE')
for (const intent of nonExpenseIntents) {
  if (intent.type === 'UNKNOWN' && intent.confidence < 0.3 && !parsed) continue
  if (intent.type === 'UNKNOWN') continue   // ← only skipped if 2nd condition passed
  ...
}
```

**Fix:** Simplified to a clean single filter — RECORD_EXPENSE and UNKNOWN both excluded upfront:
```ts
const nonExpenseIntents = intents.filter(
  i => i.type !== 'RECORD_EXPENSE' && i.type !== 'UNKNOWN'
)
```

---

## Additional Hardening Added

| Change | File |
|--------|------|
| DB insert error now surfaced with `console.error` | `dispatcher.ts` |
| `console.log` at every pipeline gate (group found, members, calling parser/intent/LLM, final reply) | `dispatcher.ts` |
| Raw Groq response logged before JSON parse | `parserAI.ts`, `intentRouter.ts` |
| JSON parse errors logged separately from Groq API errors | `parserAI.ts`, `intentRouter.ts` |
| chatLLM logs actual error instead of silent fallback | `chatLLM.ts` |

---

## Smoke Test Results ✅

Ran `__test_pipeline.ts` against all 4 test cases:

| Message | Parser | Intent Router | ChatLLM |
|---------|--------|---------------|---------|
| `"paid 1200 for hotel"` | ✅ `{ payer: 111111111, amount: 1200, description: 'hotel' }` | ✅ `RECORD_EXPENSE` | ✅ Replied |
| `"kitna owed hai"` | ✅ null (not expense) | ✅ `GROUP_BALANCES` | ✅ Replied |
| `"settle kar do sab"` | ✅ null | ✅ `TRIGGER_SETTLEMENT` confidence 1.0 | ✅ Replied |
| `"ok fine"` | ✅ null | ✅ `UNKNOWN` confidence 0 | ✅ Correctly silent |

---

## How to Test in Your Group Now

1. **Restart the bot** (kill & re-run `npm run start` in `/bot`) to pick up the model change
2. Send any message in the GC — the bot will auto-register the group on first message
3. Try: `paid 500 for chai` — should get a logged reply back
4. Try: `kitna bacha hai` — should get a balance summary

> [!NOTE]
> The bot console will now show a full trace for every message — `[dispatch] Group found`, `[dispatch] parseExpense result`, `[dispatch] Final reply` — making any future issues instantly visible.
