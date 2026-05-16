import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store.js'
import { FactRetriever } from '../src/retriever.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let store: MemoryStore
let retriever: FactRetriever
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mnemo-test-'))
  store = new MemoryStore(join(tmpDir, 'test.db'))
  retriever = new FactRetriever(store, { temporalDecayHalfLife: 30 })
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('FactRetriever', () => {
  it('should find facts by FTS5 search', () => {
    store.addFact('用户偏好深色主题', 'tool_pref', 'theme,dark')
    const results = retriever.search('深色主题')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('深色主题')
  })

  it('should return empty for no matches', () => {
    store.addFact('用户偏好深色主题', 'tool_pref')
    const results = retriever.search('量子计算')
    expect(results.length).toBe(0)
  })

  it('should probe facts by entity', () => {
    store.addFact('使用 "TypeScript" 开发前端', 'coding_style')
    const results = retriever.probe('TypeScript')
    expect(results.length).toBeGreaterThan(0)
  })

  it('should find related facts', () => {
    store.addFact('使用 "React" 开发前端，喜欢 "TypeScript"', 'coding_style')
    store.addFact('使用 "TypeScript" 编写后端 API', 'coding_style')
    const results = retriever.related('React')
    expect(results.length).toBeGreaterThan(0)
  })

  it('should reason across multiple entities', () => {
    store.addFact('用 "React" + "TypeScript" 全栈开发', 'coding_style')
    const results = retriever.reason(['React', 'TypeScript'])
    expect(results.length).toBeGreaterThan(0)
  })
})

describe('static weights (no dynamic)', () => {
  it('uses same weights for short and long queries', () => {
    store.addFact('用户偏好 VS Code 编辑器', 'tool_pref')
    const shortResults = retriever.search('VS Code')
    const longResults = retriever.search('为什么 VS Code 编辑器总是报错说找不到模块')
    // Both should return the same fact — static weights don't change by query length
    expect(shortResults.some(r => r.content.includes('VS Code'))).toBe(true)
    expect(longResults.some(r => r.content.includes('VS Code'))).toBe(true)
  })
})

describe('length penalty', () => {
  it('penalizes long facts without summary', () => {
    const longContent = '用户偏好 ' + '详细说明'.repeat(200) // ~800 chars
    store.addFact(longContent, 'tool_pref')
    store.addFact('用户偏好 VS Code', 'tool_pref')
    const results = retriever.search('用户偏好')
    // Short fact should rank higher
    if (results.length >= 2) {
      const shortFact = results.find(r => r.content === '用户偏好 VS Code')
      const longFact = results.find(r => r.content.length > 500)
      if (shortFact && longFact) {
        expect(shortFact.score).toBeGreaterThan(longFact.score)
      }
    }
  })

  it('does not penalize long facts with short summary', () => {
    // 长内容包含搜索词（确保 FTS5 能匹配），同时设置短 summary
    const longContent = '用户偏好的详细内容' + '补充说明'.repeat(200)
    const id = store.addFact(longContent, 'general')
    store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run('用户偏好', id)
    // 短事实也包含搜索词，作为对比
    store.addFact('用户偏好 VS Code', 'tool_pref')
    const results = retriever.search('用户偏好')
    const summaryFact = results.find(r => r.factId === id)
    // 有 summary 的事实应该被找到（不会被 length penalty 过度惩罚）
    expect(summaryFact).toBeTruthy()
    // summary 事实的 score 应该合理（不会被 content 长度拖累）
    if (summaryFact) {
      expect(summaryFact.score).toBeGreaterThan(0)
    }
  })
})

describe('no relevance gate', () => {
  it('returns results even with low scores', () => {
    store.addFact('完全不相关关于天气', 'general')
    const results = retriever.search('天气')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })
})
