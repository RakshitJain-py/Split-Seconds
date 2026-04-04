export type ParsedExpense = {
  payer: number
  amount: number
  description: string
  participants: number[] | null
  tags: string[]
}

export type IntentType =
  | 'RECORD_EXPENSE'
  | 'RECORD_TRANSFER'
  | 'GROUP_BALANCES'
  | 'USER_BALANCE'
  | 'PAIR_BALANCE'
  | 'SETTLEMENT_PLAN'
  | 'USER_CONTRIBUTION'
  | 'CONTRIBUTION_RANKING'
  | 'CATEGORY_TOTAL'
  | 'CATEGORY_PAYER'
  | 'TIME_FILTERED_SPEND'
  | 'TIME_FILTERED_PAYER'
  | 'TRIGGER_SETTLEMENT'
  | 'CORRECT_LAST'
  | 'CORRECT_BY_DESCRIPTION'
  | 'UNKNOWN'

export type TimeFilter = 'today' | 'yesterday' | 'this_week' | 'custom'
export type TemporalMode = 'past' | 'current' | 'settlement'

export type Intent = {
  type: IntentType
  actor?: string
  counterparty?: string
  category?: string
  time_filter?: TimeFilter
  temporal_mode?: TemporalMode
  confidence: number
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  telegram_user_id?: number
  text: string
  message_id?: number
  timestamp: number
}

export type Transaction = {
  from: number
  to: number
  amount: number
}

export type BalanceMap = Map<number, number>

export type EngineResult = {
  type: string
  data: unknown
  summary: string
}

export type MemberInfo = {
  telegram_user_id: number
  display_name: string
  telegram_username: string | null
}

export type HistoryFilter = {
  time_filter?: TimeFilter
  user_id?: number
  category?: string
  custom_start?: string
  custom_end?: string
}

export type DBExpense = {
  id: string
  group_id: string
  payer_telegram_user_id: number
  payer_display_name: string | null
  amount: number
  description: string
  participants: number[] | null
  tags: string[]
  telegram_message_id: number | null
  expense_timestamp: string
  created_at: string
  settlement_id: string | null
}
