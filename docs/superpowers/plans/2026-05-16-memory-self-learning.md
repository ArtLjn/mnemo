# Memory Self-Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve mnemo-mcp retrieval accuracy by reverting v3 dynamic weights, adding length penalty for super-long facts, summary field for data quality, retrieval log for self-learning, and learn/audit actions for automatic trust adjustment.

**Architecture:** Revert retriever to static 0.5/0.5 FTS/Jaccard weights. Add length penalty based on matchText (summary or content). New retrieval_log table auto-records every search. New learn action adjusts trust based on retrieval/helpful stats. New audit action reports data quality. Summary field lets long facts provide short matching text.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, @modelcontextprotocol/sdk, zod/v4, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/schema.ts` | **MODIFY** — Add retrieval_log table, FTS5 with summary column, update triggers |
| `src/store.ts` | **MODIFY** — Add summary/last_retrieved_at columns, logRetrieval, pruneRetrievalLog, runLearning, runAudit |
| `src/retriever.ts` | **MODIFY** — Revert dynamic weights, remove gate, add length penalty, summary matching |
| `src/server.ts` | **MODIFY** — Add learn/audit handlers, summary support, length warning, auto-learn on start |
| `src/types.ts` | **MODIFY** — Add summary/last_retrieved_at to Fact, learn/audit action types |
| `tests/store.test.ts` | **MODIFY** — New tests for retrieval_log, learning, audit |
| `tests/retriever.test.ts` | **MODIFY** — New tests for length penalty, summary, static weights |

---

## Task 1: Schema Migration — retrieval_log + summary + last_retrieved_at + FTS5 rebuild

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/store.ts` (migrateSchema)
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write failing test for new columns**

Append to `tests/store.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/store.test.ts -t "schema migration"`
Expected: FAIL — summary column doesn't exist yet

- [ ] **Step 3: Update `src/schema.ts` — add retrieval_log table, rebuild FTS5 with summary**

Replace entire file content:

```typescript
export const SCHEMA = `
-- 事实表
CREATE TABLE IF NOT EXISTS facts (
  fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content         TEXT NOT NULL UNIQUE,
  category        TEXT DEFAULT 'general',
  tags            TEXT DEFAULT '',
  keywords        TEXT DEFAULT '[]',
  trust_score     REAL DEFAULT 0.5,
  retrieval_count INTEGER DEFAULT 0,
  helpful_count   INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 实体表
CREATE TABLE IF NOT EXISTS entities (
  entity_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  entity_type TEXT DEFAULT 'unknown',
  aliases     TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 事实-实体关联表
CREATE TABLE IF NOT EXISTS fact_entities (
  fact_id   INTEGER NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, entity_id)
);

-- 检索日志表
CREATE TABLE IF NOT EXISTS retrieval_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT NOT NULL,
  results    TEXT NOT NULL,
  timestamp  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_facts_trust    ON facts(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);
CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_log_ts ON retrieval_log(timestamp);

-- FTS5 全文索引（含 summary 列）
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
  USING fts5(content, tags, summary, content=facts, content_rowid=fact_id);

-- FTS5 同步触发器：插入
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content, tags, summary)
    VALUES (new.fact_id, new.content, new.tags, COALESCE(new.summary, ''));
END;

-- FTS5 同步触发器：删除
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, tags, summary)
    VALUES ('delete', old.fact_id, old.content, old.tags, COALESCE(old.summary, ''));
END;

-- FTS5 同步触发器：更新
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, tags, summary)
    VALUES ('delete', old.fact_id, old.content, old.tags, COALESCE(old.summary, ''));
  INSERT INTO facts_fts(rowid, content, tags, summary)
    VALUES (new.fact_id, new.content, new.tags, COALESCE(new.summary, ''));
END;
`
```

- [ ] **Step 4: Update `src/store.ts` migrateSchema — add columns + rebuild FTS5**

Replace the `migrateSchema()` method in `src/store.ts` (lines 112-117):

```typescript
  /** 增量迁移：添加新列/新表（已存在则跳过） */
  private migrateSchema(): void {
    const addColumn = (sql: string) => {
      try { this.db.exec(sql) } catch { /* 列已存在 */ }
    }

    addColumn("ALTER TABLE facts ADD COLUMN keywords TEXT DEFAULT '[]'")
    addColumn('ALTER TABLE facts ADD COLUMN summary TEXT DEFAULT NULL')
    addColumn('ALTER TABLE facts ADD COLUMN last_retrieved_at TEXT DEFAULT NULL')

    // 重建 FTS5 以包含 summary 列（仅在 facts_fts 无 summary 列时执行）
    try {
      this.db.prepare("SELECT summary FROM facts_fts LIMIT 0").get()
    } catch {
      // facts_fts 没有 summary 列，需要重建
      this.db.exec('DROP TABLE IF EXISTS facts_fts')
      this.db.exec('DROP TRIGGER IF EXISTS facts_ai')
      this.db.exec('DROP TRIGGER IF EXISTS facts_ad')
      this.db.exec('DROP TRIGGER IF EXISTS facts_au')
      // 重建会由 SCHEMA 中的 CREATE IF NOT EXISTS 处理
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
          USING fts5(content, tags, summary, content=facts, content_rowid=fact_id)
      `)
      // 重建触发器
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, content, tags, summary)
          VALUES (new.fact_id, new.content, new.tags, COALESCE(new.summary, ''));
      END`)
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, tags, summary)
          VALUES ('delete', old.fact_id, old.content, old.tags, COALESCE(old.summary, ''));
      END`)
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, tags, summary)
          VALUES ('delete', old.fact_id, old.content, old.tags, COALESCE(old.summary, ''));
        INSERT INTO facts_fts(rowid, content, tags, summary)
          VALUES (new.fact_id, new.content, new.tags, COALESCE(new.summary, ''));
      END`)
      // 重新填充 FTS5
      this.db.exec(`INSERT INTO facts_fts(rowid, content, tags, summary)
        SELECT fact_id, content, tags, COALESCE(summary, '') FROM facts`)
    }
  }
```

- [ ] **Step 5: Update `src/types.ts` — add summary and last_retrieved_at to Fact**

In `src/types.ts`, update the `Fact` interface (lines 5-16):

```typescript
/** 存储的事实记录 */
export interface Fact {
  factId: number
  content: string
  summary: string | null
  category: FactCategory
  tags: string
  keywords: string
  trustScore: number
  retrievalCount: number
  helpfulCount: number
  createdAt: string
  updatedAt: string
  lastRetrievedAt: string | null
}
```

Update `FactStoreArgs` action union to include new actions (line 56):

```typescript
export interface FactStoreArgs {
  action: 'add' | 'search' | 'probe' | 'related' | 'reason' | 'contradict' | 'update' | 'remove' | 'list' | 'learn' | 'audit'
  content?: string | string[]
  summary?: string
  query?: string
  entity?: string
  entities?: string[]
  fact_id?: number | number[]
  category?: string
  tags?: string
  trust_delta?: number
  min_trust?: number
  limit?: number
}
```

- [ ] **Step 6: Update `src/store.ts` rowToFact — add new fields**

Replace `rowToFact` method (lines 791-803):

```typescript
  private rowToFact(row: FactRow): Fact {
    return {
      factId: row.fact_id,
      content: row.content,
      summary: (row as any).summary ?? null,
      category: row.category as FactCategory,
      tags: row.tags,
      keywords: row.keywords,
      trustScore: row.trust_score,
      retrievalCount: row.retrieval_count,
      helpfulCount: row.helpful_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRetrievedAt: (row as any).last_retrieved_at ?? null,
    }
  }
```

Update all SQL SELECT statements in store.ts that query facts to include `summary` and `last_retrieved_at`. For `listFacts` (line 363):

```sql
SELECT fact_id, content, summary, category, tags, keywords, trust_score,
       retrieval_count, helpful_count, created_at, updated_at, last_retrieved_at
FROM facts
```

Apply the same pattern to `getFactsByEntity`, `getFactsByEntities`, `updateFact`, and `recordFeedback` queries.

- [ ] **Step 7: Run schema migration tests**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/store.test.ts -t "schema migration"`
Expected: PASS

- [ ] **Step 8: Run full build**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npm run build`
Expected: BUILD OK

- [ ] **Step 9: Commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp
git add src/schema.ts src/store.ts src/types.ts tests/store.test.ts
git commit -m "feat(store): add retrieval_log table, summary/last_retrieved_at columns, FTS5 rebuild"
```

---

## Task 2: Store — logRetrieval + pruneRetrievalLog + runLearning + runAudit

**Files:**
- Modify: `src/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/store.test.ts`:

```typescript
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
  it('demotes high retrieval low helpful facts', () => {
    const id = store.addFact('demote me', 'general')
    // Simulate 100 retrievals, 2 helpful
    store.connection.prepare('UPDATE facts SET retrieval_count = 100, helpful_count = 2, trust_score = 1.0 WHERE fact_id = ?').run(id)
    const result = store.runLearning()
    const row = store.connection.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.trust_score).toBeLessThan(1.0)
    expect(result.demoted).toBeGreaterThanOrEqual(1)
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
    expect(before).toBe(after) // audit does not modify
    expect(report.total_facts).toBeGreaterThanOrEqual(1)
    expect(report.long_without_summary.length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/store.test.ts -t "logRetrieval|runLearning|runAudit"`
Expected: FAIL — methods don't exist yet

- [ ] **Step 3: Add methods to `src/store.ts`**

Add these methods to the `MemoryStore` class, after the `getTotalCount()` method (after line 636):

```typescript
  /** 记录检索日志并更新 last_retrieved_at */
  logRetrieval(query: string, results: Array<{ id: number; score: number }>): void {
    const resultsJson = JSON.stringify(results)
    this.db.prepare(
      "INSERT INTO retrieval_log (query, results) VALUES (?, ?)"
    ).run(query, resultsJson)

    // 更新返回 fact 的 last_retrieved_at
    if (results.length > 0) {
      const ids = results.map(r => r.id)
      const placeholders = ids.map(() => '?').join(',')
      this.db.prepare(
        `UPDATE facts SET last_retrieved_at = datetime('now', 'localtime') WHERE fact_id IN (${placeholders})`
      ).run(...ids)
    }

    // 自动清理日志
    this.pruneRetrievalLog(5000)
  }

  /** 清理检索日志，保留最近 maxEntries 条 */
  pruneRetrievalLog(maxEntries = 5000): void {
    this.db.prepare(
      `DELETE FROM retrieval_log WHERE id NOT IN (
        SELECT id FROM retrieval_log ORDER BY id DESC LIMIT ?
      )`
    ).run(maxEntries)
  }

  /** 自学习：基于检索统计自动调整 trust_score */
  runLearning(): {
    promoted: number
    demoted: number
    aged: number
    unchanged: number
    long_facts: Array<{ id: number; content_length: number; penalty: number; has_summary: boolean }>
  } {
    const rows = this.db.prepare(
      'SELECT fact_id, content, summary, retrieval_count, helpful_count, trust_score, last_retrieved_at FROM facts'
    ).all() as Array<{
      fact_id: number; content: string; summary: string | null;
      retrieval_count: number; helpful_count: number; trust_score: number; last_retrieved_at: string | null
    }>

    let promoted = 0
    let demoted = 0
    let aged = 0
    let unchanged = 0
    const longFacts: Array<{ id: number; content_length: number; penalty: number; has_summary: boolean }> = []

    const now = Date.now()

    for (const row of rows) {
      let changed = false
      const rate = row.retrieval_count > 0 ? row.helpful_count / row.retrieval_count : 0

      // Rate-based adjustment (需要 30+ 次检索)
      if (row.retrieval_count > 30) {
        if (rate < 0.05) {
          const newTrust = clampTrust(row.trust_score * 0.9)
          this.db.prepare('UPDATE facts SET trust_score = ? WHERE fact_id = ?').run(newTrust, row.fact_id)
          demoted++
          changed = true
        } else if (rate > 0.3) {
          const newTrust = clampTrust(row.trust_score + 0.05)
          this.db.prepare('UPDATE facts SET trust_score = ? WHERE fact_id = ?').run(newTrust, row.fact_id)
          promoted++
          changed = true
        }
      }

      // Aging (60 天未检索)
      if (row.last_retrieved_at) {
        const lastRetrieved = new Date(row.last_retrieved_at + 'Z').getTime()
        const daysSinceRetrieval = (now - lastRetrieved) / 86_400_000
        if (daysSinceRetrieval > 60) {
          const currentTrust = this.db.prepare('SELECT trust_score FROM facts WHERE fact_id = ?').get(row.fact_id) as any
          const newTrust = clampTrust(currentTrust.trust_score * 0.95)
          this.db.prepare('UPDATE facts SET trust_score = ? WHERE fact_id = ?').run(newTrust, row.fact_id)
          aged++
          changed = true
        }
      }
      // last_retrieved_at 为 NULL = 新 fact，不老化

      if (!changed) unchanged++

      // Long facts report (content > 300 字无 summary)
      const matchLength = row.summary ? row.summary.length : row.content.length
      if (matchLength > 300) {
        longFacts.push({
          id: row.fact_id,
          content_length: row.content.length,
          penalty: Math.min(1.0, 300 / matchLength),
          has_summary: !!row.summary,
        })
      }
    }

    return { promoted, demoted, aged, unchanged, long_facts: longFacts }
  }

  /** 数据质量审计（只读，不修改数据） */
  runAudit(): {
    total_facts: number
    long_without_summary: Array<{ id: number; content_length: number }>
    low_helpful_rate: Array<{ id: number; rate: number; retrieval_count: number }>
    aging_candidates: Array<{ id: number; last_retrieved_at: string | null }>
  } {
    const rows = this.db.prepare(
      'SELECT fact_id, content, summary, retrieval_count, helpful_count, last_retrieved_at FROM facts'
    ).all() as Array<{
      fact_id: number; content: string; summary: string | null;
      retrieval_count: number; helpful_count: number; last_retrieved_at: string | null
    }>

    const longWithoutSummary: Array<{ id: number; content_length: number }> = []
    const lowHelpfulRate: Array<{ id: number; rate: number; retrieval_count: number }> = []
    const agingCandidates: Array<{ id: number; last_retrieved_at: string | null }> = []

    const now = Date.now()

    for (const row of rows) {
      // 超 500 字无 summary
      if (row.content.length > 500 && !row.summary) {
        longWithoutSummary.push({ id: row.fact_id, content_length: row.content.length })
      }

      // 低 helpful 率（>30 次检索，rate < 5%）
      if (row.retrieval_count > 30) {
        const rate = row.helpful_count / row.retrieval_count
        if (rate < 0.05) {
          lowHelpfulRate.push({ id: row.fact_id, rate: Math.round(rate * 1000) / 1000, retrieval_count: row.retrieval_count })
        }
      }

      // 老化候选（>60 天未检索）
      if (row.last_retrieved_at) {
        const lastRetrieved = new Date(row.last_retrieved_at + 'Z').getTime()
        const daysSince = (now - lastRetrieved) / 86_400_000
        if (daysSince > 60) {
          agingCandidates.push({ id: row.fact_id, last_retrieved_at: row.last_retrieved_at })
        }
      }
    }

    return {
      total_facts: rows.length,
      long_without_summary: longWithoutSummary,
      low_helpful_rate: lowHelpfulRate,
      aging_candidates: agingCandidates,
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/store.test.ts -t "logRetrieval|runLearning|runAudit"`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp
git add src/store.ts tests/store.test.ts
git commit -m "feat(store): add logRetrieval, pruneRetrievalLog, runLearning, runAudit"
```

---

## Task 3: Retriever — revert dynamic weights + length penalty + summary matching

**Files:**
- Modify: `src/retriever.ts`
- Test: `tests/retriever.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/retriever.test.ts`:

```typescript
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
    const longContent = '详细内容' + '补充说明'.repeat(200)
    // Add via SQL to set summary
    const id = store.addFact(longContent, 'general')
    store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run('用户偏好', id)
    store.addFact('完全无关的内容', 'general')
    const results = retriever.search('用户偏好')
    const summaryFact = results.find(r => r.factId === id)
    expect(summaryFact).toBeTruthy()
  })
})

describe('no relevance gate', () => {
  it('returns results even with low scores', () => {
    store.addFact('完全不相关关于天气', 'general')
    const results = retriever.search('天气')
    // Should not be filtered out by a 0.15 threshold
    expect(results.length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/retriever.test.ts -t "static weights|length penalty|no relevance gate"`
Expected: Some tests FAIL (dynamic weights still active, no length penalty)

- [ ] **Step 3: Modify `src/retriever.ts` search() method**

Replace lines 116-175 (the scoring and filtering section) in `search()`:

```typescript
    // Stage 2-4: Jaccard 重排序 + 信任评分 + 时间衰减
    // 静态权重（回退 v3 动态权重）
    const queryTokens = this.tokenize(searchQuery)

    const scored: ScoredFact[] = []

    for (const fact of candidates) {
      // summary 优先用于匹配
      const matchText = fact.summary ?? fact.content
      const matchTokens = this.tokenize(matchText)
      const tagTokens = this.tokenize(fact.tags)
      const allTokens = new Set([...matchTokens, ...tagTokens])

      const jaccard = this.jaccardSimilarity(queryTokens, allTokens)
      const qInF = this.containmentScore(queryTokens, allTokens)
      const similarity = 0.3 * jaccard + 0.7 * qInF
      const ftsScore = fact.ftsRank

      // 静态权重 0.5/0.5
      const relevance = 0.5 * ftsScore + 0.5 * similarity
      let score = relevance * fact.trustScore

      // 时间衰减
      if (this.halfLifeDays > 0) {
        score *= this.temporalDecay(fact.updatedAt || fact.createdAt)
      }

      // Length penalty：基于 matchText 长度
      score *= Math.min(1.0, 300 / matchText.length)

      scored.push({ ...fact, score })
    }

    scored.sort((a, b) => b.score - a.score)

    // 取 limit 条（不再做 relevance gate 和 content dedup）
    const results = scored.slice(0, limit)

    // 检索追踪：递增 retrieval_count + top3 信任刷新
    if (results.length > 0) {
      this.trackRetrieval(results)
    }
```

Note: The `trackRetrieval` call at the end stays the same. Remove the `RELEVANCE_THRESHOLD` constant and the content dedup loop entirely.

- [ ] **Step 4: Update `store.ts` `logRetrieval` call — add retrieval logging**

After the `trackRetrieval(results)` call in `search()`, add:

```typescript
    // 记录检索日志
    this.store.logRetrieval(searchQuery, results.map(r => ({ id: r.factId, score: Math.round(r.score * 1000) / 1000 })))
```

But wrap it so it doesn't log when cache hits (the return before this point). The `logRetrieval` should only be called on cache miss. Place it right before the cache set at line ~182.

- [ ] **Step 5: Update ftsCandidates to search summary field**

In `ftsCandidates()` method, the SQL query (line ~483) joins `facts_fts` which now includes the `summary` column. FTS5 will automatically match against all indexed columns (content, tags, summary). No SQL change needed — the FTS5 virtual table now includes summary.

However, update the `ftsCandidates` return to include `summary` from the joined row. Add to the mapping (around line 506):

```typescript
      summary: String(row.summary ?? ''),
```

- [ ] **Step 6: Run tests**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/retriever.test.ts`
Expected: ALL PASS (including new tests)

- [ ] **Step 7: Commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp
git add src/retriever.ts tests/retriever.test.ts
git commit -m "feat(retriever): revert dynamic weights, add length penalty, summary matching, remove relevance gate"
```

---

## Task 4: Server — learn/audit handlers + summary support + length warning + auto-learn

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Update factStoreSchema — add learn/audit actions and summary param**

Replace `factStoreSchema` (lines 29-41):

```typescript
const factStoreSchema = {
  action: z.enum(['add', 'search', 'probe', 'related', 'reason', 'contradict', 'update', 'remove', 'list', 'learn', 'audit']),
  content: z.union([z.string(), z.array(z.string())]).optional().describe("事实内容（'add' 必需，支持批量）"),
  summary: z.string().optional().describe('超长事实的摘要（检索用 summary 匹配）'),
  query: z.string().optional().describe("搜索查询（'search' 必需）"),
  entity: z.string().optional().describe("实体名（'probe'/'related' 使用）"),
  entities: z.array(z.string()).optional().describe("实体列表（'reason' 使用）"),
  fact_id: z.union([z.number(), z.array(z.number())]).optional().describe("事实 ID（'update'/'remove' 使用，支持批量）"),
  category: z.enum(['identity', 'coding_style', 'tool_pref', 'workflow', 'general']).optional(),
  tags: z.string().optional().describe('逗号分隔标签'),
  trust_delta: z.number().optional().describe("'update' 的信任调整值"),
  min_trust: z.number().optional().describe('最低信任过滤（默认 0.3）'),
  limit: z.number().optional().describe('最大结果数（默认 10）'),
}
```

- [ ] **Step 2: Update add handler — summary support + 500-char warning**

Replace the `case 'add':` block (lines 82-112). After the existing `for` loop but before cache clear, add summary handling. In the `for` loop, when adding a new fact, also save summary:

After `store.addFact(content, category, a.tags ?? '')` for new facts, add:
```typescript
if (a.summary) {
  store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run(a.summary, factId)
}
```

And before the results push for both similar and new cases, add the 500-char warning:
```typescript
if (content.length > 500 && !a.summary) {
  warnings = [...(warnings ?? []), 'content 超过 500 字，建议提供 summary 或拆分为多条 fact']
}
```

Also trigger FTS reindex after summary update by deleting and reinserting into facts_fts.

- [ ] **Step 3: Update update handler — summary support**

In `case 'update':`, after `store.updateFact(...)`, add summary update:
```typescript
if (a.summary !== undefined) {
  store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run(a.summary, a.fact_id as number)
  // Trigger FTS reindex
  store.connection.prepare(
    "INSERT INTO facts_fts(facts_fts, rowid, content, tags, summary) VALUES ('delete', ?, '', '', '')"
  ).run(a.fact_id as number)
  const row = store.connection.prepare('SELECT content, tags, summary FROM facts WHERE fact_id = ?').get(a.fact_id as number) as any
  store.connection.prepare(
    'INSERT INTO facts_fts(rowid, content, tags, summary) VALUES (?, ?, ?, ?)'
  ).run(a.fact_id as number, row.content, row.tags, row.summary ?? '')
}
```

Actually, the FTS update trigger should handle this automatically if we UPDATE the facts table. But the trigger uses `COALESCE(new.summary, '')` which is correct. Let's use `updateFact` to set summary by extending the updateFact method or just doing a direct UPDATE + relying on the trigger.

The simplest approach: update summary via direct SQL after `updateFact`:
```typescript
if (a.summary !== undefined) {
  store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run(a.summary, a.fact_id as number)
}
```
The `facts_au` trigger will automatically reindex FTS5.

- [ ] **Step 4: Add learn and audit cases**

Add before `case 'list':`:

```typescript
        case 'learn': {
          const result = store.runLearning()
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        }

        case 'audit': {
          const report = store.runAudit()
          return { content: [{ type: 'text' as const, text: JSON.stringify(report) }] }
        }
```

- [ ] **Step 5: Add startup auto-learn with nextTick**

Replace lines 62-63 (startup maintenance):

```typescript
// Startup maintenance
store.decayTrustScores()
store.auditContradictions()

// Auto-learn on startup (non-blocking)
process.nextTick(() => {
  try {
    const result = store.runLearning()
    if (result.demoted > 0 || result.aged > 0 || result.long_facts.length > 0) {
      console.error(`[mnemo:auto-learn] promoted=${result.promoted} demoted=${result.demoted} aged=${result.aged} long_facts=${result.long_facts.length}`)
    }
  } catch (err) {
    console.error('[mnemo:auto-learn] error:', err)
  }
})
```

- [ ] **Step 6: Run build + all tests**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npm run build && npx vitest run`
Expected: BUILD OK, ALL TESTS PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp
git add src/server.ts
git commit -m "feat(server): add learn/audit actions, summary support, length warning, auto-learn on startup"
```

---

## Task 5: End-to-end verification

**Files:** None (manual verification)

- [ ] **Step 1: Build and test**

Run: `cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npm run build && npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Test against real database**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fact_store","arguments":{"action":"search","query":"你是谁"}}}' | node dist/server.js 2>&1 | tail -5
```

- [ ] **Step 3: Test audit action**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fact_store","arguments":{"action":"audit"}}}' | node dist/server.js 2>&1 | tail -5
```

- [ ] **Step 4: Bump version**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npm version minor --no-git-tag-version
```

- [ ] **Step 5: Final commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp
git add .
git commit -m "chore: prepare v0.2.0 — memory self-learning release"
```

---

## Self-Review

### Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| retrieval_log 表 + [{id, score}] 格式 | Task 1 (schema) + Task 2 (logRetrieval) |
| logRetrieval 更新 last_retrieved_at | Task 2 |
| pruneRetrievalLog 5000 条上限 | Task 2 |
| learn action: rate-based trust adjustment | Task 2 (runLearning) + Task 4 (handler) |
| learn action: aging based on last_retrieved_at | Task 2 |
| learn action: new fact protection (NULL last_retrieved_at) | Task 2 |
| learn returns long_facts report | Task 2 |
| audit action: quality report, no data modification | Task 2 (runAudit) + Task 4 (handler) |
| length penalty: matchText-based (summary or content) | Task 3 |
| length penalty: 300-char threshold | Task 3 |
| static FTS/Jaccard 0.5/0.5 weights | Task 3 |
| summary field on facts table | Task 1 |
| summary indexed by FTS5 | Task 1 (schema + triggers) |
| summary matching in retriever | Task 3 |
| 500-char write warning | Task 4 |
| add/update support summary param | Task 4 |
| server startup auto-learn with nextTick | Task 4 |
| keep refineQuery | No change needed (already in code) |
| remove relevance gate | Task 3 |
| remove content dedup | Task 3 |
| backward compatible migration | Task 1 |

### Placeholder Scan

- [x] No "TBD", "TODO", "implement later"
- [x] No vague "add error handling" without code
- [x] All file paths are exact
- [x] All code blocks contain complete implementations

### Type Consistency

- [x] `Fact.summary` is `string | null` in types.ts, store.ts rowToFact, retriever.ts
- [x] `Fact.lastRetrievedAt` is `string | null` in types.ts and store.ts
- [x] `FactStoreArgs.action` includes `'learn' | 'audit'` in types.ts and server.ts zod schema
- [x] `FactStoreArgs.summary` is `string` optional in types.ts and server.ts zod schema
- [x] `runLearning()` return type matches `{promoted, demoted, aged, unchanged, long_facts}` in store.ts and server.ts handler
- [x] `runAudit()` return type matches `{total_facts, long_without_summary, low_helpful_rate, aging_candidates}` in store.ts and server.ts handler
