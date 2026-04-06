# SplitSeconds — Current State (Stepped Down)
**Date:** 2026-04-05 | **Version:** Temporary Version Step Down

---

## 1. Architecture

### Current (Single LLM)
```
User sends "bolt raj paid 1200 for hotel"
  → index.ts strips "bolt" prefix
  → dispatcher.ts fetches group, members, expenses from Supabase
  → boltLLM.ts sends ONE Groq call with full context
  → LLM returns JSON: { action: "log_expense", expense: {...}, reply: "Logged Rs.1200..." }
  → dispatcher inserts into DB, sends LLM's reply to Telegram
```

### Previous (3 AI Layers — Bypassed, Not Deleted)
```
msg → intentRouter.ts (classify intent) → parserAI.ts (extract data) → engines/* (math) → chatLLM.ts (reply)
```
Three Groq calls per message. Stepped down due to cascading failures and MVP deadline.

### Critical Design Rule
**LLM handles language. Code handles math.** For `query`/`settle` actions, the LLM's reply is thrown away and balances are computed deterministically in `dispatcher.ts`.

---

## 2. Pipeline Flow

### Trigger Word Gate
Bot only responds when message starts with `bolt` or `@bolt` (case-insensitive). Everything else is stored in memory silently.

### Action Types (LLM decides which)
| Action | LLM Does | Code Does |
|---|---|---|
| `log_expense` | Extract payer, amount, participants, description, tags | Resolve names→IDs, insert into `expenses` table |
| `transfer` | Extract from, to, amount | Insert into `expenses` with `tags=["transfer"]` |
| `query` | Classify as query (reply ignored) | Compute balances deterministically, format reply |
| `settle` | Classify as settlement (reply ignored) | Compute balances, create settlement record, format reply |
| `correction` | Classify as delete_last or update_amount | Delete/update last expense, format reply |
| `none` | Generate conversational reply | Nothing |

### Balance Computation (in dispatcher.ts)
```
For each expense:
  payer gets +amount
  each participant gets -(amount / participant_count)
  if participants is empty → all members share equally
```
Settlement uses greedy creditor-debtor matching (sort both descending, match top pairs).

---

## 3. Database Schema

**groups** — `id`, `telegram_chat_id` (unique), `name`, `is_linked` (always true in step-down), `link_code`, `link_code_expires_at`

**members** — `id`, `group_id` (FK), `telegram_user_id`, `display_name`, `telegram_username`. Unique on `(group_id, telegram_user_id)`. Provisional members get negative hash IDs.

**expenses** — `id`, `group_id`, `settlement_id` (null=unsettled), `payer_telegram_user_id`, `payer_display_name`, `amount`, `description`, `tags[]`, `participants[]` (user IDs, empty=all), `expense_timestamp`, `created_at`

**settlements** — `id`, `group_id`, `total_amount`, `balances_snapshot` (jsonb), `transactions_snapshot` (jsonb)

### Transfer Storage Model
Transfers are stored as expenses with `tags: ["transfer"]` and `participants: [receiverId]`. The balance engine treats them identically — payer credited, participant debited — which correctly adjusts debt.

---

## 4. Environment Variables

### `bot/.env` (used by `tsx --env-file=.env`)
| Var | Status |
|---|---|
| `GROQ_API_KEY_CHAT` | ✅ Used by boltLLM |
| `TELEGRAM_BOT_TOKEN` | ✅ Used by index.ts |
| `SUPABASE_URL` | ✅ Used by dispatcher |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Used by dispatcher |
| `GROQ_API_KEY_PARSE` | ❌ Dead (old pipeline) |
| `GROQ_API_KEY_INTENT` | ❌ Dead (old pipeline) |
| `BASE_URL` | ❌ Dead (linking bypassed) |

### Root `.env` (used by Next.js)
| Var | Status |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ API route |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ API route |
| `TELEGRAM_BOT_TOKEN` | ✅ API route notification |

All GROQ keys point to the same actual API key.

---

## 5. LLM Configuration

- **Model:** `llama-3.3-70b-versatile` via Groq
- **Temperature:** 0.2
- **Max tokens:** 600
- **Context sent:** sender name, member names, last 10 chat messages, all unsettled expenses (max 50), current message

---

## 6. Known Bugs

1. **`replyText` never passed to LLM** — Telegram reply context is received by dispatch() but not forwarded to callBolt(). Reply-based corrections broken.
2. **50-expense limit** — `getUnsettledExpenses` caps at 50. Active groups get wrong balances.
3. **No per-user queries** — "bolt raj balance" returns full group balance instead of raj-specific.
4. **No category/time filtering** — "how much on food" or "yesterday's spending" fall through to generic balance view.
5. **Greedy name matching** — "raj" can match "rajesh" or "maharaj" (first partial match wins).
6. **Chat memory lost on restart** — in-process Map, not persisted.
7. **Provisional members hidden** — members with negative IDs (name-only, never messaged) are filtered from balance display.

---

## 7. What Works End-to-End

✅ `bolt paid 500 for chai` — logs expense split among all
✅ `bolt raj paid 1200 for hotel split between raj and aman` — logs with specific split
✅ `bolt received 200 from aman` — logs transfer
✅ `bolt who owes whom` — deterministic balance output
✅ `bolt settle group` — creates settlement record
✅ `bolt undo` — deletes last expense
✅ `bolt total spent` — sums non-transfer expenses
✅ Non-triggered messages stored silently

---

## 8. What's Not Built

- Dashboard web UI (homepage is Next.js boilerplate)
- User authentication
- Per-user balance queries
- Category/time-filtered queries
- Expense editing via web
- Production deployment (uses polling, not webhooks)
- Group linking flow (exists but bypassed — auto-linked)

---

## 9. File Map (Active vs Dead)

**Active:** `bot/index.ts`, `bot/dispatcher.ts`, `bot/boltLLM.ts`, `bot/chatMemory.ts`, `bot/types.ts`

**Dead (bypassed):** `bot/parserAI.ts`, `bot/intentRouter.ts`, `bot/chatLLM.ts`, `bot/engines/*` (5 files), `bot/debug/*` (3 files), `bot/__test_pipeline.ts`

**Web (partially active):** `src/app/link/*`, `src/app/api/link-group/route.ts`, `src/lib/supabase.ts`

**Web (dead):** `src/app/page.tsx` (boilerplate), root `app/` directory (old scaffold)

---

## 10. Immediate Next Steps

1. Pass `replyText` to `callBolt()` — enables reply-based corrections
2. Per-user balance queries — detect "X balance" and filter
3. Remove 50-expense cap — raise or remove limit
4. Clean dead imports and env vars 
5. Build minimal dashboard page
