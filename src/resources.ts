/**
 * MCP Resource manager for mnemo-mcp.
 * Exposes per-category memory summaries as MCP Resources for session warmup injection.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MemoryStore } from './store.js'
import type { FactCategory } from './types.js'

const CATEGORIES: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
const RESOURCE_LIMIT = 10

export interface ResourceFact {
  fact_id: number
  content: string
  trust_score: number
}

export class ResourceManager {
  private cache = new Map<FactCategory, ResourceFact[]>()

  constructor(
    private store: MemoryStore,
  ) {}

  /** Register all category resources with the MCP server */
  registerResources(server: McpServer): void {
    for (const category of CATEGORIES) {
      const uri = `mnemo://global/${category}`
      server.registerResource(
        `mnemo-global-${category}`,
        uri,
        {
          description: `${category} category global facts (top ${RESOURCE_LIMIT} by trust)`,
          mimeType: 'application/json',
        },
        async () => this.readCategory(category),
      )
    }
  }

  /** Read handler for a specific category */
  private readCategory(category: FactCategory): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
    const facts = this.getFacts(category)
    return {
      contents: [{
        uri: `mnemo://global/${category}`,
        mimeType: 'application/json',
        text: JSON.stringify(facts, null, 2),
      }],
    }
  }

  /** Get facts for a category — with caching */
  getFacts(category: FactCategory): ResourceFact[] {
    const cached = this.cache.get(category)
    if (cached) return cached

    const facts = this.store.listFacts(category, 0.0, RESOURCE_LIMIT).map(f => ({
      fact_id: f.factId,
      content: f.content,
      trust_score: f.trustScore,
    }))

    this.cache.set(category, facts)
    return facts
  }

  /** Invalidate all caches — call after any write operation */
  invalidate(): void {
    this.cache.clear()
  }

  /** Get cache entry count for debugging */
  cacheSize(): number {
    return this.cache.size
  }
}
