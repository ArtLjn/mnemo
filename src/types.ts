/** 事实分类 */
export type FactCategory = 'identity' | 'coding_style' | 'tool_pref' | 'workflow' | 'general'

/** 存储的事实记录 */
export interface Fact {
  factId: number
  content: string
  category: FactCategory
  tags: string
  keywords: string
  summary: string | null
  trustScore: number
  retrievalCount: number
  helpfulCount: number
  lastRetrievedAt: string | null
  createdAt: string
  updatedAt: string
}

/** 带评分的检索结果 */
export interface ScoredFact extends Fact {
  score: number
}

/** 矛盾检测结果 */
export interface Contradiction {
  factA: Omit<Fact, never>
  factB: Omit<Fact, never>
  entityOverlap: number
  contentSimilarity: number
  contradictionScore: number
  sharedEntities: string[]
}

/** 检索选项 */
export interface SearchOptions {
  category?: FactCategory
  minTrust?: number
  limit?: number
}

/** 矛盾检测选项 */
export interface ContradictOptions {
  category?: FactCategory
  threshold?: number
  limit?: number
}

/** 检索器配置 */
export interface RetrieverOptions {
  ftsWeight?: number
  jaccardWeight?: number
  temporalDecayHalfLife?: number
}

/** fact_store 工具调用参数 */
export interface FactStoreArgs {
  action: 'add' | 'search' | 'probe' | 'related' | 'reason' | 'contradict' | 'update' | 'remove' | 'list' | 'learn' | 'audit'
  content?: string | string[]
  query?: string
  entity?: string
  entities?: string[]
  fact_id?: number | number[]
  category?: string
  tags?: string
  summary?: string
  trust_delta?: number
  min_trust?: number
  limit?: number
}

/** fact_feedback 工具调用参数 */
export interface FactFeedbackArgs {
  action: 'helpful' | 'unhelpful'
  fact_id: number
}

/** 安全扫描结果 */
export interface SecurityScanResult {
  safe: boolean
  warnings: string[]
  hasPii: boolean
  injectionAttempts: string[]
}
