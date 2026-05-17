import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DreamEngine } from '../src/dream-engine.js'
import { LLMClient } from '../src/llm-client.js'
import { MemoryStore } from '../src/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let store: MemoryStore
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mnemo-dream-'))
  store = new MemoryStore(join(tmpDir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('DreamEngine - semanticMerge', () => {
  it('merges same-topic facts and updates content', async () => {
    store.addFact('用户喜欢使用 VS Code 编辑器写代码', 'tool_pref')
    store.addFact('用户偏好 Visual Studio Code 作为开发工具', 'tool_pref')

    const mergedContent = '用户喜欢使用 VS Code（Visual Studio Code）作为开发编辑器'
    const mockChatJSON = vi.fn().mockResolvedValueOnce({
      merges: [{ kept: 1, removed: 2, merged_content: mergedContent, reason: '都描述偏好VS Code' }],
    })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.semanticMerge()

    expect(result.merged).toBe(1)
    expect(result.details.length).toBe(1)
    // 验证 kept fact 的 content 被更新
    const kept = store.listFacts('tool_pref', 0, 10)[0]
    expect(kept.content).toBe(mergedContent)
  })

  it('skips batch when LLM returns invalid JSON', async () => {
    store.addFact('一些事实内容', 'general')

    const mockClient = {
      chatJSON: vi.fn().mockRejectedValue(new Error('invalid json')),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.semanticMerge()

    expect(result.merged).toBe(0)
  })

  it('protects high-trust facts from deletion', async () => {
    const id1 = store.addFact('高信任事实内容', 'general')
    for (let i = 0; i < 10; i++) store.recordFeedback(id1, true)

    const id2 = store.addFact('另一个事实内容', 'general')

    const mockChatJSON = vi.fn().mockResolvedValueOnce({
      merges: [{ kept: id2, removed: id1, merged_content: '合并', reason: '重复' }],
    })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.semanticMerge()

    expect(result.merged).toBe(0)
  })
})

describe('DreamEngine - smartCompress', () => {
  it('compresses long content by overwriting content field', async () => {
    const longContent = '这是一段很长的记忆内容。'.repeat(20) // >200 chars
    store.addFact(longContent, 'general')

    const compressed = '精简后的记忆内容'
    const mockChatJSON = vi.fn().mockResolvedValueOnce({ compressions: [{ fact_id: 1, content: compressed }] })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.smartCompress()

    expect(result).toBe(1)
    const fact = store.listFacts('general', 0, 10)[0]
    expect(fact.content).toBe(compressed)
  })

  it('skips short content', async () => {
    store.addFact('短内容', 'general')

    const mockChatJSON = vi.fn()
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.smartCompress()

    expect(result).toBe(0)
    expect(mockChatJSON).not.toHaveBeenCalled()
  })

  it('skips when LLM returns empty compressions', async () => {
    const longContent = '这是一段很长的记忆内容。'.repeat(20)
    store.addFact(longContent, 'general')

    const mockChatJSON = vi.fn().mockResolvedValueOnce({ compressions: [] })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.smartCompress()

    expect(result).toBe(0)
  })
})
