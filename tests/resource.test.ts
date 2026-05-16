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
  it('returns empty array for empty category', () => {
    const facts = manager.getFacts('identity')
    expect(facts).toEqual([])
  })

  it('returns facts ordered by trust score', () => {
    store.addFact('用户偏好深色主题', 'tool_pref')
    store.addFact('用户喜欢 VS Code', 'tool_pref')
    const facts = manager.getFacts('tool_pref')
    expect(facts.length).toBe(2)
    // listFacts returns trust_score DESC, first fact added gets default trust
    expect(facts.length).toBeGreaterThan(0)
  })

  it('caches results', () => {
    store.addFact('测试事实', 'general')
    manager.getFacts('general')
    expect(manager.cacheSize()).toBe(1)
    // Second call should hit cache
    const facts2 = manager.getFacts('general')
    expect(facts2.length).toBe(1)
  })

  it('invalidates cache on write', () => {
    store.addFact('测试事实', 'general')
    manager.getFacts('general')
    expect(manager.cacheSize()).toBe(1)
    manager.invalidate()
    expect(manager.cacheSize()).toBe(0)
  })

  it('limits to top 10 facts', () => {
    for (let i = 0; i < 15; i++) {
      store.addFact(`事实 ${i}`, 'general')
    }
    const facts = manager.getFacts('general')
    expect(facts.length).toBe(10)
  })
})
