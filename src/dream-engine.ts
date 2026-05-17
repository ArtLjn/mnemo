import type { FactCategory, LLMMessage } from './types.js'
import type { LLMClient } from './llm-client.js'
import type { MemoryStore } from './store.js'

const BATCH_SIZE = 10
const MAX_DELETE_RATIO = 0.1
const TRUST_DELETE_LIMIT = 0.8
const RETRIEVAL_DELETE_LIMIT = 100
const MAX_COMPRESS_CHARS = 2000

export class DreamEngine {
  constructor(private llm: LLMClient, private store: MemoryStore) {}

  private log(msg: string) {
    console.log(`[dream] ${msg}`)
  }

  /**
   * 批次队列处理：失败时自动拆半重试。
   * 初始按 batchSize 分批，某批失败则拆成两半重新入队，
   * 直到单条也失败才跳过。适配任意模型的 token 限制。
   */
  private async processQueue<I>(
    items: I[],
    batchSize: number,
    processFn: (batch: I[]) => Promise<void>,
    context: string,
  ): Promise<void> {
    const queue: I[][] = []
    for (let i = 0; i < items.length; i += batchSize) {
      queue.push(items.slice(i, i + batchSize))
    }

    while (queue.length > 0) {
      const batch = queue.shift()!
      try {
        await processFn(batch)
      } catch (e) {
        if (batch.length <= 1) {
          this.log(`${context} 单条处理失败，跳过: ${(e as Error).message?.slice(0, 80)}`)
          continue
        }
        const mid = Math.ceil(batch.length / 2)
        this.log(`${context} 批次(${batch.length}条)失败，拆半重试`)
        queue.unshift(batch.slice(0, mid))
        queue.unshift(batch.slice(mid))
      }
    }
  }

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

      await this.processQueue(
        facts,
        BATCH_SIZE,
        async (batch) => {
          this.log(`[${cat}] 分析 ${batch.length} 条...`)
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

          const result = await this.llm.chatJSON<{ merges: Array<{ kept: number | string; removed: number | string; merged_content?: string; reason: string }> }>(messages)
          if (!result?.merges || !Array.isArray(result.merges)) return

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
        },
        `[${cat}]`,
      )
    }

    this.log(`语义合并完成: ${merged} 条合并`)
    return { merged, details }
  }

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

    await this.processQueue(
      rows,
      BATCH_SIZE,
      async (batch) => {
        this.log(`精简 ${batch.length} 条...`)
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

        const result = await this.llm.chatJSON<{ compressions: Array<{ fact_id: number; content: string }> }>(messages)
        if (!result?.compressions || !Array.isArray(result.compressions)) return

        for (const item of result.compressions) {
          if (!item.fact_id || !item.content) continue
          this.store.connection.prepare(
            "UPDATE facts SET content = ?, updated_at = datetime('now', 'localtime') WHERE fact_id = ?"
          ).run(item.content, item.fact_id)
          compressed++
        }
        this.log(`本批精简 ${result.compressions.length} 条`)
      },
      '精简',
    )

    this.log(`智能精简完成: ${compressed} 条`)
    return compressed
  }
}
