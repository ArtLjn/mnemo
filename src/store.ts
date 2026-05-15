/**
 * SQLite 事实存储层。
 * 移植自 Ocean CLI MemoryStore，使用 better-sqlite3 同步 API。
 *
 * 职责：
 * - CRUD 操作（facts + entities + fact_entities）
 * - 实体自动提取（正则模式）
 * - 信任评分反馈（非对称调整）
 * - 去重（content UNIQUE 约束）
 */

import Database from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA } from './schema.js'
import type { Fact, FactCategory } from './types.js'

// 信任评分常量
const HELPFUL_DELTA = 0.05
const UNHELPFUL_DELTA = -0.10
const TRUST_MIN = 0.0
const TRUST_MAX = 1.0

// 信任衰减配置：每个 category 的宽限期和衰减速率
const DECAY_CONFIG: Record<string, { graceDays: number; decayPerWeek: number }> = {
  identity:     { graceDays: 60, decayPerWeek: 0.02 }, // 身份信息稳定
  coding_style: { graceDays: 30, decayPerWeek: 0.03 }, // 编码习惯渐变
  tool_pref:    { graceDays: 30, decayPerWeek: 0.03 }, // 工具偏好渐变
  workflow:     { graceDays: 45, decayPerWeek: 0.02 }, // 工作流较稳定
  project:      { graceDays: 30, decayPerWeek: 0.05 }, // 项目知识：开发中自动续命，停工后30天开始衰减
  general:      { graceDays: 30, decayPerWeek: 0.03 }, // 通用中等
}
const DEFAULT_DECAY = DECAY_CONFIG.general
const MIN_SURVIVAL_TRUST = 0.1

// 实体提取正则
const RE_CAPITALIZED = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g
const RE_DOUBLE_QUOTE = /"([^"]+)"/g
const RE_SINGLE_QUOTE = /'([^']+)'/g
const RE_AKA = /(\w+(?:\s+\w+)*)\s+(?:aka|also known as)\s+(\w+(?:\s+\w+)*)/gi
// 中文实体提取正则
const RE_CN_QUOTED = /[「」""'']([^「」""'']{2,20})[「」""'']?/g
const RE_CN_BOOK = /《([^》]+)》/g
// 中文停用词
const CN_STOP_WORDS = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '可以', '应该', '需要',
  '使用', '进行', '通过', '关于', '对于', '根据', '以及', '或者',
  '但是', '因为', '所以', '如果', '虽然', '已经', '正在', '没有',
  '不是', '一个', '一种', '一些', '我们', '他们', '自己', '这些',
  '那些', '可能', '能够', '就是', '还是', '只要', '只有', '然后',
  '所以', '因为', '但是', '而且', '或者', '以及', '如果', '虽然',
])

function clampTrust(value: number): number {
  return Math.max(TRUST_MIN, Math.min(TRUST_MAX, value))
}

/** facts 表行类型 */
interface FactRow {
  fact_id: number
  content: string
  category: string
  tags: string
  keywords: string
  trust_score: number
  retrieval_count: number
  helpful_count: number
  created_at: string
  updated_at: string
}

/** entities 表行类型 */
interface EntityRow {
  entity_id: number
  name: string
  entity_type: string
  aliases: string
  created_at: string
}

export class MemoryStore {
  private db: Database.Database

  // 预编译语句
  private stmtInsertFact!: Statement
  private stmtFindFactByContent!: Statement
  private stmtFindEntityByName!: Statement
  private stmtFindEntityByAlias!: Statement
  private stmtInsertEntity!: Statement
  private stmtInsertFactEntity!: Statement
  private stmtDeleteFactEntities!: Statement
  private stmtGetEntitiesForFact!: Statement

  constructor(dbPath: string, private defaultTrust = 0.5) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initSchema()
    this.prepareStatements()
    this.cleanOrphanEntities()
  }

  private initSchema(): void {
    this.db.exec(SCHEMA)
    // 增量迁移：为已有数据库添加新列/新表
    this.migrateSchema()
  }

  /** 增量迁移：添加新列（已存在则跳过） */
  private migrateSchema(): void {
    // keywords 列（v2）
    try {
      this.db.exec('ALTER TABLE facts ADD COLUMN keywords TEXT DEFAULT \'[]\'')
    } catch { /* 列已存在 */ }
  }

  private prepareStatements(): void {
    this.stmtInsertFact = this.db.prepare(
      'INSERT INTO facts (content, category, tags, keywords, trust_score) VALUES (?, ?, ?, ?, ?)'
    )
    this.stmtFindFactByContent = this.db.prepare(
      'SELECT fact_id FROM facts WHERE content = ?'
    )
    this.stmtFindEntityByName = this.db.prepare(
      'SELECT entity_id FROM entities WHERE name = ?'
    )
    this.stmtFindEntityByAlias = this.db.prepare(
      "SELECT entity_id FROM entities WHERE ',' || aliases || ',' LIKE '%,' || ? || ',%'"
    )
    this.stmtInsertEntity = this.db.prepare(
      'INSERT INTO entities (name) VALUES (?)'
    )
    this.stmtInsertFactEntity = this.db.prepare(
      'INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?, ?)'
    )
    this.stmtDeleteFactEntities = this.db.prepare(
      'DELETE FROM fact_entities WHERE fact_id = ?'
    )
    this.stmtGetEntitiesForFact = this.db.prepare(
      `SELECT e.name FROM entities e
       JOIN fact_entities fe ON fe.entity_id = e.entity_id
       WHERE fe.fact_id = ?`
    )
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** 添加事实，返回 fact_id。精确重复返回已有 ID。 */
  addFact(content: string, category: FactCategory = 'general', tags = ''): number {
    const trimmed = content.trim()
    if (!trimmed) throw new Error('content must not be empty')

    // 将中文 bigram 追加到 tags，让 FTS5 能索引中文词组
    const enhancedTags = this.enhanceTagsForChinese(trimmed, tags)

    const insertFacts = this.db.transaction(() => {
      try {
        const info = this.stmtInsertFact.run(trimmed, category, enhancedTags, '[]', this.defaultTrust)
        const factId = Number(info.lastInsertRowid)

        // 实体提取和关联（只从内容中提取，不从 tags 提取）
        const entities = this.extractEntities(trimmed)
        for (const name of entities) {
          const entityId = this.resolveEntity(name)
          this.stmtInsertFactEntity.run(factId, entityId)
        }

        return factId
      } catch (err: unknown) {
        // UNIQUE 冲突 — 返回已有 ID
        if (err instanceof Error && err.message?.includes('UNIQUE')) {
          const row = this.stmtFindFactByContent.get(trimmed) as { fact_id: number } | null
          return row ? row.fact_id : -1
        }
        throw err
      }
    })

    return insertFacts()
  }

  /**
   * 三层递进式去重。
   *
   * 层 1: 实体重叠 + 编辑距离（英文/有明确实体时效果最好）
   * 层 2: Jaccard bigram 相似度（中文回退，bigram 分词不依赖实体提取）
   * 层 3: Containment 包含率（捕捉"旧事实是新事实子集"的场景）
   *
   * 每层找到匹配即返回，不再尝试下一层。
   */
  findSimilarFact(content: string, category?: FactCategory): Fact | null {
    const newEntities = this.extractEntities(content).map(e => e.toLowerCase())
    const existing = this.listFacts(category, 0.0, 50)

    // -- 层 1: 实体重叠 + 编辑距离（保留原逻辑，不短路） --
    if (newEntities.length > 0) {
      const entitySet = new Set(newEntities)
      let bestMatch: Fact | null = null
      let bestScore = 0

      for (const fact of existing) {
        const factEntityNames = (this.stmtGetEntitiesForFact.all(fact.factId) as { name: string }[])
          .map(r => r.name.toLowerCase())
        if (factEntityNames.length === 0) continue

        const factEntitySet = new Set(factEntityNames)

        let overlap = 0
        for (const e of entitySet) { if (factEntitySet.has(e)) overlap++ }
        const newInOld = overlap / entitySet.size
        const oldInNew = overlap / factEntitySet.size
        const entityScore = Math.min(newInOld, oldInNew)

        if (entityScore < 0.5) continue

        const editSim = this.normalizedEditDistance(content, fact.content)
        if (editSim >= 0.5 && editSim > bestScore) {
          bestMatch = fact
          bestScore = editSim
        }
      }
      if (bestMatch) return bestMatch
    }

    // -- 层 2: Jaccard bigram 相似度（中文回退） --
    const tokens = this.tokenizeForDedup(content)
    if (tokens.size >= 3) {
      let bestMatch: Fact | null = null
      let bestScore = 0
      for (const fact of existing) {
        const factTokens = this.tokenizeForDedup(fact.content)
        const sim = this.jaccardSimilarity(tokens, factTokens)
        if (sim >= 0.45 && sim > bestScore) {
          bestMatch = fact
          bestScore = sim
        }
      }
      if (bestMatch) return bestMatch
    }

    // -- 层 3: Containment 包含率（子集检测） --
    if (tokens.size >= 3) {
      for (const fact of existing) {
        const factTokens = this.tokenizeForDedup(fact.content)
        if (this.containmentScore(tokens, factTokens) >= 0.8) {
          return fact
        }
      }
    }

    return null
  }

  /** 归一化编辑距离（Levenshtein），返回 0~1 的相似度 */
  private normalizedEditDistance(a: string, b: string): number {
    if (a === b) return 1
    const la = a.length, lb = b.length
    if (la === 0 || lb === 0) return 0
    // 限制长度差过大的情况：长度差超过3倍直接判不相似
    const maxLen = Math.max(la, lb)
    const minLen = Math.min(la, lb)
    if (minLen * 3 < maxLen) return 0

    // 一维 DP 求编辑距离
    const prev = new Uint16Array(minLen + 1)
    const curr = new Uint16Array(minLen + 1)
    for (let j = 0; j <= minLen; j++) prev[j] = j

    for (let i = 1; i <= maxLen; i++) {
      curr[0] = i
      const ca = i <= la ? a[i - 1] : ''
      for (let j = 1; j <= minLen; j++) {
        const cb = j <= lb ? b[j - 1] : ''
        const cost = ca === cb ? 0 : 1
        curr[j] = Math.min(
          prev[j] + 1,       // 删除
          curr[j - 1] + 1,   // 插入
          prev[j - 1] + cost // 替换
        )
      }
      prev.set(curr)
    }
    return 1 - prev[minLen] / maxLen
  }

  /** 部分更新事实 */
  updateFact(
    factId: number,
    updates: {
      content?: string
      tags?: string
      category?: FactCategory
      trustDelta?: number
    },
  ): boolean {
    const row = this.db.prepare('SELECT fact_id, trust_score FROM facts WHERE fact_id = ?')
      .get(factId) as (Pick<FactRow, 'fact_id' | 'trust_score'>) | null
    if (!row) return false

    const assignments: string[] = ["updated_at = datetime('now', 'localtime')"]
    const params: unknown[] = []

    if (updates.content !== undefined) {
      assignments.push('content = ?')
      params.push(updates.content.trim())
    }
    if (updates.tags !== undefined) {
      assignments.push('tags = ?')
      params.push(updates.tags)
    }
    if (updates.category !== undefined) {
      assignments.push('category = ?')
      params.push(updates.category)
    }
    if (updates.trustDelta !== undefined) {
      const newTrust = clampTrust(row.trust_score + updates.trustDelta)
      assignments.push('trust_score = ?')
      params.push(newTrust)
    }

    params.push(factId)
    this.db.prepare(`UPDATE facts SET ${assignments.join(', ')} WHERE fact_id = ?`).run(...params)

    // 内容变更时重新提取实体
    if (updates.content !== undefined) {
      this.stmtDeleteFactEntities.run(factId)
      const entities = this.extractEntities(updates.content)
      for (const name of entities) {
        const entityId = this.resolveEntity(name)
        this.stmtInsertFactEntity.run(factId, entityId)
      }
      // 清理因内容变更而产生的孤立实体
      this.cleanOrphanEntities()
    }

    return true
  }

  /** 删除事实 */
  removeFact(factId: number): boolean {
    const row = this.db.prepare('SELECT fact_id FROM facts WHERE fact_id = ?').get(factId)
    if (!row) return false
    this.stmtDeleteFactEntities.run(factId)
    this.db.prepare('DELETE FROM facts WHERE fact_id = ?').run(factId)
    this.cleanOrphanEntities()
    return true
  }

  /** 浏览事实（按信任评分排序） */
  listFacts(category?: FactCategory, minTrust = 0.0, limit = 50): Fact[] {
    const params: unknown[] = [minTrust]
    let categoryClause = ''
    if (category) {
      categoryClause = 'AND category = ?'
      params.push(category)
    }
    params.push(limit)

    const sql = `
      SELECT fact_id, content, category, tags, keywords, trust_score,
             retrieval_count, helpful_count, created_at, updated_at
      FROM facts
      WHERE trust_score >= ?
        ${categoryClause}
      ORDER BY trust_score DESC
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(...params) as FactRow[]
    return rows.map(r => this.rowToFact(r))
  }

  /** 记录反馈，调整信任评分 */
  recordFeedback(factId: number, helpful: boolean): { oldTrust: number; newTrust: number; helpfulCount: number } {
    const row = this.db.prepare(
      'SELECT fact_id, trust_score, helpful_count FROM facts WHERE fact_id = ?'
    ).get(factId) as (Pick<FactRow, 'fact_id' | 'trust_score' | 'helpful_count'>) | null
    if (!row) throw new Error(`fact_id ${factId} not found`)

    const oldTrust = row.trust_score
    const delta = helpful ? HELPFUL_DELTA : UNHELPFUL_DELTA
    const newTrust = clampTrust(oldTrust + delta)
    const helpfulIncrement = helpful ? 1 : 0

    this.db.prepare(`
      UPDATE facts
      SET trust_score = ?, helpful_count = helpful_count + ?, updated_at = datetime('now', 'localtime')
      WHERE fact_id = ?
    `).run(newTrust, helpfulIncrement, factId)

    return {
      oldTrust,
      newTrust,
      helpfulCount: row.helpful_count + helpfulIncrement,
    }
  }

  /** 按实体名查询关联事实 */
  getFactsByEntity(entityName: string, category?: FactCategory, limit = 10): Fact[] {
    const params: unknown[] = [entityName]
    let categoryClause = ''
    if (category) {
      categoryClause = 'AND f.category = ?'
      params.push(category)
    }
    params.push(limit)

    const sql = `
      SELECT f.fact_id, f.content, f.category, f.tags, f.keywords, f.trust_score,
             f.retrieval_count, f.helpful_count, f.created_at, f.updated_at
      FROM facts f
      JOIN fact_entities fe ON f.fact_id = fe.fact_id
      JOIN entities e ON fe.entity_id = e.entity_id
      WHERE e.name LIKE ?
        ${categoryClause}
      ORDER BY f.trust_score DESC
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(...params) as FactRow[]
    return rows.map(r => this.rowToFact(r))
  }

  /** 按多实体 AND 查询（同时关联多个实体的事实） */
  getFactsByEntities(entities: string[], category?: FactCategory, limit = 10): Fact[] {
    if (entities.length === 0) return []

    // 构建 INTERSECT 查询
    const intersects = entities.map(() =>
      `SELECT fe.fact_id FROM fact_entities fe
       JOIN entities e ON fe.entity_id = e.entity_id
       WHERE e.name LIKE ?`
    ).join(' INTERSECT ')

    const params: unknown[] = [...entities]
    let categoryClause = ''
    if (category) {
      categoryClause = 'AND f.category = ?'
      params.push(category)
    }
    params.push(limit)

    const sql = `
      SELECT f.fact_id, f.content, f.category, f.tags, f.keywords, f.trust_score,
             f.retrieval_count, f.helpful_count, f.created_at, f.updated_at
      FROM facts f
      WHERE f.fact_id IN (${intersects})
        ${categoryClause}
      ORDER BY f.trust_score DESC
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(...params) as FactRow[]
    return rows.map(r => this.rowToFact(r))
  }

  /** 获取事实关联的实体名列表 */
  getEntitiesForFact(factId: number): string[] {
    const rows = this.stmtGetEntitiesForFact.all(factId) as Pick<EntityRow, 'name'>[]
    return rows.map(r => r.name)
  }

  /**
   * 信任衰减：按 category 宽限期 + 衰减率处理过期事实。
   * 超过宽限期的事实，trust_score 每周衰减 decayPerWeek。
   * trust_score < MIN_SURVIVAL_TRUST 的自动删除。
   * @returns { decayed: number, removed: number }
   */
  decayTrustScores(): { decayed: number; removed: number } {
    const now = Date.now()
    const rows = this.db.prepare(
      'SELECT fact_id, category, trust_score, updated_at FROM facts'
    ).all() as Array<{ fact_id: number; category: string; trust_score: number; updated_at: string }>

    let decayed = 0
    let removed = 0

    for (const row of rows) {
      const config = DECAY_CONFIG[row.category] ?? DEFAULT_DECAY
      const updatedDate = new Date(row.updated_at + 'Z')
      const ageDays = (now - updatedDate.getTime()) / 86_400_000

      if (ageDays <= config.graceDays) continue

      const decayWeeks = (ageDays - config.graceDays) / 7
      const newTrust = clampTrust(row.trust_score - config.decayPerWeek * decayWeeks)

      if (newTrust <= MIN_SURVIVAL_TRUST) {
        this.removeFact(row.fact_id)
        removed++
      } else if (newTrust < row.trust_score) {
        this.db.prepare('UPDATE facts SET trust_score = ? WHERE fact_id = ?').run(newTrust, row.fact_id)
        decayed++
      }
    }

    return { decayed, removed }
  }

  /**
   * 矛盾降权：新事实添加后，查找同 category 中共享实体但内容冲突的旧事实，降低其 trust。
   * 用归一化编辑距离判断冲突：同实体但编辑距离低 = 矛盾/需求变更。
   * @returns 被降权的事实数量
   */
  demoteContradictingFacts(newFactId: number, newContent: string, category: FactCategory): number {
    const entities = this.getEntitiesForFact(newFactId)
    if (entities.length === 0) return 0

    const entityPlaceholders = entities.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT DISTINCT f.fact_id, f.content
      FROM facts f
      JOIN fact_entities fe ON f.fact_id = fe.fact_id
      JOIN entities e ON fe.entity_id = e.entity_id
      WHERE e.name IN (${entityPlaceholders})
        AND f.category = ?
        AND f.fact_id != ?
    `).all(...entities, category, newFactId) as Array<{ fact_id: number; content: string }>

    if (rows.length === 0) return 0

    let demoted = 0
    for (const row of rows) {
      const editSim = this.normalizedEditDistance(newContent, row.content)
      // 同实体 + 编辑距离低 = 矛盾信号（如"用Express"改成"用Fastify"）
      // 编辑距离 0.2~0.5 是矛盾区间；<0.2 完全不同；≥0.5 太相似（已在 findSimilarFact 合并）
      if (editSim >= 0.2 && editSim < 0.5) {
        this.db.prepare(
          'UPDATE facts SET trust_score = MAX(0, trust_score - 0.10) WHERE fact_id = ?'
        ).run(row.fact_id)
        demoted++
      }
    }
    return demoted
  }

  /**
   * 启动时矛盾审计：扫描所有事实对，找到内容冲突的，降权较旧的。
   *
   * 双层扫描：
   * 1. 实体 JOIN（已有逻辑）：捕捉有明确实体重叠的矛盾
   * 2. Jaccard 回退（新增）：捕捉中文事实等实体提取为空的矛盾
   *
   * 每次 session 启动必然执行，不依赖写入触发。
   * @returns { audited: number, demoted: number }
   */
  auditContradictions(): { audited: number; demoted: number } {
    let demoted = 0
    const alreadyDemoted = new Set<number>()

    // -- 层 1: 实体 JOIN 矛盾检测（原有逻辑） --
    const rows = this.db.prepare(`
      SELECT f1.fact_id as id1, f1.content as c1, f1.updated_at as t1,
             f2.fact_id as id2, f2.content as c2, f2.updated_at as t2
      FROM facts f1
      JOIN fact_entities fe1 ON f1.fact_id = fe1.fact_id
      JOIN entities e ON fe1.entity_id = e.entity_id
      JOIN fact_entities fe2 ON e.entity_id = fe2.entity_id
      JOIN facts f2 ON fe2.fact_id = f2.fact_id
      WHERE f1.fact_id < f2.fact_id
        AND f1.category = f2.category
        AND f1.trust_score >= 0.2
        AND f2.trust_score >= 0.2
      GROUP BY f1.fact_id, f2.fact_id
    `).all() as Array<{ id1: number; c1: string; t1: string; id2: number; c2: string; t2: string }>

    for (const row of rows) {
      const editSim = this.normalizedEditDistance(row.c1, row.c2)
      if (editSim >= 0.2 && editSim < 0.5) {
        const older = row.t1 < row.t2 ? row.id1 : row.id2
        if (!alreadyDemoted.has(older)) {
          this.db.prepare(
            'UPDATE facts SET trust_score = MAX(0, trust_score - 0.10) WHERE fact_id = ?'
          ).run(older)
          alreadyDemoted.add(older)
          demoted++
        }
      }
    }

    // -- 层 2: Jaccard 纯文本矛盾扫描（中文回退，O(n²)，事实数 ≤ 200 时执行） --
    const allFacts = this.listFacts(undefined, 0.2, 200)
    if (allFacts.length <= 200 && allFacts.length >= 2) {
      for (let i = 0; i < allFacts.length; i++) {
        const a = allFacts[i]
        const tokensA = this.tokenizeForDedup(a.content)
        if (tokensA.size < 3) continue

        for (let j = i + 1; j < allFacts.length; j++) {
          const b = allFacts[j]
          // 跳过不同 category（矛盾通常在同一分类内）
          if (a.category !== b.category) continue

          const tokensB = this.tokenizeForDedup(b.content)
          if (tokensB.size < 3) continue

          const sim = this.jaccardSimilarity(tokensA, tokensB)
          // Jaccard 0.45~0.7 视为同主题但表述有差异（矛盾区间）
          // < 0.45 不相关；≥ 0.7 太相似（应在 findSimilarFact 中合并）
          if (sim >= 0.45 && sim < 0.7) {
            const older = a.updatedAt < b.updatedAt ? a.factId : b.factId
            if (!alreadyDemoted.has(older)) {
              this.db.prepare(
                'UPDATE facts SET trust_score = MAX(0, trust_score - 0.10) WHERE fact_id = ?'
              ).run(older)
              alreadyDemoted.add(older)
              demoted++
            }
          }
        }
      }
    }

    return { audited: rows.length, demoted }
  }

  /**
   * 项目活跃续命：重置所有 project category 事实的 updated_at。
   * 用户在本项目启动 ocean = 项目正在开发，project 事实不应衰减。
   * 项目完成后不再启动 = 自然衰减 + 自动清理。
   */
  refreshProjectFacts(): void {
    this.db.prepare(
      `UPDATE facts SET updated_at = datetime('now', 'localtime') WHERE category = 'project'`
    ).run()
  }

  /** 获取事实总数 */
  getTotalCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM facts').get() as { count: number }
    return row.count
  }

  /** 获取数据库连接（供 FactRetriever 直接使用） */
  get connection(): Database.Database {
    return this.db
  }

  /** 去重用分词：英文空格分词 + 中文 bigram */
  private tokenizeForDedup(text: string): Set<string> {
    const tokens = new Set<string>()
    // 英文 token
    for (const word of text.toLowerCase().split(/\s+/)) {
      const cleaned = word.replace(/[.,;:!?"'(){}[\]#@<>]/g, '')
      if (cleaned && cleaned.length > 1) tokens.add(cleaned)
    }
    // 中文 bigram
    const cnChars = text.match(/[\u4e00-\u9fff]+/g) ?? []
    for (const segment of cnChars) {
      for (let i = 0; i < segment.length - 1; i++) {
        tokens.add(segment.slice(i, i + 2))
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

  /** 包含率：短文本的 token 在长文本中出现的比例（双向取 max） */
  private containmentScore(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0
    // a 包含在 b 中的比例
    let aInB = 0
    for (const item of a) if (b.has(item)) aInB++
    const scoreA = aInB / a.size
    // b 包含在 a 中的比例
    let bInA = 0
    for (const item of b) if (a.has(item)) bInA++
    const scoreB = bInA / b.size
    return Math.max(scoreA, scoreB)
  }

  /** 将中文 bigram 追加到 tags，让 FTS5 能检索中文词组 */
  private enhanceTagsForChinese(content: string, tags: string): string {
    const bigrams: string[] = []
    const cnChars = content.match(/[\u4e00-\u9fff]+/g) ?? []
    for (const segment of cnChars) {
      for (let i = 0; i < segment.length - 1; i++) {
        const bg = segment.slice(i, i + 2)
        if (!CN_STOP_WORDS.has(bg)) {
          bigrams.push(bg)
        }
      }
    }
    if (bigrams.length === 0) return tags
    const existingTags = tags ? tags + ',' : ''
    return existingTags + bigrams.join(',')
  }

  /** 实体类型分类 */
  private classifyEntity(name: string): string {
    // 含英文 → technology
    if (/[A-Za-z]/.test(name)) return 'technology'
    // 中文 3-4 字常见人名模式 → person（2字太容易误判）
    if (/^[\u4e00-\u9fff]{3,4}$/.test(name)) return 'person'
    // 中文 5+ 字 → topic
    if (/^[\u4e00-\u9fff·]{5,}$/.test(name)) return 'topic'
    // 2字中文 → topic（如"模型"、"架构"等技术术语）
    if (/^[\u4e00-\u9fff]{2}$/.test(name)) return 'topic'
    return 'unknown'
  }

  /** 清理没有关联任何事实的孤立实体 */
  private cleanOrphanEntities(): void {
    this.db.prepare(`
      DELETE FROM entities WHERE entity_id NOT IN (
        SELECT DISTINCT entity_id FROM fact_entities
      )
    `).run()
  }

  close(): void {
    this.db.close()
  }

  // ------------------------------------------------------------------
  // 内部方法
  // ------------------------------------------------------------------

  private resolveEntity(name: string): number {
    // 精确名称匹配
    const byName = this.stmtFindEntityByName.get(name) as Pick<EntityRow, 'entity_id'> | null
    if (byName) return byName.entity_id

    // 别名匹配
    const byAlias = this.stmtFindEntityByAlias.get(name) as Pick<EntityRow, 'entity_id'> | null
    if (byAlias) return byAlias.entity_id

    // 创建新实体，自动填充 entity_type
    const entityType = this.classifyEntity(name)
    const info = this.db.prepare(
      'INSERT INTO entities (name, entity_type) VALUES (?, ?)'
    ).run(name, entityType)
    return Number(info.lastInsertRowid)
  }

  private extractEntities(text: string): string[] {
    const seen = new Set<string>()
    const result: string[] = []

    const add = (name: string): void => {
      const stripped = name.trim()
      // 实体验证：拒绝包含句子级标点的碎片
      const CN_PUNCT = /[、，。！？；：,…—（）《》【】""''「」\n\r\t]/
      if (stripped
          && stripped.length >= 2 && stripped.length <= 30
          && !seen.has(stripped.toLowerCase())
          && !CN_PUNCT.test(stripped)) {
        seen.add(stripped.toLowerCase())
        result.push(stripped)
      }
    }

    // 英文实体
    for (const m of text.matchAll(RE_CAPITALIZED)) add(m[1])
    for (const m of text.matchAll(RE_DOUBLE_QUOTE)) add(m[1])
    for (const m of text.matchAll(RE_SINGLE_QUOTE)) add(m[1])
    for (const m of text.matchAll(RE_AKA)) { add(m[1]); add(m[2]) }

    // 中文实体：引号包裹
    for (const m of text.matchAll(RE_CN_QUOTED)) add(m[1])
    // 中文实体：书名号
    for (const m of text.matchAll(RE_CN_BOOK)) add(m[1])

    // 中文实体：常见声明模式（"我叫XXX"、"项目叫XXX"、"名字是XXX"）
    const CN_NAME_DECL = /(?:我叫|叫|名字是|名称是|名叫|叫做)([^\s,，。！？；：]{2,10})/gi
    for (const m of text.matchAll(CN_NAME_DECL)) {
      const v = m[1].trim()
      if (v.length >= 2 && v.length <= 8) add(v)
    }

    // 注意：bigram 分词只用于 FTS5 tags 索引（enhanceTagsForChinese），
    // 不作为实体存储。实体提取只取引号/书名号/声明模式中的明确实体。

    return result
  }

  private rowToFact(row: FactRow): Fact {
    return {
      factId: row.fact_id,
      content: row.content,
      category: row.category as FactCategory,
      tags: row.tags,
      keywords: row.keywords,
      trustScore: row.trust_score,
      retrievalCount: row.retrieval_count,
      helpfulCount: row.helpful_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
