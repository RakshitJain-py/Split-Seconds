// ─────────────────────────────────────────────────────────────────────────────
// SplitSeconds V2 — Name Resolver
// Converts name strings from classifier output into telegram_user_ids.
// Called after L2 (classifier), before L3 (executor engines).
// ─────────────────────────────────────────────────────────────────────────────

import { distance } from 'fastest-levenshtein'
import { MemberInfo, FunctionCall, NameResolutionResult } from './types'

// ── Single name resolution ──────────────────────────────────────────────────

type SingleResolution = {
  telegram_user_id: number | null
  display_name: string | null
  confidence: number      // 0.0–1.0
  candidates: MemberInfo[] // populated when ambiguous
}

export function resolveSingleName(
  inputName: string,
  members: MemberInfo[],
  aliases: Record<string, string>
): SingleResolution {
  if (!inputName || inputName.trim().length === 0) {
    return { telegram_user_id: null, display_name: null, confidence: 0, candidates: [] }
  }

  const lower = inputName.trim().toLowerCase()

  // 1. Check aliases first (learned from confirmed corrections)
  if (aliases[lower]) {
    const aliasTarget = aliases[lower].toLowerCase()
    const match = members.find(m => m.display_name.toLowerCase() === aliasTarget)
    if (match) {
      return { telegram_user_id: match.telegram_user_id, display_name: match.display_name, confidence: 1.0, candidates: [] }
    }
  }

  // 2. Exact match (case-insensitive)
  const exact = members.find(m => m.display_name.toLowerCase() === lower)
  if (exact) {
    return { telegram_user_id: exact.telegram_user_id, display_name: exact.display_name, confidence: 1.0, candidates: [] }
  }

  // Also check @username match
  const usernameMatch = members.find(m =>
    m.telegram_username && m.telegram_username.toLowerCase() === lower.replace('@', '')
  )
  if (usernameMatch) {
    return { telegram_user_id: usernameMatch.telegram_user_id, display_name: usernameMatch.display_name, confidence: 1.0, candidates: [] }
  }

  // 3. Starts-with match
  const startsWithMatches = members.filter(m =>
    m.display_name.toLowerCase().startsWith(lower)
  )
  if (startsWithMatches.length === 1) {
    return { telegram_user_id: startsWithMatches[0].telegram_user_id, display_name: startsWithMatches[0].display_name, confidence: 0.85, candidates: [] }
  }
  if (startsWithMatches.length > 1) {
    // Ambiguous — multiple members start with the same prefix
    return { telegram_user_id: null, display_name: null, confidence: 0, candidates: startsWithMatches }
  }

  // 4. Fuzzy match (Levenshtein distance ≤ 2)
  const fuzzyMatches: { member: MemberInfo; dist: number }[] = []
  for (const m of members) {
    const d = distance(lower, m.display_name.toLowerCase())
    if (d <= 2) {
      fuzzyMatches.push({ member: m, dist: d })
    }
  }

  if (fuzzyMatches.length === 1) {
    const confidence = fuzzyMatches[0].dist === 1 ? 0.7 : 0.5
    return { telegram_user_id: fuzzyMatches[0].member.telegram_user_id, display_name: fuzzyMatches[0].member.display_name, confidence, candidates: [] }
  }
  if (fuzzyMatches.length > 1) {
    return { telegram_user_id: null, display_name: null, confidence: 0, candidates: fuzzyMatches.map(f => f.member) }
  }

  // 5. No match
  return { telegram_user_id: null, display_name: null, confidence: 0, candidates: [] }
}

// ── Resolve all names in a FunctionCall ─────────────────────────────────────
// Scans parameters for known name fields and resolves them to IDs.

const NAME_PARAM_KEYS = [
  'payer_name', 'from_name', 'to_name', 'user_name',
  'user_a', 'user_b', 'new_payer_name'
]
const NAME_ARRAY_PARAM_KEYS = ['participant_names']

export function resolveNames(
  fnCall: FunctionCall,
  members: MemberInfo[],
  aliases: Record<string, string>
): NameResolutionResult {
  const resolvedParams = { ...fnCall.parameters }
  const ambiguousNames: { input: string; candidates: MemberInfo[] }[] = []
  const newAliases: Record<string, string> = {}

  // Resolve single-name parameters
  for (const key of NAME_PARAM_KEYS) {
    const val = resolvedParams[key]
    if (typeof val !== 'string' || !val) continue

    const result = resolveSingleName(val, members, aliases)

    if (result.confidence >= 0.85 && result.telegram_user_id !== null) {
      // High confidence — replace name with ID silently
      resolvedParams[key + '_id'] = result.telegram_user_id
      resolvedParams[key + '_resolved'] = result.display_name
    } else if (result.confidence >= 0.5 && result.telegram_user_id !== null) {
      // Medium confidence — use it but flag for confirmation
      resolvedParams[key + '_id'] = result.telegram_user_id
      resolvedParams[key + '_resolved'] = result.display_name
      // Record as potential new alias
      newAliases[val.toLowerCase()] = result.display_name!
    } else if (result.candidates.length > 0) {
      // Ambiguous
      ambiguousNames.push({ input: val, candidates: result.candidates })
    } else {
      // No match at all — leave as name string, provisioning will handle it
      resolvedParams[key + '_id'] = null
      resolvedParams[key + '_resolved'] = val
    }
  }

  // Resolve name-array parameters
  for (const key of NAME_ARRAY_PARAM_KEYS) {
    const val = resolvedParams[key]
    if (!Array.isArray(val)) continue

    const resolvedIds: number[] = []
    for (const name of val) {
      if (typeof name !== 'string') continue
      const result = resolveSingleName(name, members, aliases)

      if (result.confidence >= 0.5 && result.telegram_user_id !== null) {
        resolvedIds.push(result.telegram_user_id)
        if (result.confidence < 0.85) {
          newAliases[name.toLowerCase()] = result.display_name!
        }
      } else if (result.candidates.length > 0) {
        ambiguousNames.push({ input: name, candidates: result.candidates })
      }
      // No match: will be handled by provisional member creation
    }
    resolvedParams[key + '_ids'] = resolvedIds
  }

  return {
    resolved_call: { name: fnCall.name, parameters: resolvedParams },
    has_ambiguous_names: ambiguousNames.length > 0,
    ambiguous_names: ambiguousNames,
    new_aliases: newAliases
  }
}

// ── Build clarification message ─────────────────────────────────────────────

export function buildNameClarificationMessage(
  ambiguous: { input: string; candidates: MemberInfo[] }[]
): string {
  const parts = ambiguous.map(a => {
    const names = a.candidates.map(c => c.display_name).join(', ')
    return `"${a.input}" — did you mean ${names}?`
  })
  return `Couldn't tell who you meant:\n${parts.join('\n')}`
}
