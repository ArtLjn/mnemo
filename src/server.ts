#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod/v4'
import { MemoryStore } from './store.js'
import { FactRetriever } from './retriever.js'
import { ResourceManager } from './resources.js'
import { fullSecurityScan, scanContentQuality } from './security.js'
import type { FactStoreArgs, FactFeedbackArgs, FactCategory, ScoredFact, CompactFactResult } from './types.js'

const FACT_STORE_DESCRIPTION = `结构化事实记忆系统（SQLite+FTS5 索引）。支持读写。

操作：
- search — 关键词查找
- probe — 实体探测：关于某人/某事的所有事实
- related — 实体关联
- reason — 组合推理：同时关联多个实体的事实
- contradict — 矛盾检测
- list — 浏览事实
- add — 添加新事实（自动去重，相似则更新，单条 ≤300 字）
- update — 更新已有事实
- remove — 删除事实
- auto_observe — 自动保存工作流/偏好记忆（AI 完成任务后调用，trust=0.3 起步）
- cleanup — 扫描超长 fact 报告

写入时先 search 检查是否已存在相似事实。单条 content 不超过 300 字，聚焦一个主题。`

const factStoreSchema = {
  action: z.enum(['add', 'search', 'probe', 'related', 'reason', 'contradict', 'update', 'remove', 'list', 'learn', 'audit', 'dream', 'cleanup', 'auto_observe']),
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

const factFeedbackSchema = {
  action: z.enum(['helpful', 'unhelpful']),
  fact_id: z.number().describe('要评分的事实 ID'),
}

function resolveCategory(category?: string): FactCategory {
  if (!category) return 'general'
  const valid: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
  return valid.includes(category as FactCategory) ? (category as FactCategory) : 'general'
}

function toCompactResult(f: ScoredFact): CompactFactResult {
  return {
    factId: f.factId,
    display: f.content,
    category: f.category,
    trustScore: Math.round(f.trustScore * 100) / 100,
    score: Math.round(f.score * 1000) / 1000,
  }
}

const minTrust = 0.3

// -- Initialize store + retriever --
const dbPath = join(homedir(), '.mnemo', 'facts.db')
const store = new MemoryStore(dbPath)
const retriever = new FactRetriever(store, { temporalDecayHalfLife: 30 })

// Startup maintenance
store.decayTrustScores()
store.auditContradictions()

// Auto-learn on startup (non-blocking)
process.nextTick(() => {
  try {
    const result = store.runLearning()
    if (result.demoted > 0 || result.aged > 0 || result.removed > 0 || result.long_facts.length > 0) {
      console.error(`[mnemo:auto-learn] promoted=${result.promoted} demoted=${result.demoted} aged=${result.aged} removed=${result.removed} long_facts=${result.long_facts.length}`)
    }
  } catch (err) {
    console.error('[mnemo:auto-learn] error:', err)
  }
})

// -- MCP Server --
// 动态生成 instructions：将 identity resource 中的角色设定作为 system prompt 指令注入
function buildInstructions(): string {
  try {
    const rm = new ResourceManager(store)
    const result = rm.readCategory('identity')
    const identityText = result.contents[0]?.text ?? ''
    if (identityText.length > 10) {
      return identityText
    }
  } catch {
    // fallback：无 identity 数据时不注入
  }
  return ''
}

const server = new McpServer(
  { name: 'mnemo-mcp', version: '0.1.0' },
  { instructions: buildInstructions() },
)

// -- MCP Resources: 会话预热注入 --
const resourceManager = new ResourceManager(store)
resourceManager.registerResources(server)

server.tool(
  'fact_store',
  FACT_STORE_DESCRIPTION,
  factStoreSchema,
  async (args) => {
    try {
      const a = args as unknown as FactStoreArgs
      const category = resolveCategory(a.category)

      switch (a.action) {
        case 'add': {
          if (!a.content) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: content' }) }] }
          const contents = Array.isArray(a.content) ? a.content : [a.content]
          const results: Array<{ fact_id: number; status: string; reason?: string; category?: string; contradicted_demoted?: number; warnings?: string[] }> = []

          for (const content of contents) {
            if (!content || !content.trim()) {
              results.push({ fact_id: -1, status: 'error', reason: 'empty content' })
              continue
            }
            const quality = scanContentQuality(content.trim())
            if (!quality.passed) {
              results.push({ fact_id: -1, status: 'error', reason: quality.issues.join('; ') })
              continue
            }
            const similar = store.findSimilarFact(content, category) ?? store.findSimilarFact(content)
            let warnings: string[] | undefined
            const scan = fullSecurityScan(content)
            if (scan.warnings.length > 0 || scan.hasPii) warnings = [...scan.warnings]

            if (similar) {
              store.updateFact(similar.factId, { content, tags: a.tags, trustDelta: 0.05 })
              if (a.summary) {
                store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run(a.summary, similar.factId)
              }
              const demoted = store.demoteContradictingFacts(similar.factId, content, category)
              results.push({ fact_id: similar.factId, status: 'updated', reason: 'similar_fact_merged', ...(demoted > 0 ? { contradicted_demoted: demoted } : {}), ...(warnings ? { warnings } : {}) })
            } else {
              const factId = store.addFact(content, category, a.tags ?? '')
              if (a.summary) {
                store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run(a.summary, factId)
              }
              const demoted = store.demoteContradictingFacts(factId, content, category)
              results.push({ fact_id: factId, status: 'added', category, ...(demoted > 0 ? { contradicted_demoted: demoted } : {}), ...(warnings ? { warnings } : {}) })
            }
          }

          retriever.getCache().clear()
          resourceManager.invalidate()
          const response = Array.isArray(a.content) ? results : results[0]
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
        }

        case 'search': {
          if (!a.query) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: query' }) }] }
          const results = retriever.search(a.query, { category: a.category ? category : undefined, minTrust: a.min_trust ?? minTrust, limit: a.limit ?? 10 })
          const compact = results.map(toCompactResult)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ results: compact, count: compact.length }) }] }
        }

        case 'probe': {
          if (!a.entity) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: entity' }) }] }
          const results = retriever.probe(a.entity, { minTrust: a.min_trust ?? minTrust, limit: a.limit ?? 10 })
          const compact = results.map(toCompactResult)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ results: compact, count: compact.length }) }] }
        }

        case 'related': {
          if (!a.entity) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: entity' }) }] }
          const results = retriever.related(a.entity, { minTrust: a.min_trust ?? minTrust, limit: a.limit ?? 10 })
          const compact = results.map(toCompactResult)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ results: compact, count: compact.length }) }] }
        }

        case 'reason': {
          const entities = a.entities ?? []
          if (entities.length === 0) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "reason requires 'entities' list" }) }] }
          const results = retriever.reason(entities, { minTrust: a.min_trust ?? minTrust, limit: a.limit ?? 10 })
          const compact = results.map(toCompactResult)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ results: compact, count: compact.length }) }] }
        }

        case 'contradict': {
          const results = retriever.contradict({ threshold: 0.3, limit: a.limit ?? 10 })
          return { content: [{ type: 'text' as const, text: JSON.stringify({ results, count: results.length }) }] }
        }

        case 'update': {
          if (!a.fact_id) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: fact_id' }) }] }
          const updated = store.updateFact(a.fact_id as number, { content: a.content as string | undefined, tags: a.tags, category, trustDelta: a.trust_delta })
          if (a.summary !== undefined) {
            store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run(a.summary, a.fact_id as number)
          }
          retriever.getCache().clear()
          resourceManager.invalidate()
          return { content: [{ type: 'text' as const, text: JSON.stringify({ updated }) }] }
        }

        case 'remove': {
          if (!a.fact_id) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: fact_id' }) }] }
          const ids = Array.isArray(a.fact_id) ? a.fact_id : [a.fact_id]
          const results = ids.map(id => ({ fact_id: id, removed: store.removeFact(id) }))
          retriever.getCache().clear()
          resourceManager.invalidate()
          const response = Array.isArray(a.fact_id) ? results : results[0]
          return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
        }

        case 'learn': {
          const result = store.runLearning()
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        }

        case 'audit': {
          const report = store.runAudit()
          return { content: [{ type: 'text' as const, text: JSON.stringify(report) }] }
        }

        case 'dream': {
          const report = await store.runDream()
          retriever.getCache().clear()
          resourceManager.invalidate()
          return { content: [{ type: 'text' as const, text: JSON.stringify(report) }] }
        }

        case 'auto_observe': {
          if (!a.content) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: content' }) }] }
          const observeContent = (Array.isArray(a.content) ? a.content[0] : a.content).trim()
          if (!observeContent) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'empty content' }) }] }

          const quality = scanContentQuality(observeContent)
          if (!quality.passed) return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: false, reason: quality.issues.join('; ') }) }] }

          const similar = store.findSimilarFact(observeContent, category) ?? store.findSimilarFact(observeContent)
          if (similar) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: false, reason: 'similar_exists', fact_id: similar.factId }) }] }
          }

          // AI 传了 category 就用，没传默认 workflow
          const observeCategory = (a.category && category !== 'general') ? category : 'workflow' as FactCategory
          const factId = store.addFactWithTrust(observeContent, observeCategory, a.tags ?? '', 0.3)
          const demoted = store.demoteContradictingFacts(factId, observeContent, observeCategory)

          retriever.getCache().clear()
          resourceManager.invalidate()
          return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: true, fact_id: factId, category: observeCategory, trust: 0.3, contradicted_demoted: demoted }) }] }
        }

        case 'cleanup': {
          const oversized = store.listOversizedFacts(300)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ oversized, count: oversized.length }) }] }
        }

        case 'list': {
          const facts = store.listFacts(category, a.min_trust ?? 0.0, a.limit ?? 10)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ facts, count: facts.length }) }] }
        }

        default:
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown action: ${(a as { action: string }).action}` }) }] }
      }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }] }
    }
  },
)

server.tool(
  'fact_feedback',
  '使用事实后评分。标记 helpful 如果准确，unhelpful 如果过时。训练记忆系统 — 好事实上升，坏事实下降。',
  factFeedbackSchema,
  async (args) => {
    try {
      const a = args as unknown as FactFeedbackArgs
      if (!a.fact_id) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required argument: fact_id' }) }] }
      const result = store.recordFeedback(a.fact_id, a.action === 'helpful')
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }] }
    }
  },
)

// -- Start --
const transport = new StdioServerTransport()
server.connect(transport).catch(err => {
  console.error('mnemo-mcp failed to start:', err)
  process.exit(1)
})
