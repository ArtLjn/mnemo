import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

let tmpDir: string
let dbPath: string
let invalidatePath: string

function runMnemo(command: string, args: string[] = []): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(
    'node',
    ['dist/cli.js', command, ...args],
    {
      env: { ...process.env, MNEMO_DB_PATH: dbPath, MNEMO_INVALIDATE_PATH: invalidatePath },
      encoding: 'utf-8',
      cwd: process.cwd(),
    }
  )
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mnemo-cli-test-'))
  dbPath = join(tmpDir, 'test.db')
  invalidatePath = join(tmpDir, '.cache-invalidate')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('CLI observe', () => {
  it('saves a new fact', () => {
    const { stdout, exitCode } = runMnemo('observe', ['用户偏好使用 TypeScript'])
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result.saved).toBe(true)
    expect(result.category).toBe('workflow')
  })

  it('rejects oversized content', () => {
    const oversized = 'x'.repeat(301)
    const { stdout, exitCode } = runMnemo('observe', [oversized])
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result.saved).toBe(false)
    expect(result.reason).toContain('超过 300 字')
  })

  it('merges similar facts', () => {
    const { stdout: stdout1, exitCode: ec1 } = runMnemo('observe', ['测试内容A'])
    expect(ec1).toBe(0)
    const result1 = JSON.parse(stdout1.trim())
    expect(result1.saved).toBe(true)
    const firstFactId = result1.fact_id

    const { stdout: stdout2, exitCode: ec2 } = runMnemo('observe', ['测试内容A', '--category', 'general'])
    expect(ec2).toBe(0)
    const result2 = JSON.parse(stdout2.trim())
    expect(result2.status).toBe('updated')
    expect(result2.fact_id).toBe(firstFactId)
  })
})

describe('CLI search', () => {
  it('finds saved facts', () => {
    runMnemo('observe', ['用户偏好使用 TypeScript 开发项目'])

    const { stdout, exitCode } = runMnemo('search', ['TypeScript'])
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result.count).toBeGreaterThanOrEqual(1)
    expect(result.results.some((r: any) => r.content.includes('TypeScript'))).toBe(true)
  })

  it('filters by category', () => {
    runMnemo('observe', ['编码规范内容', '--category', 'coding_style'])
    runMnemo('observe', ['工具偏好内容', '--category', 'tool_pref'])

    const { stdout, exitCode } = runMnemo('search', ['内容', '--category', 'coding_style'])
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result.count).toBeGreaterThanOrEqual(1)
    expect(result.results.every((r: any) => r.category === 'coding_style')).toBe(true)
  })
})

describe('CLI feedback', () => {
  it('rates a fact as helpful', () => {
    const { stdout: obsStdout } = runMnemo('observe', ['测试反馈内容'])
    const observeResult = JSON.parse(obsStdout.trim())
    const factId = observeResult.fact_id

    const { stdout, exitCode } = runMnemo('feedback', [`${factId}`, 'helpful'])
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result.updated).toBe(true)
    expect(result.new_trust).toBeGreaterThan(result.old_trust)
  })

  it('rates a fact as unhelpful', () => {
    const { stdout: obsStdout } = runMnemo('observe', ['测试反馈内容2'])
    const observeResult = JSON.parse(obsStdout.trim())
    const factId = observeResult.fact_id

    const { stdout, exitCode } = runMnemo('feedback', [`${factId}`, 'unhelpful'])
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result.updated).toBe(true)
    expect(result.new_trust).toBeLessThan(result.old_trust)
  })
})

describe('CLI review', () => {
  it('returns audit report', () => {
    runMnemo('observe', ['review 测试内容'])

    const { stdout, exitCode } = runMnemo('review')
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result).toHaveProperty('total_facts')
    expect(result).toHaveProperty('long_without_summary')
    expect(result).toHaveProperty('low_helpful_rate')
    expect(result).toHaveProperty('aging_candidates')
  })
})
