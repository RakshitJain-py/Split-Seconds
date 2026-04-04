import { DEBUG_MODE } from './debugConfig'
import { logTiming } from './logger'

export async function traceAsync<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!DEBUG_MODE) return fn()
  const start = Date.now()
  try {
    const result = await fn()
    logTiming(label, Date.now() - start)
    return result
  } catch (err) {
    logTiming(`${label}:ERROR`, Date.now() - start)
    throw err
  }
}
