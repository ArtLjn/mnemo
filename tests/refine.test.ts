import { describe, it, expect } from 'vitest'
import { refineQuery } from '../src/refine.js'

describe('refineQuery', () => {
  it('filters action words from Chinese query', () => {
    const result = refineQuery('帮我用 TypeScript 重构 auth 模块')
    expect(result).not.toBeNull()
    expect(result!.query).toContain('TypeScript')
    expect(result!.query).toContain('auth')
    expect(result!.query).not.toContain('帮我')
    expect(result!.query).not.toContain('重构')
  })

  it('returns null for pure operation commands', () => {
    expect(refineQuery('运行测试')).toBeNull()
    expect(refineQuery('git status')).toBeNull()
    expect(refineQuery('创建文件')).toBeNull()
  })

  it('extracts quoted Chinese entities', () => {
    const result = refineQuery('我喜欢「深色主题」')
    expect(result).not.toBeNull()
    expect(result!.entityTokens).toContain('深色主题')
    expect(result!.query).toContain('深色主题')
  })

  it('extracts book title entities', () => {
    const result = refineQuery('读了《设计模式》这本书')
    expect(result).not.toBeNull()
    expect(result!.entityTokens).toContain('设计模式')
  })

  it('extracts capitalized English phrases', () => {
    const result = refineQuery('使用 Visual Studio Code 编辑器')
    expect(result).not.toBeNull()
    expect(result!.entityTokens).toContain('Visual Studio Code')
  })

  it('returns null for empty string', () => {
    expect(refineQuery('')).toBeNull()
    expect(refineQuery('   ')).toBeNull()
  })

  it('preserves meaningful Chinese tokens', () => {
    const result = refineQuery('用户偏好深色主题')
    expect(result).not.toBeNull()
    expect(result!.query).toContain('用户')
    expect(result!.query).toContain('偏好')
    expect(result!.query).toContain('深色')
    expect(result!.query).toContain('主题')
  })
})
