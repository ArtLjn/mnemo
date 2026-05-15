/**
 * 记忆安全扫描器。
 * 移植自 Hermes memory_tool.py 的 _scan_memory_content 并扩展。
 *
 * 三重扫描：提示注入检测、PII 检测、不可见 Unicode 检测。
 */

import type { SecurityScanResult } from './types.js'

// -- 提示注入检测 ---

/** 检测伪造围栏标签 */
const MEMORY_CONTEXT_INJECTION_RE = /<\s*\/?\s*memory-context\s*>/i
/** 检测 system-reminder 伪装 */
const SYSTEM_REMINDER_INJECTION_RE = /<\s*system-reminder\s*>/i

/** 提示注入模式 */
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|context)/i,
  /forget\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|context)/i,
  /you\s+are\s+now\s+(?:a|an|the)\s+/i,
  /do\s+not\s+tell\s+the\s+user/i,
  /(?:system|admin|root)\s+(?:prompt|instruction|message)/i,
  /disregard\s+(?:your|all|any)\s+(?:instructions|rules|guidelines)/i,
  /act\s+as\s+(?:if|though)\s+you\s+(?:have\s+no|don'?t\s+have)\s+(?:restrictions|limits|rules)/i,
]

// -- 数据外泄检测 ---

const EXFIL_PATTERNS = [
  /curl\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /wget\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /(?:cat|type|read)\s+[^\n]*(?:\.env|credentials|\.netrc|\.pgpass|\.npmrc)/i,
  /authorized_keys/i,
]

// -- PII 检测 ---

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const API_KEY_PATTERNS = [
  /(?:sk|pk|api[_-]?key|token|secret)[_-][a-zA-Z0-9]{20,}/gi,
  /ghp_[a-zA-Z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
]

// -- 不可见 Unicode ---

const INVISIBLE_UNICODE_RANGES: Array<[number, number, string]> = [
  [0x200B, 0x200F, '零宽字符'],
  [0x2028, 0x202E, '控制字符'],
  [0x2060, 0x206F, '不可见格式字符'],
  [0xFEFF, 0xFEFF, 'BOM'],
  [0xFFF9, 0xFFFB, '注解字符'],
]

// -- 导出函数 ---

/** 扫描注入尝试（硬拦截级别） */
export function scanForInjection(text: string): SecurityScanResult {
  const injectionAttempts: string[] = []

  if (MEMORY_CONTEXT_INJECTION_RE.test(text)) {
    injectionAttempts.push('检测到 memory-context 标签注入')
  }
  if (SYSTEM_REMINDER_INJECTION_RE.test(text)) {
    injectionAttempts.push('检测到 system-reminder 标签注入')
  }

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      injectionAttempts.push(`匹配提示注入模式: ${pattern.source}`)
    }
  }

  for (const pattern of EXFIL_PATTERNS) {
    if (pattern.test(text)) {
      injectionAttempts.push(`匹配数据外泄模式`)
    }
  }

  return {
    safe: injectionAttempts.length === 0,
    warnings: [],
    hasPii: false,
    injectionAttempts,
  }
}

/** 扫描 PII（警告级别，不阻止存储） */
export function scanForPii(text: string): SecurityScanResult {
  const warnings: string[] = []
  let hasPii = false

  // 重置 lastIndex（因为使用了 g flag）
  EMAIL_RE.lastIndex = 0
  if (EMAIL_RE.test(text)) { warnings.push('包含邮箱地址'); hasPii = true }

  for (const p of API_KEY_PATTERNS) {
    p.lastIndex = 0
    if (p.test(text)) { warnings.push('包含 API 密钥模式'); hasPii = true; break }
  }

  return { safe: true, warnings, hasPii, injectionAttempts: [] }
}

/** 扫描不可见 Unicode（拦截级别） */
export function scanForInvisibleUnicode(text: string): SecurityScanResult {
  const warnings: string[] = []
  for (const [lo, hi, name] of INVISIBLE_UNICODE_RANGES) {
    for (let cp = lo; cp <= hi; cp++) {
      if (text.includes(String.fromCodePoint(cp))) {
        warnings.push(`包含不可见 Unicode: ${name} (U+${cp.toString(16).toUpperCase()})`)
      }
    }
  }
  return { safe: warnings.length === 0, warnings, hasPii: false, injectionAttempts: [] }
}

/** 综合安全扫描 */
export function fullSecurityScan(text: string): SecurityScanResult {
  const injection = scanForInjection(text)
  const pii = scanForPii(text)
  const unicode = scanForInvisibleUnicode(text)

  return {
    safe: injection.safe && unicode.safe,
    warnings: [...injection.warnings, ...pii.warnings, ...unicode.warnings],
    hasPii: pii.hasPii,
    injectionAttempts: injection.injectionAttempts,
  }
}
