// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

// ── Kept from V0.5 (still active) ───────────────────────────────────────────

export type DBExpense = {
  id: string
  group_id: string
  settlement_id: string | null
  payer_telegram_user_id: number
  payer_display_name: string | null
  amount: number
  description: string | null
  tags: string[] | null
  participants: number[] | null
  telegram_message_id: number | null
  expense_timestamp: string | null
  created_at: string
}

export type MemberInfo = {
  telegram_user_id: number
  display_name: string
  telegram_username: string | null
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  telegram_user_id?: number
  text: string
  message_id?: number
  timestamp: number
}

export type Transaction = {
  from: number             // telegram_user_id
  to: number               // telegram_user_id
  amount: number
}

// ── Kept from V0.5 — BoltResponse (used until Phase 3 replaces boltLLM) ────

export type BoltResponse = {
  action: 'log_expense' | 'transfer' | 'settle' | 'query' | 'correction' | 'none'
  expense?: {
    payer_name: string
    amount: number
    participants: string[]
    description: string
    tags: string[]
  }
  transfer?: {
    from: string
    to: string
    amount: number
  }
  correction?: {
    type: 'delete_last' | 'update_amount'
    new_amount?: number
  }
  reply: string
}

// ── V2 — GroupState (warm memory, stored in groups.group_state jsonb) ────────

export type GroupState = {
  last_action: {
    type: string           // 'log_expense' | 'log_transfer' | 'query' | 'settle' | 'correct'
    summary: string        // human readable: "Raj logged hotel Rs.1200"
    expense_id?: string    // uuid if applicable
    timestamp: string      // ISO string
  } | null
  pending_confirmation: {
    asked_by_bot: string           // the question the bot asked
    parsed_actions: FunctionCall[] // actions waiting to execute
    waiting_since: string          // ISO string
  } | null
  name_aliases: Record<string, string>      // "raju" → "Rajesh"
  member_contributions: Record<string, number>  // display_name → total paid this cycle
  semantic_summary: string | null   // paid tier only
  last_settlement_at: string | null
}

// ── V2 — Gate (L1) ─────────────────────────────────────────────────────────

export type GateDecision = 'directed' | 'passive' | 'ignore'

export type GateResult = {
  decision: GateDecision
  stripped_message: string  // message with trigger word removed
  is_reply_context: boolean
}

// ── V2 — Classifier (L2) ───────────────────────────────────────────────────

export type Category = 'RECORD' | 'QUERY' | 'CORRECT' | 'CONTROL' | 'SOCIAL'

export type FunctionCall = {
  name: string
  parameters: Record<string, unknown>
}

export type ClassifierResult =
  | { status: 'single'; category: Category; function: FunctionCall }
  | { status: 'multi'; actions: FunctionCall[]; confirmation_message: string }
  | { status: 'ambiguous'; options: FunctionCall[]; question: string }
  | { status: 'clarification_response'; resolves: FunctionCall[] }
  | { status: 'social'; subtype: string; reply_hint: string }
  | { status: 'ignore' }

// ── V2 — Name Resolver ─────────────────────────────────────────────────────

export type NameResolutionResult = {
  resolved_call: FunctionCall    // parameters now have IDs instead of name strings
  has_ambiguous_names: boolean
  ambiguous_names: { input: string; candidates: MemberInfo[] }[]
  new_aliases: Record<string, string>  // to save to GroupState
}

// ── V2 — Executor (L3) ─────────────────────────────────────────────────────

export type ExecutorResult = {
  success: boolean
  data: unknown              // structured result data
  error?: string
  state_updates: Partial<GroupState>
}

// ── V2 — Briefer (L4) ──────────────────────────────────────────────────────

export type BriefingPacket = {
  situation: string
  what_happened: string
  key_values: Record<string, unknown>
  conversation_context: string
  group_mode: string
  tone_guide: string
  instruction: string
  should_reply: boolean
  is_confirmation_request: boolean
}
