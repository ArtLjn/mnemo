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
  it('merges semantically duplicate facts in same category', async () => {
    store.addFact('用户喜欢使用 VS Code 编辑器写代码', 'tool_pref')
    store.addFact('用户偏好 Visual Studio Code 作为开发工具', 'tool_pref')

    const mockChatJSON = vi.fn().mockResolvedValueOnce({
      merges: [{ kept: 1, removed: 2, reason: '都描述偏好VS Code编辑器' }],
    })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.semanticMerge()

    expect(result.merged).toBe(1)
    expect(result.details.length).toBe(1)
    expect(result.details[0].reason).toBe('都描述偏好VS Code编辑器')
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
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)
    store.recordFeedback(id1, true)

    const id2 = store.addFact('另一个事实内容', 'general')

    const mockChatJSON = vi.fn().mockResolvedValueOnce({
      merges: [{ kept: id2, removed: id1, reason: '重复' }],
    })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.semanticMerge()

    expect(result.merged).toBe(0)
  })
})
