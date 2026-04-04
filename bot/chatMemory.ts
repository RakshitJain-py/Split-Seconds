import { ChatMessage } from './types'

const memory = new Map<number, ChatMessage[]>()
const MAX_MESSAGES = 10

export function addMessage(chatId: number, message: ChatMessage): void {
  if (!memory.has(chatId)) memory.set(chatId, [])
  const msgs = memory.get(chatId)!
  msgs.push(message)
  if (msgs.length > MAX_MESSAGES) msgs.shift()
}

export function getMessages(chatId: number): ChatMessage[] {
  return memory.get(chatId) || []
}

export function clearMemory(chatId: number): void {
  memory.delete(chatId)
}
