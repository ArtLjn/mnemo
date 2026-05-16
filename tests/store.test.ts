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

describe('schema migration', () => {
  it('has summary column on facts table', () => {
    const cols = store.connection.pragma('table_info(facts)') as Array<{ name: string }>
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain('summary')
    expect(colNames).toContain('last_retrieved_at')
  })

  it('has retrieval_log table', () => {
    const tables = store.connection.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='retrieval_log'"
    ).get()
    expect(tables).toBeTruthy()
  })

  it('summary defaults to null', () => {
    const id = store.addFact('test summary fact', 'general')
    const row = store.connection.prepare('SELECT summary FROM facts WHERE fact_id = ?').get(id) as { summary: string | null }
    expect(row.summary).toBeNull()
  })
})

describe('logRetrieval', () => {
  it('writes retrieval log with results', () => {
    const id = store.addFact('test fact for logging', 'general')
    store.logRetrieval('test query', [{ id, score: 0.8 }])
    const rows = store.connection.prepare('SELECT * FROM retrieval_log').all() as Array<any>
    expect(rows.length).toBe(1)
    expect(rows[0].query).toBe('test query')
    expect(JSON.parse(rows[0].results)).toEqual([{ id, score: 0.8 }])
  })

  it('updates last_retrieved_at for returned facts', () => {
    const id = store.addFact('test fact for timestamp', 'general')
    store.logRetrieval('query', [{ id, score: 0.5 }])
    const row = store.connection.prepare('SELECT last_retrieved_at FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.last_retrieved_at).not.toBeNull()
  })

  it('prunes log to max entries', () => {
    for (let i = 0; i < 12; i++) {
      store.logRetrieval(`query ${i}`, [])
    }
    store.pruneRetrievalLog(10)
    const count = (store.connection.prepare('SELECT COUNT(*) as c FROM retrieval_log').get() as any).c
    expect(count).toBe(10)
  })
})

describe('runLearning', () => {
  it('demotes moderate retrieval low helpful facts', () => {
    const id = store.addFact('demote me', 'general')
    store.connection.prepare('UPDATE facts SET retrieval_count = 50, helpful_count = 1, trust_score = 1.0 WHERE fact_id = ?').run(id)
    const result = store.runLearning()
    const row = store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.trust_score).toBeLessThan(1.0)
    expect(result.demoted).toBeGreaterThanOrEqual(1)
  })

  it('protects high frequency facts from demotion', () => {
    const id = store.addFact('高频角色设定', 'identity')
    store.connection.prepare('UPDATE facts SET retrieval_count = 200, helpful_count = 2, trust_score = 0.9 WHERE fact_id = ?').run(id)
    store.runLearning()
    const row = store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.trust_score).toBe(0.9)
  })

  it('still demotes moderate frequency facts with low trust', () => {
    const id = store.addFact('中频低信任', 'general')
    store.connection.prepare('UPDATE facts SET retrieval_count = 50, helpful_count = 0, trust_score = 0.3 WHERE fact_id = ?').run(id)
    store.runLearning()
    const row = store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.trust_score).toBeLessThan(0.3)
  })

  it('promotes high helpful rate facts', () => {
    const id = store.addFact('promote me', 'general')
    store.connection.prepare('UPDATE facts SET retrieval_count = 50, helpful_count = 20, trust_score = 0.5 WHERE fact_id = ?').run(id)
    store.runLearning()
    const row = store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.trust_score).toBeGreaterThan(0.5)
  })

  it('does not adjust facts with low retrieval count', () => {
    const id = store.addFact('new fact', 'general')
    store.connection.prepare('UPDATE facts SET retrieval_count = 5, helpful_count = 0, trust_score = 0.8 WHERE fact_id = ?').run(id)
    store.runLearning()
    const row = store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.trust_score).toBe(0.8)
  })

  it('ages facts not retrieved for 60 days', () => {
    const id = store.addFact('old fact', 'general')
    store.connection.prepare("UPDATE facts SET last_retrieved_at = datetime('now', '-61 days'), trust_score = 0.8 WHERE fact_id = ?").run(id)
    store.runLearning()
    const row = store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.trust_score).toBeLessThan(0.8)
  })

  it('protects new facts with null last_retrieved_at from aging', () => {
    const id = store.addFact('brand new fact', 'general')
    store.connection.prepare('UPDATE facts SET trust_score = 0.5, last_retrieved_at = NULL WHERE fact_id = ?').run(id)
    store.runLearning()
    const row = store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.trust_score).toBe(0.5)
  })

  it('returns long_facts report', () => {
    const id = store.addFact('x'.repeat(600), 'general')
    const result = store.runLearning()
    expect(result.long_facts.length).toBeGreaterThanOrEqual(1)
    expect(result.long_facts.some((f: any) => f.id === id)).toBe(true)
  })
})

describe('runAudit', () => {
  it('returns quality report without modifying data', () => {
    const id = store.addFact('a'.repeat(600), 'general')
    store.connection.prepare('UPDATE facts SET retrieval_count = 100, helpful_count = 1 WHERE fact_id = ?').run(id)
    const before = (store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any).trust_score
    const report = store.runAudit()
    const after = (store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any).trust_score
    expect(before).toBe(after)
    expect(report.total_facts).toBeGreaterThanOrEqual(1)
    expect(report.long_without_summary.length).toBeGreaterThanOrEqual(1)
  })
})

describe('dream - backup', () => {
  it('creates backup before dream', async () => {
    store.addFact('test fact for backup', 'general')
    const result = await store.backupDatabase()
    expect(result).toBeTruthy()
    expect(result).toContain('dream-')
    expect(result).toContain('.db')
  })
})

describe('dream - compress', () => {
  it('generates summary for long facts without summary', () => {
    const longContent = '用户偏好使用 TypeScript 开发前端项目。偏好 React 框架进行组件化开发。' + '额外补充说明'.repeat(50)
    store.addFact(longContent, 'coding_style')
    const result = store.compressLongFacts()
    expect(result).toBeGreaterThanOrEqual(1)
    const row = store.connection.prepare('SELECT summary FROM facts WHERE content = ?').get(longContent) as any
    expect(row.summary).toBeTruthy()
    expect(row.summary.length).toBeLessThanOrEqual(150)
    expect(row.summary).toContain('TypeScript')
  })

  it('skips facts with existing summary', () => {
    const longContent = 'x'.repeat(300)
    const id = store.addFact(longContent, 'general')
    store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run('existing summary', id)
    const result = store.compressLongFacts()
    expect(result).toBe(0)
    const row = store.connection.prepare('SELECT summary FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.summary).toBe('existing summary')
  })

  it('skips short facts', () => {
    store.addFact('short fact', 'general')
    const result = store.compressLongFacts()
    expect(result).toBe(0)
  })
})

describe('dream - merge', () => {
  it('merges overlapping facts in same category', () => {
    store.addFact('用户偏好使用 TypeScript 编写前端代码', 'coding_style')
    store.addFact('用户偏好使用 TypeScript 编写后端代码', 'coding_style')
    const result = store.mergeOverlappingFacts()
    expect(result.merged).toBeGreaterThanOrEqual(1)
    expect(result.details.length).toBeGreaterThanOrEqual(1)
  })

  it('protects high frequency facts from deletion', () => {
    const id1 = store.addFact('用户偏好使用 TypeScript 编写前端代码', 'coding_style')
    const id2 = store.addFact('用户偏好使用 TypeScript 编写前端代码扩展', 'coding_style')
    store.connection.prepare('UPDATE facts SET retrieval_count = 200 WHERE fact_id = ?').run(id1)
    const result = store.mergeOverlappingFacts()
    const kept = store.connection.prepare('SELECT fact_id FROM facts WHERE fact_id = ?').get(id1) as any
    expect(kept).toBeTruthy()
  })

  it('does not merge facts across categories', () => {
    store.addFact('用户偏好使用 TypeScript 编写前端代码', 'coding_style')
    store.addFact('用户偏好使用 TypeScript 编写前端代码', 'general')
    const result = store.mergeOverlappingFacts()
    expect(result.merged).toBe(0)
  })

  it('does not merge when both facts are high frequency', () => {
    const id1 = store.addFact('高频测试事实 AAA 长内容匹配', 'coding_style')
    const id2 = store.addFact('高频测试事实 BBB 长内容匹配', 'coding_style')
    store.connection.prepare('UPDATE facts SET retrieval_count = 200 WHERE fact_id IN (?, ?)').run(id1, id2)
    const result = store.mergeOverlappingFacts()
    // Both facts should still exist
    const row1 = store.connection.prepare('SELECT fact_id FROM facts WHERE fact_id = ?').get(id1) as any
    const row2 = store.connection.prepare('SELECT fact_id FROM facts WHERE fact_id = ?').get(id2) as any
    expect(row1).toBeTruthy()
    expect(row2).toBeTruthy()
  })
})

describe('dream - reclassify', () => {
  it('moves miscategorized facts from general to correct category', () => {
    const id = store.addFact('编码规范：文件不超过 500 行', 'general')
    const result = store.reclassifyFacts()
    expect(result).toBeGreaterThanOrEqual(1)
    const row = store.connection.prepare('SELECT category FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.category).toBe('coding_style')
  })

  it('skips already categorized facts', () => {
    store.addFact('编码规范：文件不超过 500 行', 'coding_style')
    const result = store.reclassifyFacts()
    expect(result).toBe(0)
  })
})

describe('dream - runDream', () => {
  it('runs full dream cycle and returns report', async () => {
    // 长文 fact（触发压缩）
    store.addFact('用户偏好使用 TypeScript 开发前端。使用 React 框架。' + 'x'.repeat(250), 'coding_style')
    // 重叠 fact（触发合并）
    store.addFact('用户偏好使用 TypeScript 开发前端代码', 'coding_style')
    // 分类错误 fact（触发重分类）
    store.addFact('编码规范：文件不超过 500 行', 'general')

    const report = await store.runDream({ skipBackup: true })
    expect(report.compressed).toBeGreaterThanOrEqual(0)
    expect(report.merged).toBeGreaterThanOrEqual(0)
    expect(report.reclassified).toBeGreaterThanOrEqual(0)
    expect(report.health.total).toBeGreaterThanOrEqual(1)
    expect(report.health.coverage).toBeTruthy()
    expect(report.fallback).toBe(true) // 测试环境无 Ollama，应降级到规则引擎
  })
})
