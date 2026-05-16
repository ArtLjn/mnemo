/**
 * 混合检索管线。
 * 移植自 Ocean CLI FactRetriever，使用 better-sqlite3。
 *
 * 管线：FTS5 候选集 → Jaccard 重排序 → 信任评分加权 → 时间衰减
 * 高级检索：probe/related/reason 基于 fact_entities 关联表
 * 矛盾检测：实体重叠 + 内容差异
 */

import type Database from 'better-sqlite3'
import type { Fact, FactCategory, ScoredFact, Contradiction, SearchOptions, ContradictOptions, RetrieverOptions } from './types.js'
import { MemoryStore } from './store.js'
import { QueryCache } from './cache.js'
import { PerfMetrics } from './metrics.js'
import { refineQuery } from './refine.js'

// 中文字符级匹配的虚词集合（这些单字太常见，不参与字符交叉匹配）
const CN_OVERLAP_STOP = new Set([
  '的', '了', '是', '在', '有', '和', '就', '不', '人', '都',
  '一', '个', '上', '也', '很', '到', '说', '要', '去', '你',
  '会', '着', '没', '看', '好', '自', '这', '他', '她', '它',
  '那', '些', '用', '对', '下', '为', '从', '被', '把', '能',
  '可', '以', '所', '而', '又', '与', '但', '或', '等', '中',
  '大', '小', '多', '少', '其', '之', '做', '让', '给', '已',
  '还', '来', '地', '得', '过', '时', '里', '后', '前', '当',
])

interface FtsCandidate extends Fact {
  ftsRank: number
}

export class FactRetriever {
  private db: Database.Database
  private ftsWeight: number
  private jaccardWeight: number
  private halfLifeDays: number
  /** 查询缓存（60s TTL，进程内 Map） */
  private cache: QueryCache
  /** 性能指标（MNEMO_DEBUG=1 时生效） */
  private metrics: PerfMetrics
  /** category → 高频 tag 集合（从事实库自动学习，惰性初始化） */
  private _categoryTagMap: Map<FactCategory, Set<string>> | null = null
  /** 中英术语对列表（从事实库自动学习，惰性初始化） */
  private _cnEnPairs: Array<[string, string]> | null = null

  constructor(
    private store: MemoryStore,
    options?: RetrieverOptions,
  ) {
    this.db = store.connection
    this.ftsWeight = options?.ftsWeight ?? 0.5
    this.jaccardWeight = options?.jaccardWeight ?? 0.5
    this.halfLifeDays = options?.temporalDecayHalfLife ?? 0
    this.cache = new QueryCache()
    this.metrics = new PerfMetrics()
  }

  /** 获取缓存实例（供 server.ts 写操作时调用 cache.clear()） */
  getCache(): QueryCache {
    return this.cache
  }

  /** 获取性能指标实例（供调试接口使用） */
  getMetrics(): PerfMetrics {
    return this.metrics
  }

  /** 主搜索：FTS5 → LIKE → 字符交叉 → 分类推断 → Jaccard → 信任评分 → 时间衰减 */
  search(query: string, options?: SearchOptions & { skipRefine?: boolean }): ScoredFact[] {
    const startTime = performance.now()
    const minTrust = options?.minTrust ?? 0.3
    const limit = options?.limit ?? 10
    const category = options?.category

    // 查询提炼（除非显式跳过）
    let searchQuery = query
    if (!options?.skipRefine) {
      const refined = refineQuery(query)
      if (refined?.query) {
        searchQuery = refined.query
      }
    }

    // 缓存检查
    const cacheKey = this.cache.makeKey({ action: 'search', query: searchQuery, category, minTrust, limit })
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.metrics.record({ action: 'search', durationMs: performance.now() - startTime, resultCount: cached.length, cacheHit: true })
      return cached
    }

    // 查询双语扩展：中文术语追加英文，英文术语追加中文
    const expandedQuery = this.expandQueryBilingually(searchQuery)

    // Stage 1: FTS5 候选集，空时逐级 fallback（使用双语扩展后的查询）
    let candidates = this.ftsCandidates(expandedQuery, category, minTrust, limit * 3)
    if (candidates.length === 0) {
      candidates = this.likeFallback(expandedQuery, category, minTrust, limit * 3)
    }
    if (candidates.length === 0) {
      candidates = this.charOverlapFallback(expandedQuery, category, minTrust, limit * 3)
    }
    if (candidates.length === 0) {
      // 分类推断 fallback（仅无 category 过滤时生效）
      if (!category) {
        const inferred = this.categoryInferFallback(searchQuery, minTrust, limit)
        if (inferred.length > 0) return inferred
      }
      // 个人/身份相关的短查询触发 trust fallback（用原始 query，避免 refineQuery 拆词导致正则失配）
      if (this.isPersonalQuery(query)) {
        return this.trustFallback(category, minTrust, limit)
      }
      return []
    }

    // Stage 2-4: Jaccard 重排序 + 信任评分 + 时间衰减 + length penalty
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

      // 静态权重 0.5/0.5（回退 v3 动态权重）
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
      // 记录检索日志
      this.store.logRetrieval(searchQuery, results.map(r => ({ id: r.factId, score: Math.round(r.score * 1000) / 1000 })))
    }

    // 缓存存储 + 指标记录
    this.cache.set(cacheKey, results)
    this.metrics.record({ action: 'search', durationMs: performance.now() - startTime, resultCount: results.length, cacheHit: false, retrievalPath: 'FTS5' })
    return results
  }

  /** 实体探测：查询某实体关联的所有事实 */
  probe(entity: string, options?: SearchOptions): ScoredFact[] {
    const startTime = performance.now()
    const limit = options?.limit ?? 10
    const category = options?.category

    // 缓存检查
    const cacheKey = this.cache.makeKey({ action: 'probe', entity, category, limit })
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.metrics.record({ action: 'probe', durationMs: performance.now() - startTime, resultCount: cached.length, cacheHit: true })
      return cached
    }

    const facts = this.store.getFactsByEntity(entity, category, limit)
    const results = facts.map((f, i) => ({
      ...f,
      score: f.trustScore * (1 - i * 0.05), // 按信任评分排序并给微小梯度
    }))

    // 缓存存储 + 指标记录
    this.cache.set(cacheKey, results)
    this.metrics.record({ action: 'probe', durationMs: performance.now() - startTime, resultCount: results.length, cacheHit: false, retrievalPath: 'entity' })
    return results
  }

  /** 实体关联：查找与某实体共享上下文的其他事实 */
  related(entity: string, options?: SearchOptions): ScoredFact[] {
    const startTime = performance.now()
    const limit = options?.limit ?? 10
    const category = options?.category

    // 缓存检查
    const cacheKey = this.cache.makeKey({ action: 'related', entity, category, limit })
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.metrics.record({ action: 'related', durationMs: performance.now() - startTime, resultCount: cached.length, cacheHit: true })
      return cached
    }

    // Step 1: 获取实体关联的 fact_id 列表
    const entityFactsSql = `
      SELECT fe.fact_id FROM fact_entities fe
      JOIN entities e ON fe.entity_id = e.entity_id
      WHERE e.name LIKE ?
    `
    const entityFactRows = this.db.prepare(entityFactsSql).all(entity) as Array<{ fact_id: number }>
    if (entityFactRows.length === 0) {
      const emptyResults: ScoredFact[] = []
      this.cache.set(cacheKey, emptyResults)
      this.metrics.record({ action: 'related', durationMs: performance.now() - startTime, resultCount: 0, cacheHit: false, retrievalPath: 'entity' })
      return emptyResults
    }

    const factIds = entityFactRows.map(r => r.fact_id)

    // Step 2: 获取这些 facts 关联的其他实体
    const placeholders = factIds.map(() => '?').join(',')
    const otherEntityRows = this.db.prepare(`
      SELECT DISTINCT e.name FROM entities e
      JOIN fact_entities fe ON fe.entity_id = e.entity_id
      WHERE fe.fact_id IN (${placeholders})
        AND e.name NOT LIKE ?
    `).all(...factIds, entity) as Array<{ name: string }>

    if (otherEntityRows.length === 0) {
      const emptyResults: ScoredFact[] = []
      this.cache.set(cacheKey, emptyResults)
      this.metrics.record({ action: 'related', durationMs: performance.now() - startTime, resultCount: 0, cacheHit: false, retrievalPath: 'entity' })
      return emptyResults
    }

    // Step 3: 获取关联这些其他实体但不包含原始事实的 facts
    const otherEntities = otherEntityRows.map(r => r.name)
    const entityPlaceholders = otherEntities.map(() => '?').join(',')
    const excludePlaceholders = factIds.map(() => '?').join(',')

    let categoryClause = ''
    const params: unknown[] = [...otherEntities, ...factIds]
    if (category) {
      categoryClause = 'AND f.category = ?'
      params.push(category)
    }
    params.push(limit)

    const sql = `
      SELECT DISTINCT f.fact_id, f.content, f.category, f.tags, f.keywords,
             f.trust_score, f.retrieval_count, f.helpful_count,
             f.created_at, f.updated_at
      FROM facts f
      JOIN fact_entities fe ON f.fact_id = fe.fact_id
      JOIN entities e ON fe.entity_id = e.entity_id
      WHERE e.name IN (${entityPlaceholders})
        AND f.fact_id NOT IN (${excludePlaceholders})
        ${categoryClause}
      ORDER BY f.trust_score DESC
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(...params) as Array<{
      fact_id: number; content: string; category: string; tags: string; keywords: string;
      trust_score: number; retrieval_count: number; helpful_count: number;
      created_at: string; updated_at: string;
    }>

    const results = rows.map((r, i) => ({
      factId: r.fact_id,
      content: r.content,
      category: r.category as FactCategory,
      tags: r.tags,
      keywords: r.keywords ?? '[]',
      summary: (r as any).summary ?? null,
      trustScore: r.trust_score,
      retrievalCount: r.retrieval_count,
      helpfulCount: r.helpful_count,
      lastRetrievedAt: (r as any).last_retrieved_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      score: r.trust_score * (1 - i * 0.05),
    }))

    // 缓存存储 + 指标记录
    this.cache.set(cacheKey, results)
    this.metrics.record({ action: 'related', durationMs: performance.now() - startTime, resultCount: results.length, cacheHit: false, retrievalPath: 'entity' })
    return results
  }

  /** 多实体推理：查找同时关联多个实体的事实 */
  reason(entities: string[], options?: SearchOptions): ScoredFact[] {
    const startTime = performance.now()
    if (entities.length === 0) return []

    const category = options?.category
    const limit = options?.limit ?? 10

    // 缓存检查
    const cacheKey = this.cache.makeKey({ action: 'reason', entities, category, limit })
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.metrics.record({ action: 'reason', durationMs: performance.now() - startTime, resultCount: cached.length, cacheHit: true })
      return cached
    }

    const facts = this.store.getFactsByEntities(entities, category, limit)
    const results = facts.map((f, i) => ({
      ...f,
      score: f.trustScore * (1 - i * 0.05),
    }))

    // 缓存存储 + 指标记录
    this.cache.set(cacheKey, results)
    this.metrics.record({ action: 'reason', durationMs: performance.now() - startTime, resultCount: results.length, cacheHit: false, retrievalPath: 'entity' })
    return results
  }

  /** 矛盾检测：实体重叠 + 内容差异（仅指标，不缓存 — 返回类型不同） */
  contradict(options?: ContradictOptions): Contradiction[] {
    const startTime = performance.now()
    const threshold = options?.threshold ?? 0.3
    const limit = options?.limit ?? 10
    const category = options?.category

    // 获取事实
    let whereClause = ''
    const params: unknown[] = []
    if (category) {
      whereClause = 'WHERE f.category = ?'
      params.push(category)
    }

    let rows = this.db.prepare(`
      SELECT f.fact_id, f.content, f.category, f.tags, f.keywords, f.trust_score,
             f.created_at, f.updated_at
      FROM facts f
      ${whereClause}
      ORDER BY f.updated_at DESC
    `).all(...params) as Array<{
      fact_id: number; content: string; category: string; tags: string; keywords: string;
      trust_score: number; created_at: string; updated_at: string;
    }>

    if (rows.length < 2) return []

    // 限制 O(n²) 复杂度
    const MAX_FACTS = 500
    if (rows.length > MAX_FACTS) rows = rows.slice(0, MAX_FACTS)

    // 构建实体集合
    const factEntities = new Map<number, Set<string>>()
    for (const row of rows) {
      const names = this.store.getEntitiesForFact(row.fact_id)
      factEntities.set(row.fact_id, new Set(names.map(n => n.toLowerCase())))
    }

    // 比对所有事实对
    const contradictions: Contradiction[] = []
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const f1 = rows[i]
        const f2 = rows[j]
        const ents1 = factEntities.get(f1.fact_id) ?? new Set()
        const ents2 = factEntities.get(f2.fact_id) ?? new Set()

        if (ents1.size === 0 || ents2.size === 0) continue

        // 实体重叠 (Jaccard)
        const intersection = new Set([...ents1].filter(e => ents2.has(e)))
        const union = new Set([...ents1, ...ents2])
        const entityOverlap = union.size > 0 ? intersection.size / union.size : 0

        if (entityOverlap < 0.3) continue

        // 内容相似度 (Jaccard on tokens)
        const tokens1 = this.tokenize(f1.content)
        const tokens2 = this.tokenize(f2.content)
        const contentSim = this.jaccardSimilarity(tokens1, tokens2)

        // 高实体重叠 + 低内容相似度 = 潜在矛盾
        const contradictionScore = entityOverlap * (1 - contentSim)

        if (contradictionScore >= threshold) {
          const toFact = (r: typeof rows[0]): Fact => ({
            factId: r.fact_id,
            content: r.content,
            category: r.category as FactCategory,
            tags: r.tags,
            keywords: r.keywords ?? '[]',
            summary: (r as any).summary ?? null,
            trustScore: r.trust_score,
            retrievalCount: 0,
            helpfulCount: 0,
            lastRetrievedAt: (r as any).last_retrieved_at ?? null,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })

          contradictions.push({
            factA: toFact(f1),
            factB: toFact(f2),
            entityOverlap: Math.round(entityOverlap * 1000) / 1000,
            contentSimilarity: Math.round(contentSim * 1000) / 1000,
            contradictionScore: Math.round(contradictionScore * 1000) / 1000,
            sharedEntities: [...intersection],
          })
        }
      }
    }

    contradictions.sort((a, b) => b.contradictionScore - a.contradictionScore)
    const results = contradictions.slice(0, limit)

    // 指标记录（无缓存 — Contradiction[] 不适用于 ScoredFact 缓存）
    this.metrics.record({ action: 'contradict', durationMs: performance.now() - startTime, resultCount: results.length, cacheHit: false, retrievalPath: 'O(n²)' })
    return results
  }

  // ------------------------------------------------------------------
  // 内部方法
  // ------------------------------------------------------------------

  /** Stage 1: FTS5 候选集 */
  private ftsCandidates(
    query: string,
    category: FactCategory | undefined,
    minTrust: number,
    limit: number,
  ): FtsCandidate[] {
    // 将查询转为 FTS5 可匹配的形式：
    // 1. 原始词用 OR 连接
    // 2. 中文部分追加 bigram，提升中文搜索召回率
    const parts = query.split(/\s+/).filter(w => w.length > 0)
    const ftsParts: string[] = []

    for (const word of parts) {
      ftsParts.push(`"${word}"`)
      // 对中文部分追加 bigram
      const cnChars = word.match(/[\u4e00-\u9fff]+/g)
      if (cnChars) {
        for (const seg of cnChars) {
          for (let i = 0; i < seg.length - 1; i++) {
            ftsParts.push(seg.slice(i, i + 2))
          }
        }
      }
    }

    const ftsQuery = ftsParts.join(' OR ')
    if (!ftsQuery) return []

    const params: unknown[] = [ftsQuery, minTrust]
    const whereClauses = ['facts_fts MATCH ?', 'f.trust_score >= ?']

    if (category) {
      whereClauses.push('f.category = ?')
      params.push(category)
    }
    params.push(limit)

    const whereSql = whereClauses.join(' AND ')

    const sql = `
      SELECT f.*, facts_fts.rank as fts_rank_raw
      FROM facts_fts
      JOIN facts f ON f.fact_id = facts_fts.rowid
      WHERE ${whereSql}
      ORDER BY facts_fts.rank
      LIMIT ?
    `

    let rows: Array<Record<string, unknown>>
    try {
      rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    } catch {
      // FTS5 MATCH 可能在格式错误的查询上失败 — fallback 到 LIKE
      return this.likeFallback(query, category, minTrust, limit)
    }

    if (rows.length === 0) return []

    // 归一化 FTS5 rank: rank 是负数，越小越好
    const rawRanks = rows.map(r => Math.abs(Number(r.fts_rank_raw)))
    const maxRank = Math.max(...rawRanks, 1e-6)

    return rows.map((row, i) => ({
      factId: Number(row.fact_id),
      content: String(row.content),
      category: String(row.category) as FactCategory,
      tags: String(row.tags),
      keywords: String(row.keywords ?? '[]'),
      summary: row.summary != null ? String(row.summary) : null,
      trustScore: Number(row.trust_score),
      retrievalCount: Number(row.retrieval_count),
      helpfulCount: Number(row.helpful_count),
      lastRetrievedAt: row.last_retrieved_at != null ? String(row.last_retrieved_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ftsRank: rawRanks[i] / maxRank,
    }))
  }

  /** 简单分词：空格/下划线/中英文标点分割 + 小写 + 中文 bigram */
  private tokenize(text: string): Set<string> {
    if (!text) return new Set()
    const tokens = new Set<string>()
    // 将下划线、中文标点、连接符都视为分隔符，再按空格分词
    const normalized = text.toLowerCase()
      .replace(/[_\-/\\|]/g, ' ')
      .replace(/[，。！？；：、""''【】《》（）…—·,.;:!?'"()\[\]{}<>@#$%^&*+=~`]/g, ' ')
    for (const word of normalized.split(/\s+/)) {
      if (word && word.length > 1) tokens.add(word)
    }
    // 中文 bigram：提升 Jaccard 对中文内容的匹配能力
    const cnChars = text.match(/[\u4e00-\u9fff]+/g) ?? []
    for (const seg of cnChars) {
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.add(seg.slice(i, i + 2))
      }
    }
    return tokens
  }

  /** Jaccard 相似度 */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0
    let intersection = 0
    for (const item of a) {
      if (b.has(item)) intersection++
    }
    const unionSize = a.size + b.size - intersection
    return unionSize > 0 ? intersection / unionSize : 0
  }

  /** Containment: a 中有多少比例的 token 出现在 b 中（不对称，衡量"查询被事实覆盖"的程度） */
  private containmentScore(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0
    let hits = 0
    for (const item of a) {
      if (b.has(item)) hits++
    }
    return hits / a.size
  }

  /** 时间衰减: 0.5^(ageDays / halfLifeDays) */
  private temporalDecay(timestampStr: string | null): number {
    if (!this.halfLifeDays || !timestampStr) return 1.0

    try {
      const ts = new Date(timestampStr) // SQLite datetime 是本地时间
      const ageMs = Date.now() - ts.getTime()
      const ageDays = ageMs / 86400000
      if (ageDays < 0) return 1.0
      return Math.pow(0.5, ageDays / this.halfLifeDays)
    } catch {
      return 1.0
    }
  }

  /** 判断查询是否为个人/身份相关（应触发 trust fallback） */
  private isPersonalQuery(query: string): boolean {
    const q = query.trim().toLowerCase()
    // 短查询（<=20字）+ 包含个人/身份关键词
    if (q.length > 20) return false

    // 通用身份/关于用户的查询模式
    const patterns = [
      /你(是谁|叫什么|的名字|的身份)/,
      /我(是谁|叫什么|的名字|的身份|喜欢|偏好|习惯)/,
      /(认识|记得|记住|知道).{0,4}(我|你)/,
      /(名字|身份|称呼|角色|profile)/,
      /(who are you|who am i|my name|about me|my role|call me|remember me)/i,
    ]
    return patterns.some(p => p.test(q))
  }

  /** Trust fallback — 查询无法匹配任何事实时，按信任评分返回 top-N */
  private trustFallback(
    category: FactCategory | undefined,
    minTrust: number,
    limit: number,
  ): ScoredFact[] {
    const facts = this.store.listFacts(category, minTrust, limit)
    return facts.map((f, i) => ({
      ...f,
      score: f.trustScore * (1 - i * 0.05),
    }))
  }

  /** LIKE fallback — FTS5 失败或中文查询时使用 */
  private likeFallback(
    query: string,
    category: FactCategory | undefined,
    minTrust: number,
    limit: number,
  ): FtsCandidate[] {
    const words = query.split(/\s+/).filter(w => w.length > 0)
    if (words.length === 0) return []

    // 对每个词做 LIKE 匹配，取并集
    const conditions: string[] = []
    const params: unknown[] = []
    for (const word of words) {
      conditions.push('(f.content LIKE ? OR f.tags LIKE ? OR f.summary LIKE ?)')
      params.push(`%${word}%`, `%${word}%`, `%${word}%`)
    }

    // 中文子串分解：将中文查询拆为 2~3 字滑动窗口，追加 LIKE 条件
    // 例："颜色忌讳" → LIKE "%颜色%" OR "%色忌%" OR "%忌讳%"
    const cnChars = query.match(/[\u4e00-\u9fff]+/g)
    if (cnChars) {
      for (const seg of cnChars) {
        if (seg.length < 2) continue
        // 2-gram
        for (let i = 0; i < seg.length - 1; i++) {
          const bigram = seg.slice(i, i + 2)
          conditions.push('(f.content LIKE ? OR f.tags LIKE ? OR f.summary LIKE ?)')
          params.push(`%${bigram}%`, `%${bigram}%`, `%${bigram}%`)
        }
        // 3-gram（覆盖更长的短语匹配）
        for (let i = 0; i < seg.length - 2; i++) {
          const trigram = seg.slice(i, i + 3)
          conditions.push('(f.content LIKE ? OR f.tags LIKE ? OR f.summary LIKE ?)')
          params.push(`%${trigram}%`, `%${trigram}%`, `%${trigram}%`)
        }
      }
    }

    const conditionsSql = conditions.join(' OR ')

    params.push(minTrust)
    let categoryClause = ''
    if (category) {
      categoryClause = 'AND f.category = ?'
      params.push(category)
    }
    params.push(limit)

    const sql = `
      SELECT f.fact_id, f.content, f.category, f.tags, f.keywords,
             f.summary, f.trust_score, f.retrieval_count, f.helpful_count,
             f.created_at, f.updated_at
      FROM facts f
      WHERE (${conditionsSql})
        AND f.trust_score >= ?
        ${categoryClause}
      ORDER BY f.trust_score DESC
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(...params) as Array<{
      fact_id: number; content: string; category: string; tags: string; keywords: string;
      summary: string | null;
      trust_score: number; retrieval_count: number; helpful_count: number;
      created_at: string; updated_at: string;
    }>

    // LIKE 没有排名，给统一的中间排名
    return rows.map(r => ({
      factId: r.fact_id,
      content: r.content,
      category: r.category as FactCategory,
      tags: r.tags,
      keywords: r.keywords ?? '[]',
      summary: r.summary ?? null,
      trustScore: r.trust_score,
      retrievalCount: r.retrieval_count,
      helpfulCount: r.helpful_count,
      lastRetrievedAt: (r as any).last_retrieved_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ftsRank: 0.5,
    }))
  }

  /** 中文字符级 fallback — FTS5 和 LIKE 都失败时，用单字交叉匹配 */
  private charOverlapFallback(
    query: string,
    category: FactCategory | undefined,
    minTrust: number,
    limit: number,
  ): FtsCandidate[] {
    // 提取查询中的中文单字（去重，排除常见虚词）
    const cnChars = [...new Set((query.match(/[\u4e00-\u9fff]/g) ?? []))]
      .filter(c => !CN_OVERLAP_STOP.has(c))
    if (cnChars.length < 2) return [] // 中文单字太少，不值得匹配

    // 内存中扫描所有事实，计算字符重叠率
    const allFacts = this.store.listFacts(category, minTrust, 200)
    const results: Array<{ fact: Fact; overlap: number }> = []

    for (const fact of allFacts) {
      const text = (fact.content + fact.tags)
      let hits = 0
      for (const c of cnChars) {
        if (text.includes(c)) hits++
      }
      const overlap = hits / cnChars.length
      // 至少 40% 的查询字符出现在事实中
      if (overlap >= 0.4) {
        results.push({ fact, overlap })
      }
    }

    if (results.length === 0) return []

    // 按重叠率 * 信任评分排序
    results.sort((a, b) => (b.overlap * b.fact.trustScore) - (a.overlap * a.fact.trustScore))

    return results.slice(0, limit).map(({ fact, overlap }) => ({
      ...fact,
      ftsRank: overlap * 0.8, // 字符重叠率作为伪排名
    }))
  }

  /** 分类推断 fallback — 根据查询关键词推断 category，返回该分类的高信任事实 */
  private categoryInferFallback(
    query: string,
    minTrust: number,
    limit: number,
  ): ScoredFact[] {
    const inferred = this.inferCategory(query)
    if (!inferred) return []

    const facts = this.store.listFacts(inferred, minTrust, limit)
    return facts.map((f, i) => ({
      ...f,
      score: f.trustScore * (1 - i * 0.05) * 0.7, // 分类推断的确定性较低，乘以 0.7 折扣
    }))
  }

  /** 从事实库自动学习 category → tag 映射（惰性初始化 + 缓存） */
  private getCategoryTagMap(): Map<FactCategory, Set<string>> {
    if (this._categoryTagMap) return this._categoryTagMap

    const map = new Map<FactCategory, Set<string>>()
    const allFacts = this.store.listFacts(undefined, 0.2, 200)

    for (const fact of allFacts) {
      if (!map.has(fact.category)) map.set(fact.category, new Set())
      const tagSet = map.get(fact.category)!
      // 从 tags 字段提取
      for (const tag of fact.tags.split(',')) {
        const t = tag.trim().toLowerCase()
        if (t.length >= 2) tagSet.add(t)
      }
      // 从 content 提取中文 bigram 作为隐式 tag
      const cnChars = fact.content.match(/[\u4e00-\u9fff]+/g) ?? []
      for (const seg of cnChars) {
        for (let i = 0; i < seg.length - 1; i++) {
          const bg = seg.slice(i, i + 2)
          if (!CN_OVERLAP_STOP.has(bg[0]) && !CN_OVERLAP_STOP.has(bg[1])) {
            tagSet.add(bg)
          }
        }
      }
      // 从 content 提取英文单词（≥3 字母）作为隐式 tag
      const enWords = fact.content.match(/[a-zA-Z]{3,}/g) ?? []
      for (const w of enWords) {
        tagSet.add(w.toLowerCase())
      }
    }

    this._categoryTagMap = map
    return map
  }

  /**
   * 从事实库自动学习中英术语对（惰性初始化 + 缓存）。
   * 两个来源：
   * 1. 种子表：极小的核心 IT 术语对照（稳定不变，覆盖高频查询）
   * 2. 事实库提取：括号注释/分隔符关联的高置信翻译对（自动增长）
   * 歧义对（一个中文对应多个英文）自动丢弃。
   */
  private getCnEnPairs(): Array<[string, string]> {
    if (this._cnEnPairs) return this._cnEnPairs

    // cn → [en列表]
    const candidateMap = new Map<string, Set<string>>()

    // 种子表：核心 IT 术语（极小、稳定、高频，约20对）
    const SEED_PAIRS: Array<[string, string]> = [
      ['抓取', 'scraping'], ['爬虫', 'crawler'], ['逆向', 'reverse'],
      ['部署', 'deploy'], ['架构', 'architecture'], ['接口', 'api'],
      ['数据库', 'database'], ['缓存', 'cache'], ['配置', 'config'],
      ['构建', 'build'], ['编译', 'compile'], ['调试', 'debug'],
      ['测试', 'test'], ['提交', 'commit'], ['合并', 'merge'],
      ['终端', 'terminal'], ['命令行', 'cli'], ['邮箱', 'email'],
      ['模型', 'model'], ['插件', 'plugin'], ['渐变', 'gradient'],
    ]
    for (const [cn, en] of SEED_PAIRS) {
      this.addPair(candidateMap, cn, en)
    }

    // 从事实库提取高置信对
    const allFacts = this.store.listFacts(undefined, 0.2, 200)
    for (const fact of allFacts) {
      const text = fact.content + ' ' + fact.tags

      // 括号注释："逆向（reverse）"
      for (const m of text.matchAll(/([\u4e00-\u9fff]{2,4})\s*[（(]\s*([a-zA-Z]{2,})\s*[)）]/g))
        this.addPair(candidateMap, m[1], m[2].toLowerCase())
      for (const m of text.matchAll(/([a-zA-Z]{2,})\s*[（(]\s*([\u4e00-\u9fff]{2,4})\s*[)）]/g))
        this.addPair(candidateMap, m[2], m[1].toLowerCase())

      // 分隔符关联："名称:BlockShip"
      for (const m of text.matchAll(/([\u4e00-\u9fff]{2,4})\s*[：:=]\s*([a-zA-Z]{2,})/g))
        this.addPair(candidateMap, m[1], m[2].toLowerCase())
      for (const m of text.matchAll(/([a-zA-Z]{2,})\s*[：:=]\s*([\u4e00-\u9fff]{2,4})/g))
        this.addPair(candidateMap, m[2], m[1].toLowerCase())
    }

    // 过滤：只保留唯一映射，歧义对丢弃
    const pairs: Array<[string, string]> = []
    for (const [cn, enSet] of candidateMap) {
      if (enSet.size === 1) {
        const en = [...enSet][0]
        if (en.length >= 2 && !CN_OVERLAP_STOP.has(cn[0])) {
          pairs.push([cn, en])
        }
      }
    }

    this._cnEnPairs = pairs
    return pairs
  }

  /** 添加候选对到 map */
  private addPair(map: Map<string, Set<string>>, cn: string, en: string): void {
    if (!map.has(cn)) map.set(cn, new Set())
    map.get(cn)!.add(en)
  }

  /** 查询双语扩展：基于事实库自动学习的术语对照，将查询中的术语翻译为对端语言 */
  private expandQueryBilingually(query: string): string {
    const pairs = this.getCnEnPairs()
    if (pairs.length === 0) return query

    const extras: string[] = []
    const ql = query.toLowerCase()

    for (const [cn, en] of pairs) {
      // 中文→英文
      if (ql.includes(cn) && !ql.includes(en)) {
        extras.push(en)
      }
      // 英文→中文
      if (ql.includes(en) && !ql.includes(cn)) {
        extras.push(cn)
      }
    }

    return extras.length > 0 ? `${query} ${extras.join(' ')}` : query
  }

  /** 从查询内容推断 category — 基于事实库自动学习的 tag 映射 */
  private inferCategory(query: string): FactCategory | null {
    const tagMap = this.getCategoryTagMap()
    const q = query.toLowerCase()

    let bestCategory: FactCategory | null = null
    let bestScore = 0

    for (const [cat, tags] of tagMap) {
      let score = 0
      for (const tag of tags) {
        if (q.includes(tag)) score++
      }
      if (score > bestScore) {
        bestScore = score
        bestCategory = cat
      }
    }

    return bestScore >= 1 ? bestCategory : null
  }

  /** 检索追踪：递增 retrieval_count + top3 信任刷新（重置衰减时钟） */
  private trackRetrieval(facts: ScoredFact[]): void {
    if (facts.length === 0) return

    const ids = facts.map(f => f.factId)
    const placeholders = ids.map(() => '?').join(',')

    // 递增所有返回结果的检索计数
    this.db.prepare(
      `UPDATE facts SET retrieval_count = retrieval_count + 1 WHERE fact_id IN (${placeholders})`
    ).run(...ids)

    // top 3 信任刷新：+0.01 信任 + 重置 updated_at
    const topN = facts.slice(0, 3)
    for (const f of topN) {
      this.db.prepare(
        `UPDATE facts SET trust_score = MIN(1.0, trust_score + 0.01), updated_at = datetime('now', 'localtime') WHERE fact_id = ?`
      ).run(f.factId)
    }
  }
}
