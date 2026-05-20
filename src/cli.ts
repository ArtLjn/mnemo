#!/usr/bin/env node

import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { MemoryStore } from './store.js'
import { FactRetriever } from './retriever.js'
import { scanContentQuality } from './security.js'
import type { FactCategory } from './types.js'

const dbPath = process.env.MNEMO_DB_PATH ?? join(homedir(), '.mnemo', 'facts.db')
const invalidateFilePath = process.env.MNEMO_INVALIDATE_PATH ?? join(homedir(), '.mnemo', '.cache-invalidate')

function touchInvalidateFile(): void {
  try {
    writeFileSync(invalidateFilePath, Date.now().toString())
  } catch {
    // 忽略写入失败
  }
}

function resolveCategory(category?: string): FactCategory {
  if (!category) return 'workflow'
  const valid: FactCategory[] = ['identity', 'coding_style', 'tool_pref', 'workflow', 'general']
  return valid.includes(category as FactCategory) ? (category as FactCategory) : 'workflow'
}

function printResult(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

function printError(message: string): void {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1]
  }
  return undefined
}

// -- Commands --

function cmdObserve(args: string[]): void {
  const content = args[0]
  if (!content) printError('Usage: mnemo observe <content> [--category <cat>] [--tags <tags>]')

  const category = resolveCategory(parseFlag(args, '--category'))
  const tags = parseFlag(args, '--tags') ?? ''

  const quality = scanContentQuality(content)
  if (!quality.passed) {
    printResult({ saved: false, reason: quality.issues.join('; ') })
    return
  }

  const store = new MemoryStore(dbPath)
  try {
    const similar = store.findSimilarFact(content, category) ?? store.findSimilarFact(content)
    if (similar) {
      store.updateFact(similar.factId, { content, tags, trustDelta: 0.05 })
      store.demoteContradictingFacts(similar.factId, content, category)
      touchInvalidateFile()
      printResult({ saved: true, fact_id: similar.factId, status: 'updated', reason: 'similar_fact_merged' })
    } else {
      const factId = store.addFactWithTrust(content, category, tags, 0.3)
      store.demoteContradictingFacts(factId, content, category)
      touchInvalidateFile()
      printResult({ saved: true, fact_id: factId, category, trust: 0.3 })
    }
  } finally {
    store.close()
  }
}

function cmdSearch(args: string[]): void {
  const query = args[0]
  if (!query) printError('Usage: mnemo search <query> [--category <cat>] [--min-trust <n>] [--limit <n>]')

  const category = parseFlag(args, '--category') ?? undefined
  const minTrust = parseFloat(parseFlag(args, '--min-trust') ?? '0.3')
  const limit = parseInt(parseFlag(args, '--limit') ?? '10', 10)

  const store = new MemoryStore(dbPath)
  const retriever = new FactRetriever(store)
  try {
    const results = retriever.search(query, {
      category: category ? resolveCategory(category) : undefined,
      minTrust,
      limit,
    })
    printResult({
      results: results.map(r => ({
        fact_id: r.factId,
        content: r.content,
        category: r.category,
        trust_score: Math.round(r.trustScore * 100) / 100,
        score: Math.round(r.score * 1000) / 1000,
      })),
      count: results.length,
    })
  } finally {
    store.close()
  }
}

function cmdFeedback(args: string[]): void {
  const factId = parseInt(args[0], 10)
  const action = args[1]
  if (isNaN(factId) || !action || !['helpful', 'unhelpful'].includes(action)) {
    printError('Usage: mnemo feedback <fact_id> <helpful|unhelpful>')
  }

  const store = new MemoryStore(dbPath)
  try {
    const result = store.recordFeedback(factId, action === 'helpful')
    touchInvalidateFile()
    printResult({ updated: true, fact_id: factId, old_trust: result.oldTrust, new_trust: result.newTrust })
  } finally {
    store.close()
  }
}

function cmdReview(args: string[]): void {
  const store = new MemoryStore(dbPath)
  try {
    const audit = store.runAudit()
    store.auditContradictions()
    printResult({
      total_facts: audit.total_facts,
      long_without_summary: audit.long_without_summary,
      low_helpful_rate: audit.low_helpful_rate,
      aging_candidates: audit.aging_candidates,
    })
  } finally {
    store.close()
  }
}

// -- Main --

function main(): void {
  const [, , command, ...args] = process.argv

  switch (command) {
    case 'observe':
      cmdObserve(args)
      break
    case 'search':
      cmdSearch(args)
      break
    case 'feedback':
      cmdFeedback(args)
      break
    case 'review':
      cmdReview(args)
      break
    default:
      console.log(`Usage: mnemo <command> [args...]

Commands:
  observe <content>     Save a fact (default category: workflow)
  search <query>        Search facts by keyword
  feedback <id> <type>  Rate a fact as helpful or unhelpful
  review                Show audit report of memory health

Options:
  --category <cat>      Filter by category (identity, coding_style, tool_pref, workflow, general)
  --tags <tags>         Comma-separated tags for observe
  --min-trust <n>       Minimum trust score for search (default: 0.3)
  --limit <n>           Max results for search (default: 10)
`)
      process.exit(command ? 1 : 0)
  }
}

main()
