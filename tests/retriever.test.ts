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
