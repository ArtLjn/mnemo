/**
 * Query result cache for mnemo-mcp.
 * Process-local Map with TTL. Cleared on write operations.
 */

import type { ScoredFact } from './types.js'

interface CacheEntry {
  results: ScoredFact[]
  timestamp: number
}

const DEFAULT_TTL_MS = 60_000

export class QueryCache {
  private cache = new Map<string, CacheEntry>()
  private ttlMs: number

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  makeKey(params: {
    action: string
    query?: string
    entity?: string
    entities?: string[]
    category?: string
    minTrust?: number
    limit?: number
  }): string {
    const parts = [
      params.action,
      params.query ?? '',
      params.entity ?? '',
      params.entities?.join(',') ?? '',
      params.category ?? '',
      String(params.minTrust ?? ''),
      String(params.limit ?? ''),
    ]
    return parts.join('|')
  }

  get(key: string): ScoredFact[] | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      return null
    }
    return entry.results
  }

  set(key: string, results: ScoredFact[]): void {
    this.cache.set(key, { results, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}
