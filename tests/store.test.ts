import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let store: MemoryStore
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mnemo-test-'))
  store = new MemoryStore(join(tmpDir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('MemoryStore', () => {
  describe('addFact', () => {
    it('should add a fact and return fact_id', () => {
      const id = store.addFact('用户偏好深色主题', 'tool_pref', 'theme,dark')
      expect(id).toBeGreaterThan(0)
    })

    it('should return existing id for duplicate content', () => {
      const id1 = store.addFact('用户偏好深色主题', 'tool_pref')
      const id2 = store.addFact('用户偏好深色主题', 'tool_pref')
      expect(id1).toBe(id2)
    })

    it('should throw for empty content', () => {
      expect(() => store.addFact('')).toThrow('content must not be empty')
    })
  })

  describe('findSimilarFact', () => {
    it('should find similar fact by entity overlap + edit distance', () => {
      store.addFact('用户使用 Express 框架开发后端', 'coding_style', 'express')
      const similar = store.findSimilarFact('用户使用 Fastify 框架开发后端')
      expect(similar).not.toBeNull()
    })

    it('should return null for unrelated content', () => {
      store.addFact('用户喜欢深色主题', 'tool_pref')
      const similar = store.findSimilarFact('部署到 AWS 需要配置环境变量')
      expect(similar).toBeNull()
    })
  })

  describe('updateFact / removeFact', () => {
    it('should update fact content', () => {
      const id = store.addFact('旧内容', 'general')
      const updated = store.updateFact(id, { content: '新内容' })
      expect(updated).toBe(true)
      const facts = store.listFacts('general', 0, 10)
      expect(facts[0].content).toBe('新内容')
    })

    it('should remove fact', () => {
      const id = store.addFact('待删除', 'general')
      const removed = store.removeFact(id)
      expect(removed).toBe(true)
    })
  })

  describe('recordFeedback', () => {
    it('should increase trust on helpful', () => {
      const id = store.addFact('测试事实', 'general')
      const result = store.recordFeedback(id, true)
      expect(result.newTrust).toBeGreaterThan(result.oldTrust)
    })

    it('should decrease trust on unhelpful', () => {
      const id = store.addFact('测试事实', 'general')
      const result = store.recordFeedback(id, false)
      expect(result.newTrust).toBeLessThan(result.oldTrust)
    })
  })

  describe('entity extraction', () => {
    it('should extract English entities', () => {
      const id = store.addFact('使用 Visual Studio Code 编辑器', 'tool_pref')
      const entities = store.getEntitiesForFact(id)
      expect(entities).toContain('Visual Studio Code')
    })

    it('should extract Chinese entities in quotes', () => {
      const id = store.addFact('项目叫「记忆系统」', 'general')
      const entities = store.getEntitiesForFact(id)
      expect(entities.some(e => e.includes('记忆系统'))).toBe(true)
    })
  })

  describe('decayTrustScores', () => {
    it('should not decay fresh facts', () => {
      store.addFact('新鲜事实', 'general')
      const result = store.decayTrustScores()
      expect(result.decayed).toBe(0)
      expect(result.removed).toBe(0)
    })
  })
})
