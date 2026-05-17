/**
 * MCP Resource manager for mnemo-mcp.
 * Exposes per-category memory as MCP Resources for session warmup injection.
 *
 * identity → 指令格式（Claude 应遵循的行为设定）
 * 其他     → 参考格式（供 Claude 查阅的用户偏好）
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MemoryStore } from './store.js'
import type { FactCategory } from './types.js'

const CATEGORIES: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
const RESOURCE_LIMIT = 15

export interface ResourceFact {
  fact_id: number
  content: string
  trust_score: number
}

export class ResourceManager {
  private cache = new Map<FactCategory, string>()

  constructor(
    private store: MemoryStore,
  ) {}

  registerResources(server: McpServer): void {
    for (const category of CATEGORIES) {
      const uri = `mnemo://global/${category}`
      server.registerResource(
        `mnemo-global-${category}`,
        uri,
        {
          description: `${category} category global facts (top ${RESOURCE_LIMIT} by trust)`,
          mimeType: 'text/markdown',
        },
        async () => this.readCategory(category),
      )
    }
  }

  /** Read handler for a specific category (public for server instructions) */
  readCategory(category: FactCategory): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
    const text = this.getFormattedFacts(category)
    return {
      contents: [{
        uri: `mnemo://global/${category}`,
        mimeType: 'text/markdown',
        text,
      }],
    }
  }

  private getFormattedFacts(category: FactCategory): string {
    const cached = this.cache.get(category)
    if (cached) return cached

    const facts = this.store.listFacts(category, 0.0, RESOURCE_LIMIT)
    const text = category === 'identity'
      ? this.formatAsInstructions(facts)
      : this.formatAsReference(facts, category)

    this.cache.set(category, text)
    return text
  }

  /**
   * identity 类事实格式化为指令——Claude 应直接遵循这些设定。
   * 角色设定排在最前面，用祈使句。
   */
  private formatAsInstructions(facts: ReturnType<MemoryStore['listFacts']>): string {
    const lines: string[] = ['# 身份与行为设定', '', '以下是你的身份设定和用户偏好，请直接遵循：', '']

    // 角色/身份相关的 fact 排在最前面
    const roleFacts = facts.filter(f =>
      f.content.includes('角色设定') ||
      f.content.includes('你是') ||
      f.content.includes('身份是') ||
      f.content.includes('你扮演')
    )
    const otherFacts = facts.filter(f => !roleFacts.includes(f))

    if (roleFacts.length > 0) {
      lines.push('## 你的身份')
      for (const f of roleFacts) {
        // 把描述性语句转为指令
        const content = f.content
          .replace(/^AI角色设定[：:]/, '')
          .replace(/^你是/, '')
          .trim()
        lines.push(`- ${content}`)
      }
      lines.push('')
    }

    if (otherFacts.length > 0) {
      lines.push('## 用户信息')
      for (const f of otherFacts) {
        lines.push(`- ${f.content}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 非 identity 类事实格式化为参考——供 Claude 查阅但不强制遵循。
   */
  private formatAsReference(facts: ReturnType<MemoryStore['listFacts']>, category: string): string {
    const title: Record<string, string> = {
      coding_style: '编码风格偏好',
      tool_pref: '工具偏好',
      workflow: '工作流偏好',
      general: '通用知识',
    }
    const lines: string[] = [`# ${title[category] ?? category}`, '']

    for (const f of facts) {
      lines.push(`- ${f.content}`)
    }

    return lines.join('\n')
  }

  invalidate(): void {
    this.cache.clear()
  }

  cacheSize(): number {
    return this.cache.size
  }
}
