import type { FactCategory, LLMMessage } from './types.js'
import type { LLMClient } from './llm-client.js'
import type { MemoryStore } from './store.js'

const BATCH_SIZE = 20
const MAX_DELETE_RATIO = 0.1
const TRUST_DELETE_LIMIT = 0.8
const RETRIEVAL_DELETE_LIMIT = 100

export class DreamEngine {
  constructor(private llm: LLMClient, private store: MemoryStore) {}

  async semanticMerge(): Promise<{
    merged: number
    details: Array<{ kept: number; removed: number; reason: string }>
  }> {
    const categories: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
    let merged = 0
    const details: Array<{ kept: number; removed: number; reason: string }> = []

    const totalFacts = this.store.getTotalCount()
    const maxDeletes = Math.max(1, Math.floor(totalFacts * MAX_DELETE_RATIO))

    for (const cat of categories) {
      const facts = this.store.listFacts(cat, 0, 200)
      if (facts.length < 2) continue

      for (let i = 0; i < facts.length; i += BATCH_SIZE) {
        const batch = facts.slice(i, i + BATCH_SIZE)
        const factList = batch.map(f => `[${f.factId}] ${f.content}`).join('\n')

        const messages: LLMMessage[] = [
          {
            role: 'system',
            content: `你是一个记忆整理助手。分析以下同一分类(${cat})的记忆条目，找出语义重复的条目对。
只输出JSON，格式：{"merges": [{"kept": 保留的fact_id, "removed": 删除的fact_id, "reason": "原因"}]}
如果没有语义重复的条目，输出：{"merges": []}
规则：
- 保留内容更完整、信息量更大的条目
- 用词不同但意思相同的条目应合并（如"喜欢VS Code"和"偏好Visual Studio Code"）
- 不要合并只是主题相关但内容不同的条目`,
          },
          { role: 'user', content: factList },
        ]

        try {
          const result = await this.llm.chatJSON<{ merges: Array<{ kept: number; removed: number; reason: string }> }>(messages)
          if (!result?.merges || !Array.isArray(result.merges)) continue

          for (const merge of result.merges) {
            if (merged >= maxDeletes) break
            if (!merge.kept || !merge.removed) continue

            const toRemove = this.store.listFacts(cat, 0, 200).find(f => f.factId === merge.removed)
            if (!toRemove) continue
            if (toRemove.trustScore > TRUST_DELETE_LIMIT) continue
            if (toRemove.retrievalCount > RETRIEVAL_DELETE_LIMIT) continue

            const toKeep = this.store.listFacts(cat, 0, 200).find(f => f.factId === merge.kept)
            if (!toKeep) continue

            this.store.removeFact(merge.removed)
            details.push({ kept: merge.kept, removed: merge.removed, reason: merge.reason })
            merged++
          }
        } catch {
          continue
        }
      }
    }

    return { merged, details }
  }

  async smartCompress(): Promise<number> {
    const rows = this.store.connection.prepare(
      "SELECT fact_id, content FROM facts WHERE length(content) > 200 AND (summary IS NULL OR summary = '')"
    ).all() as Array<{ fact_id: number; content: string }>

    if (rows.length === 0) return 0

    let compressed = 0

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const factList = batch.map(f => `[${f.fact_id}] ${f.content}`).join('\n\n---\n\n')

      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `你是一个记忆摘要助手。为每条记忆生成简洁的摘要（≤150字）。
摘要应保留核心信息：谁/什么/关键决策/关键数据。去除示例、过程描述、冗余细节。
输出JSON：{"summaries": [{"fact_id": 数字, "summary": "摘要内容"}]}`,
        },
        { role: 'user', content: factList },
      ]

      try {
        const result = await this.llm.chatJSON<{ summaries: Array<{ fact_id: number; summary: string }> }>(messages)
        if (!result?.summaries || !Array.isArray(result.summaries)) continue

        for (const item of result.summaries) {
          if (!item.fact_id || !item.summary) continue
          const truncated = item.summary.length > 150 ? item.summary.slice(0, 147) + '...' : item.summary
          this.store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run(truncated, item.fact_id)
          compressed++
        }
      } catch {
        continue
      }
    }

    return compressed
  }

  async smartReclassify(): Promise<number> {
    const rows = this.store.connection.prepare(
      "SELECT fact_id, content FROM facts WHERE category = 'general'"
    ).all() as Array<{ fact_id: number; content: string }>

    if (rows.length === 0) return 0

    const validCategories = ['identity', 'coding_style', 'tool_pref', 'workflow']
    let reclassified = 0

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const factList = batch.map(f => `[${f.fact_id}] ${f.content}`).join('\n')

      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `你是一个记忆分类助手。分析以下记忆条目，判断它们应该属于哪个分类。
可选分类：identity（身份/角色）、coding_style（编码规范）、tool_pref（工具偏好）、workflow（工作流）
如果记忆不属于以上任何分类，保持 general。
输出JSON：{"reclassify": [{"fact_id": 数字, "to": "分类名"}]}
不需要重新分类的条目不要输出。`,
        },
        { role: 'user', content: factList },
      ]

      try {
        const result = await this.llm.chatJSON<{ reclassify: Array<{ fact_id: number; to: string }> }>(messages)
        if (!result?.reclassify || !Array.isArray(result.reclassify)) continue

        for (const item of result.reclassify) {
          if (!item.fact_id || !item.to) continue
          if (!validCategories.includes(item.to)) continue

          this.store.connection.prepare(
            "UPDATE facts SET category = ?, updated_at = datetime('now', 'localtime') WHERE fact_id = ?"
          ).run(item.to, item.fact_id)
          reclassified++
        }
      } catch {
        continue
      }
    }

    return reclassified
  }
}
