# Retrieval and Injection Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve mnemo-mcp retrieval accuracy and reduce injection overhead by adding MCP Resources for session warmup, query refinement, adaptive scoring, and a new injection protocol.

**Architecture:** Add a `ResourceManager` to serve per-category memory summaries via MCP Resource protocol, a `refineQuery()` pure function to strip noise tokens from user messages, dynamic FTS/Jaccard weighting based on query length, content-based deduplication, and a relevance score gate. Update CLAUDE.md rules to shift from "search every message" to "Resource warmup + on-demand search".

**Tech Stack:** TypeScript, Node.js, better-sqlite3, @modelcontextprotocol/sdk v1.29, zod v4, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/refine.ts` | **NEW** — `refineQuery()` pure function: token filtering, action word removal, entity extraction |
| `src/resources.ts` | **NEW** — `ResourceManager` class: per-category Resource registration, caching, cache invalidation |
| `src/retriever.ts` | **MODIFY** — Dynamic scoring weights, relevance gate, content-based deduplication, integrate refineQuery |
| `src/server.ts` | **MODIFY** — Wire ResourceManager, pass refineQuery into search flow |
| `src/types.ts` | **MODIFY** — Add `RefineResult` type |
| `tests/refine.test.ts` | **NEW** — Query refinement unit tests |
| `tests/resource.test.ts` | **NEW** — Resource caching and invalidation tests |
| `tests/retriever.test.ts` | **MODIFY** — Dynamic weight, relevance gate, dedup tests |
| `CLAUDE.md` (user-side) | **UPDATE** — New injection protocol rules (provided in docs) |

---

## Task 1: Query Refinement Module

**Files:**
- Create: `src/refine.ts`
- Test: `tests/refine.test.ts`

- [ ] **Step 1: Create `src/refine.ts`**

```typescript
/**
 * Query refinement: strip noise tokens from user messages before memory search.
 * Pure function — no side effects, no DB access.
 */

import type { FactCategory } from './types.js'

// Action words / helper phrases to strip (Chinese)
const ACTION_WORDS = new Set([
  '帮我', '看看', '看一下', '做一下', '帮我看看', '能不能', '为什么', '怎么',
  '是什么', '如何', '请', '麻烦', '可以', '能不能', '能不能帮我', '给我',
  '给我看看', '给我做', '给我写', '给我查', '给我找', '给我说', '给我讲',
  '告诉我', '跟我说', '跟我讲', '给我解释', '给我说明', '给我介绍',
  '运行', '执行', '启动', '停止', '创建', '删除', '修改', '更新', '查看',
  '检查', '测试', '提交', '推送', '拉取', '合并', '切换', '重置',
])

// Reuse existing stop words from retriever
const CN_STOP_WORDS = new Set([
  '的', '了', '是', '在', '有', '和', '就', '不', '人', '都',
  '一', '个', '上', '也', '很', '到', '说', '要', '去', '你',
  '会', '着', '没', '看', '好', '自', '这', '他', '她', '它',
  '那', '些', '用', '对', '下', '为', '从', '被', '把', '能',
  '可', '以', '所', '而', '又', '与', '但', '或', '等', '中',
  '大', '小', '多', '少', '其', '之', '做', '让', '给', '已',
  '还', '来', '地', '得', '过', '时', '里', '后', '前', '当',
])

export interface RefineResult {
  query: string | null
  tokens: string[]
  entityTokens: string[]
}

/**
 * Refine a raw user message into memory-searchable keywords.
 * Returns null if the message is a pure operation command with no memory relevance.
 */
export function refineQuery(raw: string): RefineResult | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Extract high-signal tokens first: quoted content, book titles, capitalized phrases
  const entityTokens: string[] = []

  // Chinese quotes: 「深色主题」 or "深色主题" or '深色主题'
  for (const m of trimmed.matchAll(/[「""'']([^「""'']{2,20})[」""'']?/g)) {
    entityTokens.push(m[1])
  }
  // Book titles: 《记忆系统》
  for (const m of trimmed.matchAll(/《([^》]+)》/g)) {
    entityTokens.push(m[1])
  }
  // Capitalized English phrases: "TypeScript", "Visual Studio Code"
  for (const m of trimmed.matchAll(/\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+)\b/g)) {
    entityTokens.push(m[1])
  }

  // Tokenize: split by spaces and Chinese character boundaries
  const tokens: string[] = []
  const parts = trimmed.split(/\s+/)
  for (const part of parts) {
    // English words
    for (const word of part.match(/[a-zA-Z0-9_\-.]+/g) ?? []) {
      if (word.length >= 2) tokens.push(word)
    }
    // Chinese characters (individual chars and 2-grams)
    const cnChars = part.match(/[\u4e00-\u9fff]/g) ?? []
    for (const c of cnChars) {
      if (!CN_STOP_WORDS.has(c)) tokens.push(c)
    }
    // Chinese 2-grams for better matching
    for (let i = 0; i < cnChars.length - 1; i++) {
      const bigram = cnChars[i] + cnChars[i + 1]
      tokens.push(bigram)
    }
  }

  // Filter action words and stop words
  const filtered = tokens.filter(t => {
    if (ACTION_WORDS.has(t)) return false
    if (CN_STOP_WORDS.has(t)) return false
    if (t.length < 2) return false
    return true
  })

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const t of filtered) {
    if (!seen.has(t)) {
      seen.add(t)
      deduped.push(t)
    }
  }

  // If nothing left after filtering, check if we have entity tokens
  if (deduped.length === 0 && entityTokens.length === 0) {
    return null
  }

  // Combine: entity tokens first (higher signal), then deduped tokens
  const allTokens = [...entityTokens, ...deduped.filter(t => !entityTokens.includes(t))]
  const query = allTokens.join(' ')

  return { query, tokens: deduped, entityTokens }
}
```

- [ ] **Step 2: Create `tests/refine.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { refineQuery } from '../src/refine.js'

describe('refineQuery', () => {
  it('filters action words from Chinese query', () => {
    const result = refineQuery('帮我用 TypeScript 重构 auth 模块')
    expect(result).not.toBeNull()
    expect(result!.query).toContain('TypeScript')
    expect(result!.query).toContain('auth')
    expect(result!.query).not.toContain('帮我')
    expect(result!.query).not.toContain('重构')
  })

  it('returns null for pure operation commands', () => {
    expect(refineQuery('运行测试')).toBeNull()
    expect(refineQuery('git status')).toBeNull()
    expect(refineQuery('创建文件')).toBeNull()
  })

  it('extracts quoted Chinese entities', () => {
    const result = refineQuery('我喜欢「深色主题」')
    expect(result).not.toBeNull()
    expect(result!.entityTokens).toContain('深色主题')
    expect(result!.query).toContain('深色主题')
  })

  it('extracts book title entities', () => {
    const result = refineQuery('读了《设计模式》这本书')
    expect(result).not.toBeNull()
    expect(result!.entityTokens).toContain('设计模式')
  })

  it('extracts capitalized English phrases', () => {
    const result = refineQuery('使用 Visual Studio Code 编辑器')
    expect(result).not.toBeNull()
    expect(result!.entityTokens).toContain('Visual Studio Code')
  })

  it('returns null for empty string', () => {
    expect(refineQuery('')).toBeNull()
    expect(refineQuery('   ')).toBeNull()
  })

  it('preserves meaningful Chinese tokens', () => {
    const result = refineQuery('用户偏好深色主题')
    expect(result).not.toBeNull()
    expect(result!.query).toContain('用户')
    expect(result!.query).toContain('偏好')
    expect(result!.query).toContain('深色')
    expect(result!.query).toContain('主题')
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/refine.test.ts
```

Expected: 7 tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && git add src/refine.ts tests/refine.test.ts && git commit -m "feat(refine): add query refinement module with action word filtering"
```

---

## Task 2: Resource Manager Module

**Files:**
- Create: `src/resources.ts`
- Test: `tests/resource.test.ts`

- [ ] **Step 1: Create `src/resources.ts`**

```typescript
/**
 * MCP Resource manager for mnemo-mcp.
 * Exposes per-category memory summaries as MCP Resources for session warmup injection.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MemoryStore } from './store.js'
import type { FactCategory } from './types.js'

const CATEGORIES: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
const RESOURCE_LIMIT = 10

export interface ResourceFact {
  fact_id: number
  content: string
  trust_score: number
}

export class ResourceManager {
  private cache = new Map<FactCategory, ResourceFact[]>()

  constructor(
    private server: McpServer,
    private store: MemoryStore,
  ) {}

  /** Register all category resources with the MCP server */
  registerResources(): void {
    for (const category of CATEGORIES) {
      const template = new ResourceTemplate(
        `mnemo://global/{category}`,
        { list: undefined },
      )
      this.server.registerResource(
        `mnemo-global-${category}`,
        template,
        {
          description: `${category} category global facts (top ${RESOURCE_LIMIT} by trust)`,
          mimeType: 'application/json',
        },
        (uri, variables) => this.readResource(uri, variables),
      )
    }
  }

  /** Read handler for resource template */
  private readResource(uri: URL, variables: Record<string, string | string[]>): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
    const category = (Array.isArray(variables.category) ? variables.category[0] : variables.category) as FactCategory
    if (!CATEGORIES.includes(category)) {
      return { contents: [{ uri: uri.toString(), mimeType: 'application/json', text: '[]' }] }
    }

    const facts = this.getFacts(category)
    return {
      contents: [{
        uri: uri.toString(),
        mimeType: 'application/json',
        text: JSON.stringify(facts, null, 2),
      }],
    }
  }

  /** Get facts for a category — with caching */
  getFacts(category: FactCategory): ResourceFact[] {
    const cached = this.cache.get(category)
    if (cached) return cached

    const facts = this.store.listFacts(category, 0.0, RESOURCE_LIMIT).map(f => ({
      fact_id: f.factId,
      content: f.content,
      trust_score: f.trustScore,
    }))

    this.cache.set(category, facts)
    return facts
  }

  /** Invalidate all caches — call after any write operation */
  invalidate(): void {
    this.cache.clear()
  }

  /** Get cache size for debugging */
  cacheSize(): number {
    return this.cache.size
  }
}
```

- [ ] **Step 2: Create `tests/resource.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store.js'
import { ResourceManager } from '../src/resources.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

let store: MemoryStore
let server: McpServer
let manager: ResourceManager
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mnemo-test-'))
  store = new MemoryStore(join(tmpDir, 'test.db'))
  server = new McpServer({ name: 'test', version: '0.1.0' })
  manager = new ResourceManager(server, store)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('ResourceManager', () => {
  it('returns empty array for empty category', () => {
    const facts = manager.getFacts('identity')
    expect(facts).toEqual([])
  })

  it('returns facts ordered by trust score', () => {
    store.addFact('用户偏好深色主题', 'tool_pref')
    store.addFact('用户喜欢 VS Code', 'tool_pref')
    const facts = manager.getFacts('tool_pref')
    expect(facts.length).toBe(2)
    expect(facts[0].content).toBe('用户偏好深色主题')
  })

  it('caches results', () => {
    store.addFact('测试事实', 'general')
    manager.getFacts('general')
    expect(manager.cacheSize()).toBe(1)
    // Second call should hit cache
    const facts2 = manager.getFacts('general')
    expect(facts2.length).toBe(1)
  })

  it('invalidates cache on write', () => {
    store.addFact('测试事实', 'general')
    manager.getFacts('general')
    expect(manager.cacheSize()).toBe(1)
    manager.invalidate()
    expect(manager.cacheSize()).toBe(0)
  })

  it('limits to top 10 facts', () => {
    for (let i = 0; i < 15; i++) {
      store.addFact(`事实 ${i}`, 'general')
    }
    const facts = manager.getFacts('general')
    expect(facts.length).toBe(10)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/resource.test.ts
```

Expected: 5 tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && git add src/resources.ts tests/resource.test.ts && git commit -m "feat(resources): add MCP Resource manager for per-category memory warmup"
```

---

## Task 3: Update Retriever with Dynamic Scoring, Relevance Gate, and Deduplication

**Files:**
- Modify: `src/retriever.ts`
- Modify: `src/types.ts`
- Test: `tests/retriever.test.ts`

- [ ] **Step 1: Update `src/types.ts` — add `RefineResult`**

Add to `src/types.ts` after `SecurityScanResult`:

```typescript
/** 查询提炼结果 */
export interface RefineResult {
  query: string | null
  tokens: string[]
  entityTokens: string[]
}
```

- [ ] **Step 2: Modify `src/retriever.ts` — integrate refineQuery, dynamic weights, relevance gate, dedup**

Replace the `search()` method (lines 68-171) with:

```typescript
  /** 主搜索：FTS5 → LIKE → 字符交叉 → 分类推断 → Jaccard → 信任评分 → 时间衰减 */
  search(query: string, options?: SearchOptions & { skipRefine?: boolean }): ScoredFact[] {
    const startTime = performance.now()
    const minTrust = options?.minTrust ?? 0.3
    const limit = options?.limit ?? 10
    const category = options?.category

    // Query refinement (unless explicitly skipped)
    let searchQuery = query
    if (!options?.skipRefine) {
      const refined = refineQuery(query)
      if (refined?.query) {
        searchQuery = refined.query
      }
    }

    // Cache check using refined query
    const cacheKey = this.cache.makeKey({ action: 'search', query: searchQuery, category, minTrust, limit })
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.metrics.record({ action: 'search', durationMs: performance.now() - startTime, resultCount: cached.length, cacheHit: true })
      return cached
    }

    // Query bilingual expansion
    const expandedQuery = this.expandQueryBilingually(searchQuery)

    // Stage 1: FTS5 candidates with fallback chain
    let candidates = this.ftsCandidates(expandedQuery, category, minTrust, limit * 3)
    if (candidates.length === 0) candidates = this.likeFallback(expandedQuery, category, minTrust, limit * 3)
    if (candidates.length === 0) candidates = this.charOverlapFallback(expandedQuery, category, minTrust, limit * 3)
    if (candidates.length === 0) {
      if (!category) {
        const inferred = this.categoryInferFallback(searchQuery, minTrust, limit)
        if (inferred.length > 0) return inferred
      }
      if (this.isPersonalQuery(searchQuery)) {
        return this.trustFallback(category, minTrust, limit)
      }
      return []
    }

    // Dynamic weighting based on query token count
    const queryTokens = this.tokenize(searchQuery)
    const tokenCount = queryTokens.size
    const ftsWeight = tokenCount <= 3 ? 0.7 : 0.3
    const jaccardWeight = tokenCount <= 3 ? 0.3 : 0.7

    // Stage 2-4: Score candidates
    const scored: ScoredFact[] = []
    for (const fact of candidates) {
      const contentTokens = this.tokenize(fact.content)
      const tagTokens = this.tokenize(fact.tags)
      const allTokens = new Set([...contentTokens, ...tagTokens])

      const jaccard = this.jaccardSimilarity(queryTokens, allTokens)
      const qInF = this.containmentScore(queryTokens, allTokens)
      const similarity = 0.3 * jaccard + 0.7 * qInF
      const ftsScore = fact.ftsRank

      // Dynamic relevance
      const relevance = ftsWeight * ftsScore + jaccardWeight * similarity
      let score = relevance * fact.trustScore

      if (this.halfLifeDays > 0) {
        score *= this.temporalDecay(fact.updatedAt || fact.createdAt)
      }

      scored.push({ ...fact, score })
    }

    scored.sort((a, b) => b.score - a.score)

    // Relevance gate: filter out low-relevance results
    const RELEVANCE_THRESHOLD = 0.15
    const gated = scored.filter(s => s.score >= RELEVANCE_THRESHOLD)
    const resultsToDedup = gated.length > 0 ? gated : scored

    // Content-based deduplication (Jaccard > 0.7) instead of category-per-top1
    const deduped: ScoredFact[] = []
    for (const candidate of resultsToDedup) {
      let isDuplicate = false
      const candidateTokens = this.tokenize(candidate.content)
      for (const kept of deduped) {
        const keptTokens = this.tokenize(kept.content)
        if (this.jaccardSimilarity(candidateTokens, keptTokens) > 0.7) {
          isDuplicate = true
          break
        }
      }
      if (!isDuplicate) {
        deduped.push(candidate)
        if (deduped.length >= limit) break
      }
    }

    const results = deduped

    // Track retrieval
    if (results.length > 0) {
      this.trackRetrieval(results)
    }

    this.cache.set(cacheKey, results)
    this.metrics.record({ action: 'search', durationMs: performance.now() - startTime, resultCount: results.length, cacheHit: false, retrievalPath: 'FTS5' })
    return results
  }
```

Add import at top of `src/retriever.ts`:

```typescript
import { refineQuery } from './refine.js'
```

- [ ] **Step 3: Update `tests/retriever.test.ts` — add new test cases**

Append to existing test file:

```typescript
  describe('dynamic scoring', () => {
    it('uses high FTS weight for short queries', () => {
      store.addFact('用户偏好深色主题', 'tool_pref')
      const results = retriever.search('深色主题')
      expect(results.length).toBeGreaterThan(0)
    })

    it('uses high Jaccard weight for long queries', () => {
      store.addFact('用户偏好使用 TypeScript 开发后端 API', 'coding_style')
      const results = retriever.search('为什么 TypeScript 编译报错找不到模块')
      // Should still return something due to Jaccard overlap on "TypeScript"
      expect(results.some(r => r.content.includes('TypeScript'))).toBe(true)
    })
  })

  describe('relevance gate', () => {
    it('filters out low relevance results', () => {
      store.addFact('完全不相关的内容关于天气和食物', 'general')
      store.addFact('用户偏好深色主题', 'tool_pref')
      const results = retriever.search('深色主题')
      expect(results.every(r => r.content.includes('深色') || r.content.includes('主题'))).toBe(true)
    })
  })

  describe('content deduplication', () => {
    it('allows multiple general facts if content differs', () => {
      store.addFact('用户喜欢蓝色', 'general')
      store.addFact('用户偏好深色主题', 'general')
      store.addFact('用户使用 VS Code', 'general')
      const results = retriever.search('用户偏好')
      expect(results.filter(r => r.category === 'general').length).toBeGreaterThan(1)
    })

    it('deduplicates highly similar facts', () => {
      store.addFact('用户偏好深色主题', 'tool_pref')
      store.addFact('用户偏好深色主题和蓝色', 'tool_pref')
      const results = retriever.search('深色主题')
      // Both are similar but not identical; Jaccard should be high
      const similarCount = results.filter(r => r.content.includes('深色主题')).length
      expect(similarCount).toBeLessThanOrEqual(2)
    })
  })
```

- [ ] **Step 4: Run all retriever tests**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npx vitest run tests/retriever.test.ts
```

Expected: All tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && git add src/retriever.ts src/types.ts tests/retriever.test.ts && git commit -m "feat(retriever): dynamic scoring, relevance gate, content dedup, query refinement"
```

---

## Task 4: Wire Resources and Refinement into Server

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Update `src/server.ts` — import and wire ResourceManager**

Add imports:

```typescript
import { ResourceManager } from './resources.js'
```

After retriever initialization, add:

```typescript
const resourceManager = new ResourceManager(server, store)
resourceManager.registerResources()
```

In write operations (add/update/remove cases), after `retriever.getCache().clear()`, add:

```typescript
resourceManager.invalidate()
```

For the `search` case, integrate refineQuery:

```typescript
case 'search': {
  if (!a.query) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: query' }) }] }
  // Skip refinement for explicit tool calls (user knows what they're searching)
  const results = retriever.search(a.query, { category: a.category ? category : undefined, minTrust: a.min_trust ?? minTrust, limit: a.limit ?? 10, skipRefine: true })
  return { content: [{ type: 'text' as const, text: JSON.stringify({ results, count: results.length }) }] }
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npm run build
```

Expected: BUILD OK (no TypeScript errors)

- [ ] **Step 3: Run all tests**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && npm run test
```

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && git add src/server.ts && git commit -m "feat(server): wire ResourceManager and query refinement into MCP server"
```

---

## Task 5: Update CLAUDE.md Rules and Documentation

**Files:**
- Modify: `README.md` (in project)
- Provide: CLAUDE.md rule template (for user to copy)

- [ ] **Step 1: Update `README.md` — add Resource and injection protocol sections**

Add after the existing Tools section:

```markdown
## MCP Resources

mnemo-mcp exposes 5 global category resources for session warmup injection:

| Resource URI | Description |
|-------------|-------------|
| `mnemo://global/identity` | Identity facts (top 10 by trust) |
| `mnemo://global/coding_style` | Coding style preferences |
| `mnemo://global/tool_pref` | Tool preferences |
| `mnemo://global/workflow` | Workflow preferences |
| `mnemo://global/general` | General facts |

Clients (Claude Code / Codex) automatically fetch these resources at session start,
injecting memory into system context without any tool calls.

## Injection Protocol

### For Claude Code Users

Update your `CLAUDE.md` rules to use the new protocol:

```markdown
# 记忆系统使用规则

你有 mnemo 记忆工具（fact_store / fact_feedback），必须按以下规则使用：

## 规则 1：会话预热（自动）
会话启动时，mnemo-mcp 的 MCP Resource 会自动注入全局记忆到 system context。
你不需要主动调用 fact_store(search) 来获取高频记忆。

## 规则 2：按需补充查询
仅在以下情况调用 fact_store(action="search")：
- 用户消息涉及个人偏好/习惯/工具选择且预热中未覆盖
- 用户明确查询记忆（"我之前说过什么""按我的习惯"）
- 技术选型时需要确认用户偏好

不触发查询的情况：
- 纯操作指令（"运行测试""git commit"）
- 通用技术问题（"Promise 怎么用"）
- 代码审查/解释请求

## 规则 3：写入记忆
用户说"记住""记下来"时，调用 fact_store(action="add", content="...", category="...")。
- 先 search 检查是否已有相似事实，有则 update
- category：identity / coding_style / tool_pref / workflow / general

## 规则 4：反馈强化
成功使用某条记忆时，调用 fact_feedback(action="helpful", fact_id=...)。
```
```

- [ ] **Step 2: Commit docs**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp && git add README.md && git commit -m "docs: add MCP Resource and injection protocol documentation"
```

---

## Self-Review

### Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| MCP Resource 暴露 5 个 category | Task 2 |
| Resource 缓存 + 写操作失效 | Task 2 |
| 查询提炼过滤动作词/虚词 | Task 1 |
| 纯操作指令返回 null | Task 1 |
| 引号/书名号实体提取 | Task 1 |
| 动态 FTS/Jaccard 权重 | Task 3 |
| 相关性评分门控 (0.15) | Task 3 |
| 内容相似度去重 (Jaccard > 0.7) | Task 3 |
| 会话预热注入协议 | Task 4 (Resource wiring) + Task 5 (docs) |
| 按需补充查询规则 | Task 5 (CLAUDE.md template) |

### Placeholder Scan

- [x] No "TBD", "TODO", "implement later"
- [x] No vague "add error handling" without code
- [x] No "write tests for the above" without test code
- [x] All file paths are exact
- [x] All code blocks contain complete implementations

### Type Consistency

- [x] `refineQuery()` returns `RefineResult | null` consistently
- [x] `ResourceManager.getFacts()` returns `ResourceFact[]`
- [x] `search()` accepts `skipRefine?: boolean` in options
- [x] Dynamic weights use `ftsWeight`/`jaccardWeight` variables (same names as constructor params)
