# Dream Content-Centric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 summary 对检索和展示的影响，content 成为唯一数据源；dream 简化为合并同主题 + LLM 精简 content。

**Architecture:** 检索/展示统一使用 content 字段，dream 引擎不再生成 summary 而是直接覆写 content。summary 字段保留但降级为 dream 内部使用。pipeline 顺序改为 merge → compress。

**Tech Stack:** TypeScript, better-sqlite3, vitest, OpenAI-compatible LLM API

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/retriever.ts:121-123` | Modify | matchText 改为 `fact.content`，不再用 summary |
| `src/retriever.ts:143` | Modify | length penalty 基于 content 长度 |
| `src/server.ts:55-63` | Modify | toCompactResult display 返回完整 content |
| `src/dream-engine.ts` | Rewrite | semanticMerge 合并 content，smartCompress 覆写 content，移除 smartReclassify |
| `src/store.ts:939-973` | Modify | runDream pipeline 改为 merge → compress，移除 reclassify |
| `src/store.ts:1028-1037` | Modify | extractSummary 修复 `.` 分割 bug |
| `src/types.ts` | No change | CompactFactResult.display 类型已是 string |
| `tests/dream-engine.test.ts` | Rewrite | 适配新的 merge/compress 行为 |
| `tests/store.test.ts` | Modify | dream report 验证更新 |

---

### Task 1: 检索层 content-only 改造

**Files:**
- Modify: `src/retriever.ts:121-123,143`
- Modify: `src/server.ts:55-63`
- Test: `tests/store.test.ts` (dream/display 相关测试)

- [ ] **Step 1: 修改 retriever.ts — matchText 使用 content**

在 `src/retriever.ts` 第 122-123 行，替换：

```typescript
// 修改前（第 122-123 行）
// summary 优先用于匹配
const matchText = fact.summary ?? fact.content
```

为：

```typescript
const matchText = fact.content
```

第 142-143 行的 length penalty 保持不变（现在基于 content 长度是正确行为）：

```typescript
// Length penalty：基于 content 长度
score *= Math.min(1.0, 300 / matchText.length)
```

- [ ] **Step 2: 修改 server.ts — display 返回完整 content**

在 `src/server.ts` 第 55-63 行，替换 `toCompactResult` 函数：

```typescript
function toCompactResult(f: ScoredFact): CompactFactResult {
  return {
    factId: f.factId,
    display: f.content,
    category: f.category,
    trustScore: Math.round(f.trustScore * 100) / 100,
    score: Math.round(f.score * 1000) / 1000,
  }
}
```

- [ ] **Step 3: 运行测试验证基本功能**

Run: `npm run build 2>&1 && npx vitest run 2>&1 | tail -15`
Expected: 所有测试通过（检索和展示行为变化不影响现有测试断言）

- [ ] **Step 4: Commit**

```bash
git add src/retriever.ts src/server.ts
git commit -m "refactor: use content only for retrieval matching and display"
```

---

### Task 2: Dream 引擎 — semanticMerge 合并 content

**Files:**
- Modify: `src/dream-engine.ts:25-92`

- [ ] **Step 1: 重写 semanticMerge — LLM 合并 content**

替换 `src/dream-engine.ts` 第 25-92 行的 `semanticMerge` 方法：

```typescript
  async semanticMerge(): Promise<{
    merged: number
    details: Array<{ kept: number; removed: number; reason: string }>
  }> {
    const categories: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
    let merged = 0
    const details: Array<{ kept: number; removed: number; reason: string }> = []

    const totalFacts = this.store.getTotalCount()
    const maxDeletes = Math.max(1, Math.floor(totalFacts * MAX_DELETE_RATIO))
    this.log(`语义合并开始，共 ${totalFacts} 条 fact，最多删除 ${maxDeletes} 条`)

    for (const cat of categories) {
      const facts = this.store.listFacts(cat, 0, 200)
      if (facts.length < 2) continue

      for (let i = 0; i < facts.length; i += BATCH_SIZE) {
        const batch = facts.slice(i, i + BATCH_SIZE)
        this.log(`[${cat}] 分析第 ${i + 1}-${Math.min(i + BATCH_SIZE, facts.length)} 条 (共 ${facts.length} 条)...`)
        const factList = batch.map(f => `[${f.factId}] ${f.content}`).join('\n')

        const messages: LLMMessage[] = [
          {
            role: 'system',
            content: `你是一个记忆整理助手。分析以下同一分类(${cat})的记忆条目，找出讲述同一主题的条目对。
将它们的完整信息合并为一条更完整的记忆。
只输出JSON，格式：{"merges": [{"kept": 保留的fact_id, "removed": 删除的fact_id, "merged_content": "合并后的完整内容", "reason": "原因"}]}
如果没有同主题的条目，输出：{"merges": []}
规则：
- 保留所有关键信息：URL、邮箱、数字、人名、配置参数
- 合并后内容应比任一原文更完整
- 不要合并只是主题相关但内容不同的条目`,
          },
          { role: 'user', content: factList },
        ]

        try {
          const result = await this.llm.chatJSON<{ merges: Array<{ kept: number | string; removed: number | string; merged_content?: string; reason: string }> }>(messages)
          if (!result?.merges || !Array.isArray(result.merges)) continue

          for (const merge of result.merges) {
            if (merged >= maxDeletes) break
            const keptId = Number(merge.kept)
            const removedId = Number(merge.removed)
            if (!keptId || !removedId) continue

            const toRemove = this.store.listFacts(cat, 0, 200).find(f => f.factId === removedId)
            if (!toRemove) continue
            if (toRemove.trustScore > TRUST_DELETE_LIMIT) continue
            if (toRemove.retrievalCount > RETRIEVAL_DELETE_LIMIT) continue

            const toKeep = this.store.listFacts(cat, 0, 200).find(f => f.factId === keptId)
            if (!toKeep) continue

            // 如果 LLM 提供了合并内容，覆写 kept fact 的 content
            if (merge.merged_content && merge.merged_content.length > 0) {
              this.store.connection.prepare(
                "UPDATE facts SET content = ?, updated_at = datetime('now', 'localtime') WHERE fact_id = ?"
              ).run(merge.merged_content, keptId)
              this.log(`合并内容: #${keptId} content 已更新`)
            }

            this.store.removeFact(removedId)
            details.push({ kept: keptId, removed: removedId, reason: merge.reason })
            this.log(`合并: #${removedId} → #${keptId} (${merge.reason})`)
            merged++
          }
        } catch (e) {
          this.log(`[${cat}] 批次分析失败: ${(e as Error).message?.slice(0, 80)}`)
          continue
        }
      }
    }

    this.log(`语义合并完成: ${merged} 条合并`)
    return { merged, details }
  }
```

关键改动：
- `truncateContent` 替换为直接使用 `f.content`（不再需要 summary 截断）
- LLM prompt 增加输出 `merged_content` 字段
- 合并后用 `merged_content` 覆写 kept fact 的 content

- [ ] **Step 2: 移除 truncateContent 辅助函数**

删除 `src/dream-engine.ts` 第 12-16 行的 `truncateContent` 函数，因为不再需要。

同时删除第 9 行的 `MAX_CONTENT_CHARS = 500` 常量（已无引用）。

- [ ] **Step 3: 运行测试**

Run: `npm run build 2>&1 && npx vitest run tests/dream-engine.test.ts 2>&1 | tail -15`
Expected: semanticMerge 相关测试会失败（因为返回格式变化），下一步修复

- [ ] **Step 4: Commit**

```bash
git add src/dream-engine.ts
git commit -m "feat(dream): semanticMerge merges content instead of just deleting"
```

---

### Task 3: Dream 引擎 — smartCompress 覆写 content

**Files:**
- Modify: `src/dream-engine.ts:94-146`

- [ ] **Step 1: 重写 smartCompress — LLM 精简并覆写 content**

替换 `src/dream-engine.ts` 中的 `smartCompress` 方法：

```typescript
  async smartCompress(): Promise<number> {
    const rows = this.store.connection.prepare(
      "SELECT fact_id, content FROM facts WHERE length(content) > 200"
    ).all() as Array<{ fact_id: number; content: string }>

    if (rows.length === 0) {
      this.log('智能精简: 无需精简的 fact')
      return 0
    }

    this.log(`智能精简开始，共 ${rows.length} 条长 fact`)
    let compressed = 0

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      this.log(`精简第 ${i + 1}-${Math.min(i + BATCH_SIZE, rows.length)} 条...`)
      const factList = batch.map(f => {
        const c = f.content.length > MAX_COMPRESS_CHARS
          ? f.content.slice(0, MAX_COMPRESS_CHARS) + `...[共${f.content.length}字]`
          : f.content
        return `[${f.fact_id}] ${c}`
      }).join('\n\n---\n\n')

      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `你是一个记忆精简助手。精简每条记忆的冗余内容，但必须保留所有关键信息。
关键信息包括：URL、邮箱地址、数字数据、人名、配置参数、技术名词。
去除：过程描述、重复表述、示例、冗余细节。
精简后内容应比原文更紧凑，但信息零丢失。
输出JSON：{"compressions": [{"fact_id": 数字, "content": "精简后的完整内容"}]}`,
        },
        { role: 'user', content: factList },
      ]

      try {
        const result = await this.llm.chatJSON<{ compressions: Array<{ fact_id: number; content: string }> }>(messages)
        if (!result?.compressions || !Array.isArray(result.compressions)) continue

        for (const item of result.compressions) {
          if (!item.fact_id || !item.content) continue
          this.store.connection.prepare(
            "UPDATE facts SET content = ?, updated_at = datetime('now', 'localtime') WHERE fact_id = ?"
          ).run(item.content, item.fact_id)
          compressed++
        }
        this.log(`本批精简 ${result.compressions.length} 条`)
      } catch (e) {
        this.log(`精简批次失败: ${(e as Error).message?.slice(0, 80)}`)
        continue
      }
    }

    this.log(`智能精简完成: ${compressed} 条`)
    return compressed
  }
```

关键改动：
- SQL 条件从 `summary IS NULL` 改为 `length(content) > 200`（不再依赖 summary 状态）
- LLM 输出从 `summaries` 改为 `compressions`，直接输出精简后 content
- UPDATE 目标从 `summary` 改为 `content`

- [ ] **Step 2: 删除 smartReclassify 方法**

删除 `src/dream-engine.ts` 中的整个 `smartReclassify` 方法（约第 148-202 行）。dream 不再做独立分类修正。

- [ ] **Step 3: 运行测试**

Run: `npm run build 2>&1 && npx vitest run tests/dream-engine.test.ts 2>&1 | tail -15`
Expected: smartCompress 和 smartReclassify 测试失败，下一步修复

- [ ] **Step 4: Commit**

```bash
git add src/dream-engine.ts
git commit -m "feat(dream): smartCompress overwrites content, remove smartReclassify"
```

---

### Task 4: 更新测试用例

**Files:**
- Rewrite: `tests/dream-engine.test.ts`
- Modify: `tests/store.test.ts` (dream 相关断言)

- [ ] **Step 1: 重写 dream-engine.test.ts — semanticMerge 测试**

替换 `tests/dream-engine.test.ts` 全部内容：

```typescript
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
```

- [ ] **Step 2: 更新 store.test.ts 中 dream 相关断言**

在 `tests/store.test.ts` 中找到 dream 测试，修改断言：
- `reclassified` 相关断言改为 `0`（不再有 reclassify 步骤）
- `typeof report.fallback` 断言保持不变

- [ ] **Step 3: 运行全量测试**

Run: `npm run build 2>&1 && npx vitest run 2>&1 | tail -15`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add tests/dream-engine.test.ts tests/store.test.ts
git commit -m "test: update dream tests for content-centric approach"
```

---

### Task 5: store.ts pipeline 调整 + extractSummary 修复

**Files:**
- Modify: `src/store.ts:939-973` (runDream)
- Modify: `src/store.ts:1028-1037` (extractSummary)

- [ ] **Step 1: 修改 runDream pipeline — merge → compress**

替换 `src/store.ts` 第 939-973 行的 `runDream` 方法：

```typescript
  async runDream(options?: { skipBackup?: boolean }): Promise<DreamReport> {
    if (!options?.skipBackup) {
      await this.backupDatabase()
    }

    // 尝试 LLM 驱动的 dream
    const config = loadConfig()
    const llmClient = new LLMClient(config)
    console.log(`[dream] LLM 配置: ${config.baseUrl} / ${config.model}`)

    const available = await llmClient.isAvailable()
    if (available) {
      console.log('[dream] LLM 服务可用，使用 LLM 驱动整理')
      try {
        const engine = new DreamEngine(llmClient, this)
        const mergeResult = await engine.semanticMerge()
        const compressed = await engine.smartCompress()

        return this.buildDreamReport(mergeResult.merged, compressed, 0, mergeResult.details.map(d => ({ kept: d.kept, removed: d.removed, similarity: 0 })), false)
      } catch (e) {
        console.log(`[dream] LLM 执行失败，降级: ${(e as Error).message}`)
      }
    } else {
      console.log('[dream] LLM 不可用，使用规则引擎')
    }

    // 降级到规则引擎
    const mergeResult = this.mergeOverlappingFacts()
    const compressed = this.compressLongFacts()
    const reclassified = this.reclassifyFacts()

    return this.buildDreamReport(mergeResult.merged, compressed, reclassified, mergeResult.details, true, 'LLM unavailable')
  }
```

关键改动：
- LLM pipeline 顺序改为 merge → compress（先合并再精简）
- 移除 `engine.smartReclassify()` 调用，reclassified 固定为 0
- 规则引擎 fallback 保留 reclassify（向后兼容）

- [ ] **Step 2: 修复 extractSummary 的 `.` 分割 bug**

替换 `src/store.ts` 第 1028-1037 行的 `extractSummary` 方法：

```typescript
  private extractSummary(content: string): string | null {
    // 不以 . 分割，避免 URL/邮箱中的点被当作句子分隔符
    const sentences = content.split(/[。\n！？!?]/).map(s => s.trim()).filter(s => s.length > 0)
    if (sentences.length === 0) return null
    let summary = sentences[0]
    if (sentences.length > 1 && summary.length + sentences[1].length <= 148) {
      summary += '。' + sentences[1]
    }
    return summary.length <= 150 ? summary : summary.slice(0, 147) + '...'
  }
```

关键改动：`/[。\n.]/` → `/[。\n！？!?]/`，移除 `.` 分割符，增加中英文感叹号和问号。

- [ ] **Step 3: 运行全量测试**

Run: `npm run build 2>&1 && npx vitest run 2>&1 | tail -15`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add src/store.ts
git commit -m "refactor(dream): pipeline merge→compress, fix extractSummary dot splitting"
```

---

### Task 6: 集成测试与发布

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: 运行全量测试**

Run: `npm run build 2>&1 && npx vitest run 2>&1 | tail -15`
Expected: 所有测试通过，0 失败

- [ ] **Step 2: 本地 dream 测试**

Run: `node dist/dream.js 2>&1`
Expected:
- LLM 连接成功
- merge 阶段分析各 category 的 fact（可能 0 合并）
- compress 阶段精简长 content
- report 中 reclassified = 0
- fallback = false

- [ ] **Step 3: 验证检索行为**

Run: 无头模式或其他方式测试 `fact_store(search, query="伊军 邮箱")`
Expected: display 返回完整 content（非截断 summary），score 基于 content 匹配

- [ ] **Step 4: 版本号更新并发布**

在 `package.json` 中更新 version 为 `0.4.0`（breaking change：display 和 dream 行为变更）。

```bash
npm run build && npm publish --access public --registry https://registry.npmjs.org
```

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: 发布 v0.4.0 — content-centric dream"
```
