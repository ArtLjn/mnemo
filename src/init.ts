#!/usr/bin/env node

/**
 * mnemo init — 一键配置 mnemo 记忆系统
 *
 * 执行：
 * 1. claude mcp add mnemo — 注册 MCP 服务器
 * 2. ~/.claude/CLAUDE.md — 写入记忆使用规则
 * 3. ~/.claude/settings.json — 添加 MCP 工具权限
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CLAUDE_DIR = join(homedir(), '.claude')
const CLAUDE_MD_PATH = join(CLAUDE_DIR, 'CLAUDE.md')
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json')

const RULES_START = '<!-- mnemo-rules:start -->'
const RULES_END = '<!-- mnemo-rules:end -->'

const MEMORY_RULES = `${RULES_START}

# mnemo 记忆系统

- 身份问题（"你是谁"等）→ 先 fact_store(search, query="角色设定")，按设定回答
- 用户说"记住"→ fact_store(add)，先 search 去重
- 成功使用记忆 → fact_feedback(helpful, fact_id)
- 完成复杂任务后，如果发现了新的习惯/偏好/决策/工作流，用 fact_store(auto_observe, category=对应分类) 自动记录。分类参考：identity（身份）、coding_style（编码习惯）、tool_pref（工具偏好）、workflow（工作流）、general（通用知识）
${RULES_END}`

const MCP_TOOLS = [
  'mcp__mnemo__fact_store',
  'mcp__mnemo__fact_feedback',
]

function log(msg: string) {
  console.log(`\x1b[36m[mnemo]\x1b[0m ${msg}`)
}

function ok(msg: string) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`)
}

function warn(msg: string) {
  console.log(`\x1b[33m!\x1b[0m ${msg}`)
}

function fail(msg: string) {
  console.log(`\x1b[31m✗\x1b[0m ${msg}`)
}

// -- Step 1: Register MCP server --
function registerMcp() {
  log('注册 MCP 服务器（全局）...')
  try {
    execSync(`claude mcp add --scope user mnemo -- mnemo-server`, {
      stdio: 'pipe',
      timeout: 15000,
    })
    ok('MCP 服务器已注册 (claude mcp list 查看)')
  } catch (err: any) {
    const stderr = err.stderr?.toString() || ''
    if (stderr.includes('already exists') || stderr.includes('already registered')) {
      warn('MCP 服务器已存在，跳过注册')
    } else {
      fail(`注册失败: ${stderr.slice(0, 200)}`)
      fail('请手动运行: claude mcp add mnemo -- mnemo-server')
    }
  }
}

// -- Step 2: Write CLAUDE.md --
function writeClaudeMd() {
  log('配置记忆使用规则...')
  mkdirSync(CLAUDE_DIR, { recursive: true })

  let existing = ''
  if (existsSync(CLAUDE_MD_PATH)) {
    existing = readFileSync(CLAUDE_MD_PATH, 'utf-8')
  }

  // 有标记 → 替换旧规则块为新版本
  if (existing.includes(RULES_START)) {
    const startIdx = existing.indexOf(RULES_START)
    const endIdx = existing.indexOf(RULES_END) + RULES_END.length
    const updated = existing.slice(0, startIdx) + MEMORY_RULES + existing.slice(endIdx)
    writeFileSync(CLAUDE_MD_PATH, updated)
    ok('记忆规则已更新到最新版本')
    return
  }

  // 无标记但包含旧版规则（兼容升级）→ 替换旧规则
  const legacyMarker = 'mnemo 记忆工具'
  if (existing.includes(legacyMarker)) {
    // 找到旧规则块：从 "# mnemo 记忆系统" 或包含 legacyMarker 的行开始
    const lines = existing.split('\n')
    let ruleStart = -1
    let ruleEnd = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('# mnemo 记忆系统') || lines[i].includes(legacyMarker)) {
        if (ruleStart === -1) ruleStart = i
      }
      if (ruleStart !== -1 && ruleEnd === -1) {
        // 找到规则块结尾：空行后跟非规则内容
        if (i > ruleStart && lines[i].trim() === '') {
          ruleEnd = i
        }
      }
    }
    if (ruleStart !== -1) {
      if (ruleEnd === -1) ruleEnd = lines.length
      const before = lines.slice(0, ruleStart).join('\n').trimEnd()
      const after = lines.slice(ruleEnd).join('\n')
      const updated = before + '\n' + MEMORY_RULES + (after.trim() ? '\n' + after : '')
      writeFileSync(CLAUDE_MD_PATH, updated)
      ok('记忆规则已从旧版升级到最新版本')
      return
    }
  }

  // 首次写入
  const merged = existing
    ? existing.trimEnd() + '\n' + MEMORY_RULES
    : MEMORY_RULES.trimStart()

  writeFileSync(CLAUDE_MD_PATH, merged)
  ok(`记忆规则已写入 ${CLAUDE_MD_PATH}`)
}

// -- Step 3: Update settings.json permissions --
function updatePermissions() {
  log('配置工具权限...')
  mkdirSync(CLAUDE_DIR, { recursive: true })

  let settings: any = {}
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    } catch {
      warn('settings.json 解析失败，将覆盖')
    }
  }

  if (!settings.permissions) settings.permissions = {}
  if (!settings.permissions.allow) settings.permissions.allow = []

  let added = 0
  for (const tool of MCP_TOOLS) {
    if (!settings.permissions.allow.includes(tool)) {
      settings.permissions.allow.push(tool)
      added++
    }
  }

  if (added === 0) {
    warn('权限已配置，跳过')
    return
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
  ok(`已添加 ${added} 个工具权限到 ${SETTINGS_PATH}`)
}

// -- Main --
function main() {
  console.log('')
  console.log('\x1b[1m  mnemo init — 一键配置记忆系统\x1b[0m')
  console.log('')

  registerMcp()
  writeClaudeMd()
  updatePermissions()

  console.log('')
  ok('配置完成！重启 Claude Code 即可使用记忆系统。')
  console.log('')
}

main()
