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

describe('DreamEngine - smartCompress', () => {
  it('generates summary for long facts without summary', async () => {
    const longContent = '这是一段很长的记忆内容。'.repeat(20) // >200 chars
    store.addFact(longContent, 'general')

    const summary = '这是一段关于长内容的简洁摘要'
    const mockChatJSON = vi.fn().mockResolvedValueOnce({ summaries: [{ fact_id: 1, summary }] })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.smartCompress()

    expect(result).toBe(1)
  })

  it('skips facts that already have summary', async () => {
    const longContent = '这是一段很长的记忆内容。'.repeat(20)
    const id = store.addFact(longContent, 'general')
    store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run('已有摘要', id)

    const mockChatJSON = vi.fn()
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.smartCompress()

    expect(result).toBe(0)
    expect(mockChatJSON).not.toHaveBeenCalled()
  })

  it('truncates summary longer than 150 chars', async () => {
    const longContent = '这是一段很长的记忆内容。'.repeat(20)
    store.addFact(longContent, 'general')

    const tooLongSummary = 'a'.repeat(200)
    const mockChatJSON = vi.fn().mockResolvedValueOnce({ summaries: [{ fact_id: 1, summary: tooLongSummary }] })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    await eng.smartCompress()

    const fact = store.listFacts('general', 0, 10)[0]
    expect(fact.summary!.length).toBeLessThanOrEqual(150)
  })
})

describe('DreamEngine - smartReclassify', () => {
  it('moves general facts to correct category via LLM', async () => {
    store.addFact('用户编码规范要求文件不超过500行', 'general')

    const mockChatJSON = vi.fn().mockResolvedValueOnce({
      reclassify: [{ fact_id: 1, to: 'coding_style' }],
    })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.smartReclassify()

    expect(result).toBe(1)
    const fact = store.listFacts('coding_style', 0, 10)[0]
    expect(fact).toBeDefined()
    expect(fact.content).toContain('编码规范')
  })

  it('ignores invalid category from LLM', async () => {
    store.addFact('一些内容', 'general')

    const mockChatJSON = vi.fn().mockResolvedValueOnce({
      reclassify: [{ fact_id: 1, to: 'invalid_category' }],
    })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.smartReclassify()

    expect(result).toBe(0)
  })

  it('skips when LLM says keep general', async () => {
    store.addFact('一些杂项内容', 'general')

    const mockChatJSON = vi.fn().mockResolvedValueOnce({
      reclassify: [{ fact_id: 1, to: 'general' }],
    })
    const mockClient = { chatJSON: mockChatJSON, isAvailable: vi.fn().mockResolvedValue(true) } as unknown as LLMClient
    const eng = new DreamEngine(mockClient, store)
    const result = await eng.smartReclassify()

    expect(result).toBe(0)
  })
})
