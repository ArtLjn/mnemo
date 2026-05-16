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
    return 0
  }

  async smartReclassify(): Promise<number> {
    return 0
  }
}
