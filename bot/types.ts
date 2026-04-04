export type IntentType =
  // Recording
  | 'RECORD_EXPENSE'
  | 'RECORD_TRANSFER'
  // Corrections
  | 'CORRECT_LAST'
  | 'CORRECT_BY_DESCRIPTION'
  // Balance queries
  | 'GROUP_BALANCES'
  | 'USER_BALANCE'
  | 'PAIR_BALANCE'
  | 'SETTLEMENT_PLAN'
  // Contribution queries
  | 'USER_CONTRIBUTION'
  | 'CONTRIBUTION_RANKING'
  // Category queries
  | 'CATEGORY_TOTAL'
  | 'CATEGORY_PAYER'
  // Time queries
  | 'TIME_FILTERED_SPEND'
  | 'TIME_FILTERED_PAYER'
  // Settlement trigger
  | 'TRIGGER_SETTLEMENT'
  // Unknown / unrelated
  | 'UNKNOWN'

export type Intent = {
  type: IntentType
  actor?: string           // display name string (not id)
  counterparty?: string    // display name string (not id)
  amount?: number          // for transfers, corrections with new value
  category?: string        // tag name for category queries
  time_filter?: 'today' | 'yesterday' | 'this_week' | 'day_before_yesterday' | 'custom' | null
  temporal_mode?: 'past' | 'current' | 'settlement' | null
  confidence: number       // 0.0 to 1.0
}

export type ParsedExpense = {
  payer: number            // telegram_user_id
  amount: number
  description: string
  participants: number[] | null   // null = all members
  tags: string[]
  is_transfer: false
}

export type ParsedTransfer = {
  payer: number            // who paid out the money
  receiver: number | null  // telegram_user_id if known, null if name-only
  receiver_name: string    // display name of receiver always
  amount: number
  is_transfer: true
}

export type MemberInfo = {
  telegram_user_id: number
  display_name: string
  telegram_username: string | null
}

export type Transaction = {
  from: number             // telegram_user_id
  to: number               // telegram_user_id
  amount: number
}

export type EngineResult = {
  type: IntentType | 'RECORD_EXPENSE' | 'RECORD_TRANSFER'
  data: unknown
  summary: string          // used by Chat LLM as structured input
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  telegram_user_id?: number
  text: string
  message_id?: number
  timestamp: number
}

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

export type UserBalanceView = {
  user_id: number
  net_balance: number
  owes_to: { user_id: number; amount: number }[]
  owed_by: { user_id: number; amount: number }[]
}

export type CategoryStats = {
  tag: string
  total: number
  count: number
  payers: { user_id: number; amount: number }[]
}
