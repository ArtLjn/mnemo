/**
 * Query refinement: strip noise tokens from user messages before memory search.
 * Pure function — no side effects, no DB access.
 */

import type { FactCategory } from './types.js'

// Action words / helper phrases to strip (Chinese)
const ACTION_WORDS = [
  '帮我看看', '能不能帮我', '给我看看',
  '帮我', '看看', '看一下', '做一下', '能不能', '为什么', '怎么',
  '是什么', '如何', '请', '麻烦', '可以', '给我',
  '给我做', '给我写', '给我查', '给我找', '给我说', '给我讲',
  '告诉我', '跟我说', '跟我讲', '给我解释', '给我说明', '给我介绍',
  '运行', '执行', '启动', '停止', '创建', '删除', '修改', '更新', '查看',
  '检查', '测试', '提交', '推送', '拉取', '合并', '切换', '重置', '重构',
  '运行测试', '创建文件',
]

// Common CLI commands / low-signal English tokens to filter
const NOISE_WORDS = new Set([
  'git', 'npm', 'npx', 'yarn', 'pnpm', 'status', 'log', 'diff', 'add',
  'commit', 'push', 'pull', 'merge', 'checkout', 'branch', 'stash',
  'install', 'build', 'run', 'start', 'stop', 'test', 'lint', 'format',
])
// Sort by length descending so longer phrases match first during replacement
const ACTION_WORDS_SORTED = [...ACTION_WORDS].sort((a, b) => b.length - a.length)
const ACTION_WORDS_SET = new Set(ACTION_WORDS)

// Reuse existing stop words from retriever
const CN_STOP_WORDS = new Set([
  '的', '了', '是', '在', '有', '和', '就', '不', '人', '都',
  '一', '个', '上', '也', '很', '到', '说', '要', '去', '你',
  '会', '着', '没', '看', '好', '自', '这', '他', '她', '它',
  '那', '些', '用', '对', '下', '为', '从', '被', '把', '能',
  '可', '以', '所', '而', '又', '与', '但', '或', '等', '中',
  '大', '小', '多', '少', '其', '之', '做', '让', '给', '已',
  '还', '来', '地', '得', '过', '时', '里', '后', '前', '当',
])

export interface RefineResult {
  query: string | null
  tokens: string[]
  entityTokens: string[]
}

/**
 * Refine a raw user message into memory-searchable keywords.
 * Returns null if the message is a pure operation command with no memory relevance.
 */
export function refineQuery(raw: string): RefineResult | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Extract high-signal tokens first: quoted content, book titles, capitalized phrases
  const entityTokens: string[] = []

  // Chinese quotes: 「深色主题」 or "深色主题" or '深色主题'
  for (const m of trimmed.matchAll(/[「""'']([^「""''」]{2,20})[」""'']/g)) {
    entityTokens.push(m[1])
  }
  // Book titles: 《记忆系统》
  for (const m of trimmed.matchAll(/《([^》]+)》/g)) {
    entityTokens.push(m[1])
  }
  // Capitalized English phrases: "TypeScript", "Visual Studio Code"
  for (const m of trimmed.matchAll(/\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+)\b/g)) {
    entityTokens.push(m[1])
  }

  // Tokenize: split by spaces and Chinese character boundaries
  const tokens: string[] = []
  const parts = trimmed.split(/\s+/)
  for (const part of parts) {
    // English words
    for (const word of part.match(/[a-zA-Z0-9_\-.]+/g) ?? []) {
      if (word.length >= 2) tokens.push(word)
    }
    // For Chinese: strip action words first, then extract remaining chars
    let cnText = part.replace(/[\u4e00-\u9fff]+/g, (seg) => {
      let result = seg
      for (const aw of ACTION_WORDS_SORTED) {
        result = result.replaceAll(aw, '')
      }
      return result
    })
    const cnChars = cnText.match(/[\u4e00-\u9fff]/g) ?? []
    for (const c of cnChars) {
      if (!CN_STOP_WORDS.has(c)) tokens.push(c)
    }
    // Chinese 2-grams for better matching
    for (let i = 0; i < cnChars.length - 1; i++) {
      const bigram = cnChars[i] + cnChars[i + 1]
      tokens.push(bigram)
    }
  }

  // Filter stop words, noise, and short tokens
  const filtered = tokens.filter(t => {
    if (ACTION_WORDS_SET.has(t)) return false
    if (CN_STOP_WORDS.has(t)) return false
    if (NOISE_WORDS.has(t.toLowerCase())) return false
    if (t.length < 2) return false
    return true
  })

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const t of filtered) {
    if (!seen.has(t)) {
      seen.add(t)
      deduped.push(t)
    }
  }

  // If nothing left after filtering, check if we have entity tokens
  if (deduped.length === 0 && entityTokens.length === 0) {
    return null
  }

  // Combine: entity tokens first (higher signal), then deduped tokens
  const allTokens = [...entityTokens, ...deduped.filter(t => !entityTokens.includes(t))]
  const query = allTokens.join(' ')

  return { query, tokens: deduped, entityTokens }
}
