/**
 * Performance metrics for mnemo-mcp.
 * Tracks query timing, cache hit/miss, and retrieval paths.
 * Only active when MNEMO_DEBUG=1.
 */

export interface QueryMetrics {
  action: string
  durationMs: number
  resultCount: number
  cacheHit: boolean
  retrievalPath?: string
}

export class PerfMetrics {
  private enabled: boolean
  private totalQueries = 0
  private cacheHits = 0
  private cacheMisses = 0
  private totalMissTimeMs = 0

  constructor() {
    this.enabled = process.env.MNEMO_DEBUG === '1'
  }

  isEnabled(): boolean {
    return this.enabled
  }

  record(metrics: QueryMetrics): void {
    if (!this.enabled) return

    this.totalQueries++
    if (metrics.cacheHit) {
      this.cacheHits++
    } else {
      this.cacheMisses++
      this.totalMissTimeMs += metrics.durationMs
    }

    const hitRatio = this.totalQueries > 0 ? (this.cacheHits / this.totalQueries * 100).toFixed(1) : '0.0'
    const path = metrics.retrievalPath ? ` [${metrics.retrievalPath}]` : ''
    console.error(
      `[mnemo:debug] ${metrics.action} | ${metrics.cacheHit ? 'HIT' : 'MISS'} | ` +
      `${metrics.durationMs.toFixed(2)}ms | ${metrics.resultCount} results | ` +
      `hit_ratio=${hitRatio}%${path}`
    )
  }

  getStats(): {
    totalQueries: number
    cacheHits: number
    cacheMisses: number
    hitRatio: number
    avgQueryTime: number
    totalTimeSaved: number
  } {
    const hitRatio = this.totalQueries > 0 ? this.cacheHits / this.totalQueries : 0
    const avgQueryTime = this.cacheMisses > 0 ? this.totalMissTimeMs / this.cacheMisses : 0
    const totalTimeSaved = this.cacheHits * avgQueryTime

    return {
      totalQueries: this.totalQueries,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRatio,
      avgQueryTime,
      totalTimeSaved,
    }
  }

  logStats(): void {
    if (!this.enabled) return
    const stats = this.getStats()
    console.error(
      `[mnemo:debug] stats | total=${stats.totalQueries} hits=${stats.cacheHits} ` +
      `misses=${stats.cacheMisses} hit_ratio=${(stats.hitRatio * 100).toFixed(1)}% ` +
      `avg_time=${stats.avgQueryTime.toFixed(2)}ms saved=${stats.totalTimeSaved.toFixed(2)}ms`
    )
  }
}
