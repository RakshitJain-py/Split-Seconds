import { DEBUG_MODE } from './debugConfig'

function print(tag: string, payload?: unknown): void {
  if (!DEBUG_MODE) return
  try {
    console.log(`\n[SplitSeconds][${tag}]`)
    if (payload !== undefined) {
      console.dir(payload, { depth: 5 })
    }
  } catch { /* never throw */ }
}

export function logStep(step: string, payload?: unknown): void {
  print(step, payload)
}

export function logAI(stage: string, payload?: unknown): void {
  print(stage, payload)
}

export function logEngine(engineName: string, payload?: unknown): void {
  print(engineName, payload)
}

export function logDB(operation: string, payload?: unknown): void {
  print(operation, payload)
}

export function logMemory(group_id: number | string, payload?: unknown): void {
  print(`memory:${group_id}`, payload)
}

export function logTiming(label: string, duration: number): void {
  if (!DEBUG_MODE) return
  try {
    console.log(`\n[SplitSeconds][timing:${label}] ${duration}ms`)
  } catch { /* never throw */ }
}
