# Memory Dreaming 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mnemo-mcp 添加后台记忆整理（dream）和搜索结果精简功能，保持数据库精炼、减少 token 消耗。

**Architecture:** 在 `MemoryStore` 中新增 `runDream()` 方法，编排合并去重、摘要压缩、分类修正三阶段。新增 `CompactResult` 类型精简搜索返回字段。新增 CLI 入口 `src/dream.ts`。

**Tech Stack:** TypeScript, better-sqlite3, Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/types.ts` | 新增 `DreamReport` 和 `CompactFactResult` 类型 |
| `src/store.ts` | 新增 `runDream()`、`mergeOverlappingFacts()`、`compressLongFacts()`、`reclassifyFacts()`、`backupDatabase()` |
| `src/retriever.ts` | 搜索结果格式化为 `CompactFactResult` |
| `src/server.ts` | 新增 `dream` action，所有搜索 action 使用精简格式 |
| `src/dream.ts` | CLI 入口，执行 dream 并输出 report |
| `package.json` | 新增 `mnemo-dream` bin |
| `tests/store.test.ts` | dream 相关单元测试 |

---

### Task 1: 新增类型定义

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: 在 types.ts 末尾添加 DreamReport 和 CompactFactResult 类型**

```typescript
/** Dream 整理报告 */
export interface DreamReport {
  merged: number
  compressed: number
  reclassified: number
  deleted: number
  mergeDetails: Array<{ kept: number; removed: number; similarity: number }>
  health: {
    total: number
    avg_trust: number
    avg_length: number
    coverage: Record<FactCategory, number>
  }
}

/** 精简搜索结果 */
export interface CompactFactResult {
  factId: number
  display: string
  category: FactCategory
  trustScore: number
  score: number
}
```

- [ ] **Step 2: 更新 FactStoreArgs 的 action 联合类型**

在 `src/types.ts` 的 `FactStoreArgs.action` 字段中，把 `'learn' | 'audit'` 改为 `'learn' | 'audit' | 'dream'`：

```typescript
action: 'add' | 'search' | 'probe' | 'related' | 'reason' | 'contradict' | 'update' | 'remove' | 'list' | 'learn' | 'audit' | 'dream'
```

- [ ] **Step 3: 运行构建确认类型无报错**

Run: `npm run build`
Expected: 编译成功，无报错

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add DreamReport and CompactFactResult types"
```

---

### Task 2: Store 层 dream 方法 — 备份与压缩

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: 写失败测试 — backupDatabase**

在 `tests/store.test.ts` 的最后一个 `describe` 块之后添加：

```typescript
describe('dream - backup', () => {
  it('creates backup before dream', () => {
    const id = store.addFact('test fact for backup', 'general')
    const result = store.backupDatabase()
    expect(result).toBeTruthy()
    expect(result).toContain('dream-')
    expect(result).toContain('.db')
  })
})
```

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `backupDatabase` 不存在

- [ ] **Step 2: 实现 backupDatabase**

在 `src/store.ts` 的 `runAudit()` 方法之后、`get connection()` 之前添加：

```typescript
/** Dream 前备份数据库 */
backupDatabase(): string {
  const { mkdirSync, copyFileSync } = require('node:fs')
  const { join, dirname } = require('node:path')
  const { homedir } = require('node:os')
  const backupDir = join(homedir(), '.mnemo', 'backup')
  mkdirSync(backupDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = join(backupDir, `dream-${timestamp}.db`)
  copyFileSync(this.db.name, backupPath)
  return backupPath
}
```

注意：需要在文件顶部添加 `import { copyFileSync, mkdirSync } from 'node:fs'`（如果还没有的话）。实际上 `mkdirSync` 已在顶部导入了，只需确认 `copyFileSync` 也已导入。检查 store.ts 顶部的 import，如果没有 `copyFileSync`，添加到现有 `mkdirSync` 的 import 行中。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS

- [ ] **Step 4: 写失败测试 — compressLongFacts**

```typescript
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
    const row = store.connection.prepare('SELECT summary FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.summary).toBe('existing summary')
  })

  it('skips short facts', () => {
    store.addFact('short fact', 'general')
    const result = store.compressLongFacts()
    expect(result).toBe(0)
  })
})
```

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `compressLongFacts` 不存在

- [ ] **Step 5: 实现 compressLongFacts**

在 `store.ts` 的 `backupDatabase()` 之后添加：

```typescript
/** 压缩长 fact：content > 200 字且无 summary 的，自动提取前 2 句作为 summary */
compressLongFacts(): number {
  const rows = this.db.prepare(
    'SELECT fact_id, content FROM facts WHERE length(content) > 200 AND (summary IS NULL OR summary = "")'
  ).all() as Array<{ fact_id: number; content: string }>

  let compressed = 0
  for (const row of rows) {
    const summary = this.extractSummary(row.content)
    if (summary) {
      this.db.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run(summary, row.fact_id)
      compressed++
    }
  }
  return compressed
}

/** 从 content 提取前 2 个完整句子（总长 ≤ 150 字） */
private extractSummary(content: string): string | null {
  const sentences = content.split(/[。\n.]/).map(s => s.trim()).filter(s => s.length > 0)
  if (sentences.length === 0) return null
  let summary = sentences[0]
  if (sentences.length > 1 && summary.length + sentences[1].length <= 148) {
    summary += '。' + sentences[1]
  }
  return summary.length <= 150 ? summary : summary.slice(0, 147) + '...'
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat(store): add backupDatabase and compressLongFacts for dream cycle"
```

---

### Task 3: Store 层 dream 方法 — 合并与分类修正

**Files:**
- Modify: `src/store.ts`
- Modify: `tests/store.test.ts`

- [ ] **Step 1: 写失败测试 — mergeOverlappingFacts**

```typescript
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
})
```

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `mergeOverlappingFacts` 不存在

- [ ] **Step 2: 实现 mergeOverlappingFacts**

在 `store.ts` 的 `compressLongFacts()` 之后添加：

```typescript
/** 合并同 category 内 Jaccard > 0.6 的重叠 fact */
mergeOverlappingFacts(): { merged: number; details: Array<{ kept: number; removed: number; similarity: number }> } {
  const categories: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
  let merged = 0
  const details: Array<{ kept: number; removed: number; similarity: number }> = []

  for (const cat of categories) {
    const rows = this.db.prepare(
      'SELECT fact_id, content, retrieval_count FROM facts WHERE category = ? ORDER BY trust_score DESC'
    ).all(cat) as Array<{ fact_id: number; content: string; retrieval_count: number }>

    const removed = new Set<number>()

    for (let i = 0; i < rows.length; i++) {
      if (removed.has(rows[i].fact_id)) continue
      const tokensA = this.tokenizeForDedup(rows[i].content)

      for (let j = i + 1; j < rows.length; j++) {
        if (removed.has(rows[j].fact_id)) continue
        const tokensB = this.tokenizeForDedup(rows[j].content)
        const sim = this.jaccardSimilarity(tokensA, tokensB)

        if (sim > 0.6) {
          // 高频保护：retrieval_count > 100 的不能被删除
          const aHighFreq = rows[i].retrieval_count > 100
          const bHighFreq = rows[j].retrieval_count > 100

          if (aHighFreq && bHighFreq) continue

          let keptId: number, removedId: number
          if (bHighFreq) {
            keptId = rows[j].fact_id
            removedId = rows[i].fact_id
          } else {
            keptId = rows[i].fact_id
            removedId = rows[j].fact_id
          }

          this.removeFact(removedId)
          removed.add(removedId)
          details.push({ kept: keptId, removed: removedId, similarity: Math.round(sim * 100) / 100 })
          merged++
        }
      }
    }
  }
  return { merged, details }
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS

- [ ] **Step 4: 写失败测试 — reclassifyFacts**

```typescript
describe('dream - reclassify', () => {
  it('moves miscategorized facts by keywords', () => {
    const id = store.addFact('编码规范：文件不超过 500 行', 'identity')
    const result = store.reclassifyFacts()
    expect(result).toBeGreaterThanOrEqual(1)
    const row = store.connection.prepare('SELECT category FROM facts WHERE fact_id = ?').get(id) as any
    expect(row.category).toBe('coding_style')
  })

  it('skips correctly categorized facts', () => {
    store.addFact('用户偏好使用 VS Code 编辑器', 'tool_pref')
    const result = store.reclassifyFacts()
    expect(result).toBe(0)
  })
})
```

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `reclassifyFacts` 不存在

- [ ] **Step 5: 实现 reclassifyFacts**

在 `store.ts` 的 `mergeOverlappingFacts()` 之后添加：

```typescript
/** 分类修正：按关键词规则表将误分类的 fact 挪到正确 category */
reclassifyFacts(): number {
  const rules: Array<{ keywords: string[]; target: FactCategory }> = [
    { keywords: ['角色设定', '暖暖', '身份', '编程女朋友', '暖宝宝'], target: 'identity' },
    { keywords: ['编码规范', '代码风格', 'pytest', '文件不超过', '方法不超过'], target: 'coding_style' },
    { keywords: ['工作流', 'OpenSpec', 'writing-plans', 'subagent'], target: 'workflow' },
    { keywords: ['偏好', 'VS Code', '编辑器', 'IDE', '快捷键'], target: 'tool_pref' },
  ]

  const rows = this.db.prepare(
    'SELECT fact_id, content, category FROM facts'
  ).all() as Array<{ fact_id: number; content: string; category: string }>

  let reclassified = 0
  for (const row of rows) {
    for (const rule of rules) {
      if (rule.target === row.category) continue
      if (rule.keywords.some(kw => row.content.includes(kw))) {
        this.db.prepare('UPDATE facts SET category = ? WHERE fact_id = ?').run(rule.target, row.fact_id)
        reclassified++
        break
      }
    }
  }
  return reclassified
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS

- [ ] **Step 7: 写端到端测试 — runDream**

```typescript
describe('dream - runDream', () => {
  it('runs full dream cycle and returns report', () => {
    // 长文 fact（触发压缩）
    store.addFact('用户偏好使用 TypeScript 开发前端。使用 React 框架。' + 'x'.repeat(250), 'coding_style')
    // 重叠 fact（触发合并）
    store.addFact('用户偏好使用 TypeScript 开发前端代码', 'coding_style')
    // 分类错误 fact（触发重分类）
    store.addFact('编码规范：文件不超过 500 行', 'identity')

    const report = store.runDream({ skipBackup: true })
    expect(report.compressed).toBeGreaterThanOrEqual(0)
    expect(report.merged).toBeGreaterThanOrEqual(0)
    expect(report.reclassified).toBeGreaterThanOrEqual(0)
    expect(report.health.total).toBeGreaterThanOrEqual(1)
    expect(report.health.coverage).toBeTruthy()
  })
})
```

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `runDream` 不存在

- [ ] **Step 8: 实现 runDream**

在 `store.ts` 的 `reclassifyFacts()` 之后添加：

```typescript
/** 执行完整 dream cycle：备份 → 压缩 → 合并 → 重分类 → 报告 */
runDream(options?: { skipBackup?: boolean }): DreamReport {
  // 备份
  if (!options?.skipBackup) {
    this.backupDatabase()
  }

  // 阶段 1：压缩长文
  const compressed = this.compressLongFacts()

  // 阶段 2：合并重叠
  const mergeResult = this.mergeOverlappingFacts()

  // 阶段 3：分类修正
  const reclassified = this.reclassifyFacts()

  // 健康统计
  const stats = this.db.prepare(`
    SELECT COUNT(*) as total,
           AVG(trust_score) as avg_trust,
           AVG(length(content)) as avg_length
    FROM facts
  `).get() as { total: number; avg_trust: number; avg_length: number }

  const categories: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
  const coverage: Record<string, number> = {}
  for (const cat of categories) {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM facts WHERE category = ?').get(cat) as { c: number }
    coverage[cat] = row.c
  }

  return {
    merged: mergeResult.merged,
    compressed,
    reclassified,
    deleted: mergeResult.merged,
    mergeDetails: mergeResult.details,
    health: {
      total: stats.total,
      avg_trust: Math.round((stats.avg_trust ?? 0) * 100) / 100,
      avg_length: Math.round(stats.avg_length ?? 0),
      coverage: coverage as Record<FactCategory, number>,
    },
  }
}
```

需要在 `store.ts` 顶部添加 `import type { DreamReport } from './types.js'`（如果还没有的话）。

- [ ] **Step 9: 运行全部测试**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 10: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat(store): add mergeOverlappingFacts, reclassifyFacts, runDream for dream cycle"
```

---

### Task 4: Server 层 — dream action + 精简搜索格式

**Files:**
- Modify: `src/server.ts`
- Modify: `src/retriever.ts`

- [ ] **Step 1: 在 server.ts 添加 dream case**

在 `server.ts` 的 `case 'audit'` 块之后、`case 'list'` 之前添加：

```typescript
        case 'dream': {
          const report = store.runDream()
          retriever.getCache().clear()
          resourceManager.invalidate()
          return { content: [{ type: 'text' as const, text: JSON.stringify(report) }] }
        }
```

同时在 `factStoreSchema` 的 `action` 枚举中添加 `'dream'`。

- [ ] **Step 2: 更新 factStoreSchema 的 action 枚举**

在 `src/server.ts` 中，把 `action: z.enum([... 'learn', 'audit'])` 改为 `action: z.enum([... 'learn', 'audit', 'dream'])`。

- [ ] **Step 3: 在 server.ts 添加 toCompactResult 辅助函数**

在 server.ts 的 `resolveCategory` 函数之后添加：

```typescript
function toCompactResult(f: ScoredFact): CompactFactResult {
  return {
    factId: f.factId,
    display: f.summary ?? (f.content.length > 100 ? f.content.slice(0, 100) + '...' : f.content),
    category: f.category,
    trustScore: Math.round(f.trustScore * 100) / 100,
    score: Math.round(f.score * 1000) / 1000,
  }
}
```

需要在 `server.ts` 顶部添加 `import type { CompactFactResult } from './types.js'`。

- [ ] **Step 4: 更新 search/probe/related/reason 响应使用精简格式**

把 `case 'search'` 中的：
```typescript
return { content: [{ type: 'text' as const, text: JSON.stringify({ results, count: results.length }) }] }
```
改为：
```typescript
const compact = results.map(toCompactResult)
return { content: [{ type: 'text' as const, text: JSON.stringify({ results: compact, count: compact.length }) }] }
```

对 `probe`、`related`、`reason` 做同样的改动。

- [ ] **Step 5: 构建并运行测试**

Run: `npm run build && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): add dream action, compact search result format"
```

---

### Task 5: CLI dream 命令

**Files:**
- Create: `src/dream.ts`
- Modify: `package.json`

- [ ] **Step 1: 创建 src/dream.ts**

```typescript
#!/usr/bin/env node

import { MemoryStore } from './store.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dbPath = join(homedir(), '.mnemo', 'facts.db')
const store = new MemoryStore(dbPath)

try {
  console.log('[mnemo dream] 开始整理记忆库...\n')
  const report = store.runDream()
  console.log(JSON.stringify(report, null, 2))
  console.log(`\n[mnemo dream] 完成: merged=${report.merged} compressed=${report.compressed} reclassified=${report.reclassified} deleted=${report.deleted}`)
} catch (err) {
  console.error('[mnemo dream] error:', err)
  process.exit(1)
} finally {
  store.close()
}
```

- [ ] **Step 2: 在 package.json 添加 bin 入口**

在 `package.json` 的 `bin` 字段中添加 `"mnemo-dream": "dist/dream.js"`：

```json
"bin": {
  "mnemo": "dist/server.js",
  "mnemo-init": "dist/init.js",
  "mnemo-dream": "dist/dream.js"
}
```

- [ ] **Step 3: 构建并验证**

Run: `npm run build && node dist/dream.js`
Expected: 输出 dream report JSON

- [ ] **Step 4: Commit**

```bash
git add src/dream.ts package.json
git commit -m "feat(cli): add mnemo dream CLI command"
```

---

### Task 6: 最终验证

- [ ] **Step 1: 运行全部测试**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: 构建并验证 MCP 协议**

Run: `npm run build`

验证 dream action：
```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fact_store","arguments":{"action":"dream"}}}\n' | node dist/server.js 2>/dev/null
```
Expected: 返回 dream report JSON

验证精简搜索格式：
```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fact_store","arguments":{"action":"search","query":"编码规范"}}}\n' | node dist/server.js 2>/dev/null
```
Expected: 返回包含 `display` 字段（而非完整 `content`）的精简结果

- [ ] **Step 3: 版本号更新并最终 Commit**

Run:
```bash
npm version patch --no-git-tag-version
git add -A
git commit -m "feat: memory dreaming — auto merge, compress, reclassify + compact search results"
```
