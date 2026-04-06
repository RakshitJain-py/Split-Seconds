// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — GroupState (Warm Memory)
// Persistent state stored in groups.group_state jsonb column.
// Overwritten (not appended) after every interaction.
// ─────────────────────────────────────────────────────────────────────────────

import { SupabaseClient } from '@supabase/supabase-js'
import { GroupState } from './types'

// ── Default State ───────────────────────────────────────────────────────────

export function defaultGroupState(): GroupState {
  return {
    last_action: null,
    pending_confirmation: null,
    name_aliases: {},
    member_contributions: {},
    semantic_summary: null,
    last_settlement_at: null
  }
}

// ── Load ─────────────────────────────────────────────────────────────────────

export async function loadGroupState(
  db: SupabaseClient,
  groupId: string
): Promise<GroupState> {
  const { data, error } = await db
    .from('groups')
    .select('group_state')
    .eq('id', groupId)
    .single()

  if (error || !data?.group_state) {
    return defaultGroupState()
  }

  // Merge with defaults so any missing keys get filled
  const stored = data.group_state as Partial<GroupState>
  return {
    ...defaultGroupState(),
    ...stored
  }
}

// ── Save ─────────────────────────────────────────────────────────────────────
// Merges partial updates into current state, then overwrites.

export async function saveGroupState(
  db: SupabaseClient,
  groupId: string,
  updates: Partial<GroupState>
): Promise<void> {
  const current = await loadGroupState(db, groupId)
  const merged: GroupState = { ...current, ...updates }

  const { error } = await db
    .from('groups')
    .update({ group_state: merged })
    .eq('id', groupId)

  if (error) {
    console.error('[groupState] Save error:', error)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function updateLastAction(
  type: string,
  summary: string,
  expenseId?: string
): GroupState['last_action'] {
  return {
    type,
    summary,
    expense_id: expenseId,
    timestamp: new Date().toISOString()
  }
}

export function updateContributions(
  current: Record<string, number>,
  payerName: string,
  amount: number
): Record<string, number> {
  const updated = { ...current }
  updated[payerName] = (updated[payerName] || 0) + amount
  return updated
}
