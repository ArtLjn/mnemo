## Context

mnemo-mcp 作为独立 MCP server，每次 fact_store tool 调用都直接查询 SQLite（FTS5 + Jaccard + 多级 fallback）。相同 query 在短时间内重复检索浪费计算资源。同时缺少批量操作能力，一次只能 add 一条事实，MCP 往返次数多。

当前查询链路：
```
tool call → server.ts → retriever.search() → FTS5 → Jaccard → 评分 → 返回
```

优化目标：减少重复查询开销，支持批量操作，提升整体响应速度。

## Goals / Non-Goals

**Goals:**
- 实现查询结果缓存层，相同 query + 参数在 TTL 内直接返回缓存
- 支持批量 add 操作，一次写入多条事实
- 增加性能监控（debug 模式），记录查询耗时和缓存命中率
- 启动时延迟加载非关键索引，减少首次响应时间

**Non-Goals:**
- 不修改检索算法（FTS5 + Jaccard 不动）
- 不修改存储 schema（facts/entities/fact_entities 表结构不变）
- 不做分布式缓存（单机 SQLite，本地内存缓存足够）
- 不做持久化缓存（进程级缓存，重启失效可接受）

## Decisions

### 1. 缓存实现方式

**选择**：进程内 Map 缓存，基于 query + category + limit + minTrust 做键

```typescript
interface CacheEntry {
  results: ScoredFact[]
  timestamp: number
  queryKey: string
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000
```

**理由**：mnemo-mcp 是单进程 MCP server，没有多进程共享需求。Map 简单高效，不需要引入 Redis 等外部依赖。

### 2. 缓存失效策略

**选择**：写操作（add/update/remove）时清空全部缓存

**理由**：事实写入会改变查询结果，但写入频率远低于查询频率。全量清空实现简单，不需要维护复杂的依赖图。

### 3. 批量 add 接口

**选择**：扩展 fact_store 的 add action，支持 `content` 为数组

```typescript
// 单条（兼容现有）
{ action: 'add', content: '事实内容', category: 'general' }

// 批量（新增）
{ action: 'add', content: ['事实1', '事实2'], category: 'general' }
```

**理由**：保持接口向后兼容，现有单条调用不受影响。批量返回数组形式的 fact_id 和状态。

### 4. 性能监控

**选择**：环境变量开关 `MNEMO_DEBUG=1`，开启时记录查询日志

**记录内容**：
- 查询耗时（ms）
- 是否命中缓存
- 检索路径（FTS5 / LIKE / charOverlap / categoryInfer / trustFallback）
- 返回结果数

**理由**：默认关闭避免性能开销，开发调试时开启。

### 5. 延迟加载

**选择**：启动时不预加载 category_tag_map 和 cn_en_pairs，首次查询时惰性初始化

**理由**：这两个数据结构在 `FactRetriever` 中已经是惰性初始化的（`getCategoryTagMap()` 和 `getCnEnPairs()`），但启动时的 `auditContradictions` 和 `decayTrustScores` 会触发数据库全表扫描。改为启动时跳过这些操作，首次 tool 调用时再执行。

## Risks / Trade-offs

- **[缓存雪崩]** → 大量并发请求同时命中失效缓存。缓解：缓存失效是同步的，SQLite 的 WAL 模式本身有锁保护。
- **[批量 add 部分失败]** → 数组中某条写入失败（如 UNIQUE 冲突）。缓解：逐条处理，返回每条独立的状态，部分成功部分失败。
- **[延迟加载导致首次查询慢]** → 启动时跳过的审计和衰减在首次查询时执行。缓解：这些操作通常很快（<100ms），且只在首次触发。

## Migration Plan

无需迁移。新增功能完全向后兼容，现有 tool 调用方式不变。

## Open Questions

- 是否需要支持缓存预热（启动时预加载高频查询）？
- 批量 add 是否需要支持每条不同的 category 和 tags？
