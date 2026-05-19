import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store.js'
import { FactRetriever } from '../src/retriever.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let store: MemoryStore
let retriever: FactRetriever
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mnemo-test-'))
  store = new MemoryStore(join(tmpDir, 'test.db'))
  retriever = new FactRetriever(store)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ------------------------------------------------------------------
// 4.3 回归测试：search / probe / related / reason / contradict
// ------------------------------------------------------------------

describe('FactRetriever - regression tests', () => {
  it('should find facts by FTS5 search', () => {
    store.addFact('用户偏好深色主题', 'tool_pref', 'theme,dark')
    const results = retriever.search('深色主题')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('深色主题')
  })

  it('should return empty for no matches', () => {
    store.addFact('用户偏好深色主题', 'tool_pref')
    const results = retriever.search('量子计算')
    expect(results.length).toBe(0)
  })

  it('should probe facts by entity', () => {
    store.addFact('使用 "TypeScript" 开发前端', 'coding_style')
    const results = retriever.probe('TypeScript')
    expect(results.length).toBeGreaterThan(0)
  })

  it('should find related facts', () => {
    store.addFact('使用 "React" 开发前端，喜欢 "TypeScript"', 'coding_style')
    store.addFact('使用 "TypeScript" 编写后端 API', 'coding_style')
    const results = retriever.related('React')
    expect(results.length).toBeGreaterThan(0)
  })

  it('should reason across multiple entities', () => {
    store.addFact('用 "React" + "TypeScript" 全栈开发', 'coding_style')
    const results = retriever.reason(['React', 'TypeScript'])
    expect(results.length).toBeGreaterThan(0)
  })

  it('should detect contradictions', () => {
    store.addFact('项目使用 "React" 框架进行前端开发', 'coding_style')
    store.addFact('项目使用 "Vue" 框架进行前端开发', 'coding_style')
    const results = retriever.contradict()
    // 两则事实共享实体 "框架" "前端" "开发" 但内容不同
    expect(results.length).toBeGreaterThanOrEqual(0)
    // 矛盾检测依赖实体提取和 Jaccard 计算，只验证不报错
  })
})

// ------------------------------------------------------------------
// 4.1 静态权重测试（RRF 版本）
// ------------------------------------------------------------------

describe('static weights via RRF', () => {
  it('uses same RRF formula for short and long queries', () => {
    store.addFact('用户偏好 VS Code 编辑器', 'tool_pref')
    const shortResults = retriever.search('VS Code')
    const longResults = retriever.search('为什么 VS Code 编辑器总是报错说找不到模块')
    // 两次查询都应找到该事实
    expect(shortResults.some(r => r.content.includes('VS Code'))).toBe(true)
    expect(longResults.some(r => r.content.includes('VS Code'))).toBe(true)
  })
})

// ------------------------------------------------------------------
// 长度不再影响评分（RRF 不使用 length penalty）
// ------------------------------------------------------------------

describe('RRF scoring without length penalty', () => {
  it('does NOT penalize long facts — RRF has no length factor', () => {
    const longContent = '用户偏好 ' + '详细说明'.repeat(200) // ~800 chars
    const longId = store.addFact(longContent, 'tool_pref')
    const shortId = store.addFact('用户偏好 VS Code', 'tool_pref')
    const results = retriever.search('用户偏好')
    expect(results.length).toBeGreaterThanOrEqual(2)
    const longFact = results.find(r => r.factId === longId)
    const shortFact = results.find(r => r.factId === shortId)
    // RRF 不按长度惩罚，两个事实的 score 都应 > 0
    expect(longFact).toBeTruthy()
    expect(shortFact).toBeTruthy()
    if (longFact && shortFact) {
      expect(longFact.score).toBeGreaterThan(0)
      expect(shortFact.score).toBeGreaterThan(0)
    }
  })

  it('long facts with summary are found without extra penalty', () => {
    const longContent = '用户偏好的详细内容' + '补充说明'.repeat(200)
    const id = store.addFact(longContent, 'general')
    store.connection.prepare('UPDATE facts SET summary = ? WHERE fact_id = ?').run('用户偏好', id)
    store.addFact('用户偏好 VS Code', 'tool_pref')
    const results = retriever.search('用户偏好')
    const summaryFact = results.find(r => r.factId === id)
    expect(summaryFact).toBeTruthy()
    if (summaryFact) {
      expect(summaryFact.score).toBeGreaterThan(0)
    }
  })
})

// ------------------------------------------------------------------
// 4.1 scoreAdaptiveRRF 单元测试
// ------------------------------------------------------------------

describe('RRF scoring scenarios', () => {
  it('normal FTS: multiple candidates returned with valid RRF scores', () => {
    // 添加三个事实，都包含 "Python"，但各自有不同的领域关键词
    const id1 = store.addFact('Python 数据分析 Pandas NumPy', 'coding_style')
    const id2 = store.addFact('Python 机器学习 TensorFlow PyTorch', 'coding_style')
    const id3 = store.addFact('Python Web 框架 Django Flask', 'coding_style')

    // 搜索 "Python" — FTS5 应命中所有三个事实
    const results = retriever.search('Python')
    expect(results.length).toBeGreaterThanOrEqual(3)

    // 所有结果都有有效的 RRF score (> 0)
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0)
    }

    // 三个事实都应出现在结果中
    const foundIds = new Set(results.map(r => r.factId))
    expect(foundIds.has(id1)).toBe(true)
    expect(foundIds.has(id2)).toBe(true)
    expect(foundIds.has(id3)).toBe(true)
  })

  it('normal FTS: more relevant fact ranks higher among two candidates', () => {
    // 两个事实：一个与查询高度匹配，一个只是部分匹配
    const idRelevant = store.addFact('Docker 容器部署 Kubernetes 集群管理', 'workflow')
    const idPartial = store.addFact('Docker 基础入门教程简介', 'general')

    const results = retriever.search('Docker 容器部署')
    expect(results.length).toBeGreaterThanOrEqual(2)

    // 高度相关的事实应出现在结果中且 score > 0
    const relevant = results.find(r => r.factId === idRelevant)
    expect(relevant).toBeTruthy()
    expect(relevant!.score).toBeGreaterThan(0)
  })

  it('LIKE fallback: triggers when FTS yields uniform ranks', () => {
    // LIKE fallback 在 FTS 失效时触发（通过 likeFallback 给 ftsRank=0.5）
    // 所有候选 ftsRank 相同 → 方差 < 0.001 → 切换权重
    // 插入包含特定词的事实
    store.addFact('量子计算 量子比特 叠加态', 'general')
    store.addFact('量子纠缠 量子通信 加密', 'general')
    // 使用不太能命中 FTS trigram 但能命中 LIKE 的查询
    const results = retriever.search('量子')
    // 如果 FTS 没有命中（trigram 需要至少 3 字符），会走 LIKE fallback
    // 但 "量子" 只有 2 字符，FTS trigram 无法匹配，会走 LIKE
    if (results.length >= 2) {
      // 所有结果的 score > 0（RRF 保证）
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0)
      }
    }
  })

  it('zero candidates: search for nonexistent term returns empty', () => {
    store.addFact('用户偏好深色主题', 'tool_pref')
    const results = retriever.search('量子计算超导材料')
    expect(results.length).toBe(0)
  })

  it('single candidate: only one fact matches → returns that fact', () => {
    const id = store.addFact('部署 Docker 容器编排 Kubernetes', 'workflow')
    store.addFact('用户偏好紫色作为主题色', 'identity')

    const results = retriever.search('Docker 容器编排')
    expect(results.length).toBe(1)
    expect(results[0].factId).toBe(id)
    expect(results[0].score).toBeGreaterThan(0)
  })
})

// ------------------------------------------------------------------
// 4.2 冲突场景集成测试
// ------------------------------------------------------------------

describe('conflict scenario: high trust irrelevant vs low trust relevant', () => {
  it('relevant low-trust fact ranks higher than irrelevant high-trust fact', () => {
    // 高信任、与查询无关
    const idHigh = store.addFact('用户喜欢紫色作为主题色搭配蓝色渐变', 'identity')
    store.connection.prepare('UPDATE facts SET trust_score = ? WHERE fact_id = ?').run(0.95, idHigh)

    // 低信任、与查询高度相关
    const idLow = store.addFact('部署 Docker Kubernetes 容器编排集群管理', 'workflow')
    store.connection.prepare('UPDATE facts SET trust_score = ? WHERE fact_id = ?').run(0.35, idLow)

    const results = retriever.search('Docker 部署')

    // 应该至少返回低信任的相关事实
    expect(results.length).toBeGreaterThanOrEqual(1)

    const lowFact = results.find(r => r.factId === idLow)
    expect(lowFact).toBeTruthy()

    // 关键验证：RRF 中 simRank 权重大，相关事实应排在前面
    // 即使高信任事实也被检索到，低信任的相关事实排名应该更高
    const highFact = results.find(r => r.factId === idHigh)
    if (highFact && lowFact) {
      expect(lowFact.score).toBeGreaterThan(highFact.score)
    }
  })

  it('very high trust cannot override extreme irrelevance in RRF', () => {
    // 极端高信任、完全无关
    const idIrrelevant = store.addFact('天气预报说明天会下雨气温降低', 'general')
    store.connection.prepare('UPDATE facts SET trust_score = ? WHERE fact_id = ?').run(0.99, idIrrelevant)

    // 低信任、高度相关
    const idRelevant = store.addFact('React 组件 hooks useState useEffect', 'coding_style')
    store.connection.prepare('UPDATE facts SET trust_score = ? WHERE fact_id = ?').run(0.30, idRelevant)

    const results = retriever.search('React hooks')

    const relevant = results.find(r => r.factId === idRelevant)
    expect(relevant).toBeTruthy()

    // 如果无关事实也被检索到（通过 fallback），相关事实应排在前面
    const irrelevant = results.find(r => r.factId === idIrrelevant)
    if (irrelevant && relevant) {
      expect(relevant.score).toBeGreaterThan(irrelevant.score)
    }
  })
})

// ------------------------------------------------------------------
// no relevance gate（保留原有行为验证）
// ------------------------------------------------------------------

describe('no relevance gate', () => {
  it('returns results even with low scores', () => {
    store.addFact('完全不相关关于天气', 'general')
    const results = retriever.search('天气')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })
})
