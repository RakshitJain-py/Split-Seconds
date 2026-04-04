import { SupabaseClient } from '@supabase/supabase-js'
import { DBExpense } from '../types'

export async function computeGroupBalances(
  db: SupabaseClient,
  groupId: string
): Promise<Map<number, number>> {
  // Get all unsettled expenses
  const { data: expenses, error } = await db
    .from('expenses')
    .select('*')
    .eq('group_id', groupId)
    .is('settlement_id', null)

  if (error || !expenses) return new Map()

  // Get all current members
  const { data: members } = await db
    .from('members')
    .select('telegram_user_id')
    .eq('group_id', groupId)

  const allMemberIds: number[] = (members || []).map((m: { telegram_user_id: number }) => m.telegram_user_id)

  const balances = new Map<number, number>()

  // Initialize all members to 0
  for (const uid of allMemberIds) {
    balances.set(uid, 0)
  }

  for (const exp of expenses as DBExpense[]) {
    const payerId = exp.payer_telegram_user_id
    const amount = Number(exp.amount)

    // Determine who shares this expense
    let participantIds: number[]
    if (exp.participants && exp.participants.length > 0) {
      participantIds = exp.participants
    } else {
      participantIds = allMemberIds
    }

    // Ensure payer is in balances map (may be provisional member)
    if (!balances.has(payerId)) balances.set(payerId, 0)

    // Payer gets credited
    balances.set(payerId, (balances.get(payerId) || 0) + amount)

    // Each participant gets debited their share
    const share = amount / participantIds.length
    for (const pid of participantIds) {
      if (!balances.has(pid)) balances.set(pid, 0)
      balances.set(pid, (balances.get(pid) || 0) - share)
    }
  }

  // Round to 2 decimal places
  for (const [uid, bal] of balances) {
    balances.set(uid, Math.round(bal * 100) / 100)
  }

  return balances
}
