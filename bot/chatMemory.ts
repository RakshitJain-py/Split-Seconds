import { ChatMessage } from './types'
import { logMemory } from './debug/logger'

const memory: Map<number, ChatMessage[]> = new Map()

export function addMessage(groupId: number, message: ChatMessage): void {
  const messages = memory.get(groupId) || []
  messages.push(message)
  if (messages.length > 11) {
    messages.shift()
  }
  memory.set(groupId, messages)
  logMemory(groupId, messages.slice(-3))
}

export function getMessages(groupId: number): ChatMessage[] {
  return memory.get(groupId) || []
}

export function clearMemory(groupId: number): void {
  memory.delete(groupId)
}
