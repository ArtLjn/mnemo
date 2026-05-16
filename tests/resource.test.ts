import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store.js'
import { ResourceManager } from '../src/resources.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let store: MemoryStore
let manager: ResourceManager
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mnemo-test-'))
  store = new MemoryStore(join(tmpDir, 'test.db'))
  manager = new ResourceManager(store)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('ResourceManager', () => {
  it('returns empty markdown for empty category', () => {
    const text = readResource('identity')
    expect(text).toContain('身份与行为设定')
    expect(text).not.toContain('## 你的身份')
  })

  it('formats identity facts as instructions', () => {
    store.addFact('AI角色设定：大名暖暖，身份是用户的编程助手', 'identity')
    const text = readResource('identity')
    expect(text).toContain('你的身份')
    expect(text).toContain('暖暖')
  })

  it('formats non-identity facts as reference', () => {
    store.addFact('用户偏好深色主题', 'tool_pref')
    const text = readResource('tool_pref')
    expect(text).toContain('工具偏好')
    expect(text).toContain('深色主题')
  })

  it('caches results', () => {
    store.addFact('测试事实', 'general')
    readResource('general')
    expect(manager.cacheSize()).toBe(1)
    readResource('general')
    expect(manager.cacheSize()).toBe(1)
  })

  it('invalidates cache', () => {
    store.addFact('测试事实', 'general')
    readResource('general')
    expect(manager.cacheSize()).toBe(1)
    manager.invalidate()
    expect(manager.cacheSize()).toBe(0)
  })
})

function readResource(category: string): string {
  const result = (manager as any).readCategory(category)
  return result.contents[0].text
}
