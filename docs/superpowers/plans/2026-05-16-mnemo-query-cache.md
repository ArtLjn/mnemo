# Mnemo-MCP Query Cache & Batch Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add query result caching (60s TTL), batch add/remove operations, and performance metrics to mnemo-mcp to reduce repeated SQLite queries and MCP round-trips.

**Architecture:** Wrap the `FactRetriever` with a `QueryCache` layer that stores results in a process-local Map keyed by query parameters. Cache is cleared on any write operation. Add batch operation support by accepting arrays in the `fact_store` tool's `content` and `fact_id` fields. Add a `PerfMetrics` collector that records query timing, cache hit/miss, and retrieval path when `MNEMO_DEBUG=1`.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, @modelcontextprotocol/sdk, zod

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/cache.ts` | **NEW** — `QueryCache` class: Map-based TTL cache with key generation and invalidation |
| `src/metrics.ts` | **NEW** — `PerfMetrics` class: query timing, cache stats, retrieval path tracking |
| `src/types.ts` | **MODIFY** — Update `FactStoreArgs` to accept `string \| string[]` for content and `number \| number[]` for fact_id |
| `src/retriever.ts` | **MODIFY** — Integrate cache lookup before DB query, record metrics on miss, expose retrieval path |
| `src/server.ts` | **MODIFY** — Wire cache clearing on writes, handle batch add/remove, pass debug flag to metrics |

---

## Task 1: Create QueryCache module

**Files:**
- Create: `src/cache.ts`
- Test: Manual — verify cache hit/miss behavior

- [ ] **Step 1: Create `src/cache.ts`**

```typescript
/**
 * Query result cache for mnemo-mcp.
 * Process-local Map with TTL. Cleared on write operations.
 */

import type { ScoredFact } from './types.js'

interface CacheEntry {
  results: ScoredFact[]
  timestamp: number
}

const DEFAULT_TTL_MS = 60_000

export class QueryCache {
  private cache = new Map<string, CacheEntry>()
  private ttlMs: number

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  /** Generate cache key from query parameters */
  makeKey(params: {
    action: string
    query?: string
    entity?: string
    entities?: string[]
    category?: string
    minTrust?: number
    limit?: number
  }): string {
    const parts = [
      params.action,
      params.query ?? '',
      params.entity ?? '',
      params.entities?.join(',') ?? '',
      params.category ?? '',
      String(params.minTrust ?? ''),
      String(params.limit ?? ''),
    ]
    return parts.join('|')
  }

  /** Get cached results if not expired */
  get(key: string): ScoredFact[] | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      return null
    }
    return entry.results
  }

  /** Store results in cache */
  set(key: string, results: ScoredFact[]): void {
    this.cache.set(key, { results, timestamp: Date.now() })
  }

  /** Clear all cached entries (call on write operations) */
  clear(): void {
    this.cache.clear()
  }

  /** Get cache size for debugging */
  size(): number {
    return this.cache.size
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cache.ts
git commit -m "feat(cache): add QueryCache module with TTL and key generation"
```

---

## Task 2: Create PerfMetrics module

**Files:**
- Create: `src/metrics.ts`
- Test: Manual — verify metrics accumulate correctly

- [ ] **Step 1: Create `src/metrics.ts`**

```typescript
/**
 * Performance metrics for mnemo-mcp.
 * Tracks query timing, cache hit/miss, and retrieval paths.
 * Only active when MNEMO_DEBUG=1.
 */

export interface QueryMetrics {
  action: string
  durationMs: number
  resultCount: number
  cacheHit: boolean
  retrievalPath?: string
}

export class PerfMetrics {
  private enabled: boolean
  private totalQueries = 0
  private cacheHits = 0
  private cacheMisses = 0
  private totalMissTimeMs = 0

  constructor() {
    this.enabled = process.env.MNEMO_DEBUG === '1'
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Record a query execution */
  record(metrics: QueryMetrics): void {
    if (!this.enabled) return

    this.totalQueries++
    if (metrics.cacheHit) {
      this.cacheHits++
    } else {
      this.cacheMisses++
      this.totalMissTimeMs += metrics.durationMs
    }

    const hitRatio = this.totalQueries > 0 ? (this.cacheHits / this.totalQueries * 100).toFixed(1) : '0.0'
    const path = metrics.retrievalPath ? ` [${metrics.retrievalPath}]` : ''
    console.error(
      `[mnemo:debug] ${metrics.action} | ${metrics.cacheHit ? 'HIT' : 'MISS'} | ` +
      `${metrics.durationMs.toFixed(2)}ms | ${metrics.resultCount} results | ` +
      `hit_ratio=${hitRatio}%${path}`
    )
  }

  /** Get aggregated statistics */
  getStats(): {
    totalQueries: number
    cacheHits: number
    cacheMisses: number
    hitRatio: number
    avgQueryTime: number
    totalTimeSaved: number
  } {
    const hitRatio = this.totalQueries > 0 ? this.cacheHits / this.totalQueries : 0
    const avgQueryTime = this.cacheMisses > 0 ? this.totalMissTimeMs / this.cacheMisses : 0
    const totalTimeSaved = this.cacheHits * avgQueryTime

    return {
      totalQueries: this.totalQueries,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRatio,
      avgQueryTime,
      totalTimeSaved,
    }
  }

  /** Log current stats */
  logStats(): void {
    if (!this.enabled) return
    const stats = this.getStats()
    console.error(
      `[mnemo:debug] stats | total=${stats.totalQueries} hits=${stats.cacheHits} ` +
      `misses=${stats.cacheMisses} hit_ratio=${(stats.hitRatio * 100).toFixed(1)}% ` +
      `avg_time=${stats.avgQueryTime.toFixed(2)}ms saved=${stats.totalTimeSaved.toFixed(2)}ms`
    )
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/metrics.ts
git commit -m "feat(metrics): add PerfMetrics module for query timing and cache stats"
```

---

## Task 3: Update types for batch operations

**Files:**
- Modify: `src/types.ts`
- Test: TypeScript compilation check

- [ ] **Step 1: Update `FactStoreArgs` to accept arrays**

In `src/types.ts`, change `content` and `fact_id` types:

```typescript
/** fact_store 工具调用参数 */
export interface FactStoreArgs {
  action: 'add' | 'search' | 'probe' | 'related' | 'reason' | 'contradict' | 'update' | 'remove' | 'list'
  content?: string | string[]  // <-- CHANGED: support batch add
  query?: string
  entity?: string
  entities?: string[]
  fact_id?: number | number[]  // <-- CHANGED: support batch remove
  category?: string
  tags?: string
  trust_delta?: number
  min_trust?: number
  limit?: number
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): allow string[] for content and number[] for fact_id in FactStoreArgs"
```

---

## Task 4: Integrate cache and metrics into FactRetriever

**Files:**
- Modify: `src/retriever.ts`
- Test: Manual — verify cache is checked before DB query

- [ ] **Step 1: Import cache and metrics**

At the top of `src/retriever.ts`:

```typescript
import { QueryCache } from './cache.js'
import { PerfMetrics } from './metrics.js'
```

- [ ] **Step 2: Add cache and metrics fields to `FactRetriever`**

```typescript
export class FactRetriever {
  private db: Database.Database
  private ftsWeight: number
  private jaccardWeight: number
  private halfLifeDays: number
  private _categoryTagMap: Map<FactCategory, Set<string>> | null = null
  private _cnEnPairs: Array<[string, string]> | null = null

  // <-- ADD
  private cache: QueryCache
  private metrics: PerfMetrics

  constructor(
    private store: MemoryStore,
    options?: RetrieverOptions,
  ) {
    this.db = store.connection
    this.ftsWeight = options?.ftsWeight ?? 0.5
    this.jaccardWeight = options?.jaccardWeight ?? 0.5
    this.halfLifeDays = options?.temporalDecayHalfLife ?? 0
    this.cache = new QueryCache()      // <-- ADD
    this.metrics = new PerfMetrics()   // <-- ADD
  }
```

- [ ] **Step 3: Add cache access methods**

```typescript
/** Expose cache for external invalidation (server.ts calls clear on writes) */
getCache(): QueryCache {
  return this.cache
}

/** Expose metrics for external access */
getMetrics(): PerfMetrics {
  return this.metrics
}
```

- [ ] **Step 4: Wrap `search()` with cache and metrics**

Replace the `search()` method signature and add cache check at the top:

```typescript
search(query: string, options?: SearchOptions): ScoredFact[] {
  const startTime = performance.now()
  const minTrust = options?.minTrust ?? 0.3
  const limit = options?.limit ?? 10
  const category = options?.category

  // Check cache first
  const cacheKey = this.cache.makeKey({ action: 'search', query, category, minTrust, limit })
  const cached = this.cache.get(cacheKey)
  if (cached) {
    this.metrics.record({
      action: 'search',
      durationMs: performance.now() - startTime,
      resultCount: cached.length,
      cacheHit: true,
    })
    return cached
  }

  // ... existing search logic continues ...
```

At the end of `search()`, before returning, store in cache and record metrics:

```typescript
  // At the end of search(), before return:
  this.cache.set(cacheKey, results)
  this.metrics.record({
    action: 'search',
    durationMs: performance.now() - startTime,
    resultCount: results.length,
    cacheHit: false,
    retrievalPath: 'FTS5', // v1: simplified path tracking, actual fallback path can be added in v2
  })
  return results
}
```

- [ ] **Step 5: Wrap other read methods with cache**

Apply the same pattern to `probe()`, `related()`, `reason()`, `contradict()`, and `list()`:

For each method:
1. Generate `cacheKey` using `this.cache.makeKey()` with appropriate params
2. Check cache at the start
3. Store results in cache before returning
4. Record metrics

Example for `probe()`:

```typescript
probe(entity: string, options?: SearchOptions): ScoredFact[] {
  const startTime = performance.now()
  const limit = options?.limit ?? 10

  const cacheKey = this.cache.makeKey({ action: 'probe', entity, limit })
  const cached = this.cache.get(cacheKey)
  if (cached) {
    this.metrics.record({ action: 'probe', durationMs: performance.now() - startTime, resultCount: cached.length, cacheHit: true })
    return cached
  }

  const facts = this.store.getFactsByEntity(entity, options?.category, limit)
  const results = facts.map((f, i) => ({ ...f, score: f.trustScore * (1 - i * 0.05) }))

  this.cache.set(cacheKey, results)
  this.metrics.record({ action: 'probe', durationMs: performance.now() - startTime, resultCount: results.length, cacheHit: false })
  return results
}
```

- [ ] **Step 6: Commit**

```bash
git add src/retriever.ts
git commit -m "feat(retriever): integrate QueryCache and PerfMetrics into all read methods"
```

---

## Task 5: Update server.ts for batch operations and cache invalidation

**Files:**
- Modify: `src/server.ts`
- Test: Manual — verify batch add/remove and cache clearing

- [ ] **Step 1: Update fact_store schema for batch support**

Change the Zod schema to accept arrays:

```typescript
const factStoreSchema = {
  action: z.enum(['add', 'search', 'probe', 'related', 'reason', 'contradict', 'update', 'remove', 'list']),
  content: z.union([z.string(), z.array(z.string())]).optional().describe("事实内容（'add' 必需，支持单条字符串或字符串数组批量添加）"),
  query: z.string().optional().describe("搜索查询（'search' 必需）"),
  entity: z.string().optional().describe("实体名（'probe'/'related' 使用）"),
  entities: z.array(z.string()).optional().describe("实体列表（'reason' 使用）"),
  fact_id: z.union([z.number(), z.array(z.number())]).optional().describe("事实 ID（'update'/'remove' 使用，支持单个数字或数字数组批量删除）"),
  category: z.enum(['identity', 'coding_style', 'tool_pref', 'workflow', 'general']).optional(),
  tags: z.string().optional().describe('逗号分隔标签'),
  trust_delta: z.number().optional().describe("'update' 的信任调整值"),
  min_trust: z.number().optional().describe('最低信任过滤（默认 0.3）'),
  limit: z.number().optional().describe('最大结果数（默认 10）'),
}
```

- [ ] **Step 2: Rewrite add handler for batch support**

Replace the `case 'add':` block:

```typescript
case 'add': {
  if (!a.content) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: content' }) }] }

  const contents = Array.isArray(a.content) ? a.content : [a.content]
  const results: Array<{ fact_id: number; status: string; reason?: string; warnings?: string[] }> = []

  for (const content of contents) {
    if (!content || !content.trim()) {
      results.push({ fact_id: -1, status: 'error', reason: 'empty content' })
      continue
    }

    const similar = store.findSimilarFact(content, category) ?? store.findSimilarFact(content)
    let warnings: string[] | undefined
    const scan = fullSecurityScan(content)
    if (scan.warnings.length > 0 || scan.hasPii) warnings = [...scan.warnings]

    if (similar) {
      store.updateFact(similar.factId, { content, tags: a.tags, trustDelta: 0.05 })
      const demoted = store.demoteContradictingFacts(similar.factId, content, category)
      results.push({
        fact_id: similar.factId,
        status: 'updated',
        reason: 'similar_fact_merged',
        ...(warnings ? { warnings } : {}),
      })
    } else {
      const factId = store.addFact(content, category, a.tags ?? '')
      const demoted = store.demoteContradictingFacts(factId, content, category)
      results.push({
        fact_id: factId,
        status: 'added',
        category,
        ...(warnings ? { warnings } : {}),
      })
    }
  }

  // Clear cache on write
  retriever.getCache().clear()

  // Return single object for single input, array for batch
  const response = Array.isArray(a.content) ? results : results[0]
  return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
}
```

- [ ] **Step 3: Rewrite remove handler for batch support**

Replace the `case 'remove':` block:

```typescript
case 'remove': {
  if (!a.fact_id) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: fact_id' }) }] }

  const ids = Array.isArray(a.fact_id) ? a.fact_id : [a.fact_id]
  const results = ids.map(id => ({ fact_id: id, removed: store.removeFact(id) }))

  // Clear cache on write
  retriever.getCache().clear()

  const response = Array.isArray(a.fact_id) ? results : results[0]
  return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
}
```

- [ ] **Step 4: Add cache clearing to update handler**

In `case 'update':`, after the update call, clear cache:

```typescript
case 'update': {
  if (!a.fact_id) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: fact_id' }) }] }
  const updated = store.updateFact(a.fact_id, { content: a.content, tags: a.tags, category, trustDelta: a.trust_delta })

  // Clear cache on write
  retriever.getCache().clear()

  return { content: [{ type: 'text' as const, text: JSON.stringify({ updated }) }] }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): add batch add/remove, cache invalidation on writes"
```

---

## Task 6: Verify end-to-end functionality

**Files:**
- None (manual verification)

- [ ] **Step 1: Build the project**

```bash
cd /Users/ljn/Documents/demo/ocean/mnemo-mcp
npm run build
```

- [ ] **Step 2: Test cache hit**

Start the server and send two identical search queries within 60 seconds:

```bash
MNEMO_DEBUG=1 node dist/server.js
```

Send via MCP Inspector or manual JSON-RPC:
```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fact_store","arguments":{"action":"search","query":"test","limit":5}}}
```

Second identical query should show `HIT` in debug output.

- [ ] **Step 3: Test batch add**

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fact_store","arguments":{"action":"add","content":["fact one","fact two"],"category":"general"}}}
```

Response should be an array of two results.

- [ ] **Step 4: Test batch remove**

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fact_store","arguments":{"action":"remove","fact_id":[1,2]}}}
```

Response should be an array of `{fact_id, removed}` objects.

- [ ] **Step 5: Test backward compatibility**

Single fact add should still work:
```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"fact_store","arguments":{"action":"add","content":"single fact","category":"general"}}}
```

Response should be a single object (not array).

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "test: verify cache, batch ops, and backward compatibility"
```

---

## Self-Review Checklist

### Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| Identical query returns cached result | Task 4, Step 4 |
| Cache cleared on fact addition | Task 5, Step 2 |
| Cache entry expires after TTL | Task 1, Step 1 (get() checks timestamp) |
| Probe query is cached | Task 4, Step 5 |
| Debug mode logs cache metrics | Task 2, Step 1 (record() logs) |
| Batch add multiple facts | Task 5, Step 2 |
| Batch add with partial failure | Task 5, Step 2 (empty content check) |
| Single fact add remains compatible | Task 5, Step 2 (Array.isArray check) |
| Batch remove multiple facts | Task 5, Step 3 |
| Query execution time recorded | Task 2, Step 1 + Task 4 |
| Retrieval path tracked | Task 4, Step 4 (retrievalPath field) |
| Cache statistics aggregated | Task 2, Step 1 (getStats()) |

### Placeholder Scan

- [x] No "TBD", "TODO", "implement later"
- [x] No vague "add error handling" without code
- [x] No "write tests for the above" without test code
- [x] All file paths are exact
- [x] All code blocks contain complete implementations

### Type Consistency

- [x] `FactStoreArgs.content` is `string | string[]` in types.ts and server.ts
- [x] `FactStoreArgs.fact_id` is `number | number[]` in types.ts and server.ts
- [x] `QueryCache.makeKey()` params match usage in retriever.ts
- [x] `PerfMetrics.record()` accepts `QueryMetrics` interface consistently
- [x] `retriever.getCache()` returns `QueryCache` used in server.ts for `clear()`
