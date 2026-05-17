## Context

mnemo-mcp 是一个纯全局记忆 MCP Server（不含项目记忆），70 条事实存储在 `~/.mnemo/facts.db`（SQLite + FTS5）。当前检索管线：FTS5 BM25 候选 → Jaccard 重排序 → trust_score 加权 → 时间衰减。

v0.1.4 引入了动态权重（短查询 FTS 0.7/长查询 0.3）、relevance gate (0.15)、content dedup (Jaccard>0.7) 和 query refinement，但实测检索准确率反而下降。根本原因：

1. **动态权重适得其反**：长查询给 FTS5 只留 30%，BM25 正确排序被 Jaccard 覆盖
2. **"万能条"问题**：29% fact 超 500 字（最长 3921 字），字多容易匹配但 helpful 率极低（0.6%）
3. **无反馈闭环**：系统不知道哪些检索是好的，无法自我优化

约束：
- 纯 stdio MCP Server，无 HTTP 端点
- better-sqlite3 同步 API
- 不引入 ML 依赖（embedding 方案留给后续迭代）
- 向后兼容：已有 facts.db 不需要迁移

## Goals / Non-Goals

**Goals:**
- 回退 v3 检索改动，恢复 v2 准确率水平
- 通过 length penalty 解决"万能条"霸占检索
- 通过 summary 字段治理超长 fact 的数据质量
- 通过 retrieval_log + learn action 建立自学习数据基础
- 写入端质量控制：限制 content 长度，引导拆分

**Non-Goals:**
- 不引入 embedding/向量检索（后续迭代）
- 不自动拆分已有超长 fact（需要 LLM，留给手动触发或后续工具）
- 不修改 fact_feedback 机制（保持现有 helpful/unhelpful）
- 不改 MCP Resource 预热方案（已实现，保持）

## Decisions

### D1: 回退动态权重为静态 0.5/0.5

**选择**：恢复 v2 静态 FTS/Jaccard 权重各 0.5
**替代方案**：
- (a) 只调低动态权重范围（如 0.6/0.4）——治标不治本
- (b) 完全移除 Jaccard 只用 FTS5——会丢失部分长查询的 token 匹配能力

**理由**：v2 的静态 0.5/0.5 经用户确认比 v3 更准。FTS5 BM25 本身是成熟的排序算法，Jaccard 作为辅助校验即可，不应主导排序。

### D2: Length Penalty 公式

**选择**：`score *= min(1.0, 300 / matchText.length)`

其中 `matchText` 为 summary（非空时）或 content（summary 为空时）。即 summary 存在时用 summary 长度计算 penalty，避免有 summary 的 fact 被 content 长度过度惩罚。300 字以内不受影响，超过的线性衰减。

**替代方案**：
- (a) `300 / content.length`（不考虑 summary）——有 summary 时过度惩罚
- (b) 指数衰减 `score *= 0.99^length`——过度惩罚
- (c) 硬阈值（超 500 字直接排除）——太粗暴

**理由**：既然检索用的是 summary，penalty 也应该基于实际匹配文本的长度。一条有 summary（50字）的 2000 字 fact，penalty = 300/50 = 6 → cap 到 1.0，不受惩罚，符合预期。

### D3: retrieval_log 设计

**选择**：新建 `retrieval_log` 表，search 时自动插入，保留最近 5000 条

```sql
CREATE TABLE retrieval_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT NOT NULL,
  results    TEXT NOT NULL,  -- JSON array of [{id, score}]
  timestamp  TEXT DEFAULT (datetime('now'))
);
```

每个返回的 fact 记录 `{id, score}`，便于后续分析"为什么某个 fact 总排第一"。

**替代方案**：
- (a) 只记 fact_ids 数组——粒度太粗，无法分析排序原因
- (b) 单独 retrieval_log_details 表——过度设计，JSON 数组够用

**理由**：`[{id, score}]` 在调试时能直接看到每次检索的评分分布，成本只是多存几个数字。5000 条上限覆盖约 1 个月的高频使用。

### D4: learn action 策略

**选择**：统计规则 + trust_score 调整 + 数据质量报告

```
对每条 fact:
  rate = helpful_count / max(retrieval_count, 1)

  if retrieval_count > 30:
    if rate < 0.05:  trust_score *= 0.9
    if rate > 0.3:   trust_score = min(1.0, trust_score + 0.05)

  老化: 超过 60 天 last_retrieved_at → trust_score *= 0.95

返回:
  {promoted, demoted, aged, unchanged,
   long_facts: [{id, content_length, penalty, has_summary}]}
```

aging 基于 `facts.last_retrieved_at` 字段（由 `logRetrieval` 自动更新），不依赖 retrieval_log 查询。

**替代方案**：
- (a) aging 从 retrieval_log 推导——retrieval_log 有 5000 条上限，旧记录可能被删导致判断不准
- (b) 完全不自动调整，只提供数据让人手动调——不够自动化

**理由**：`last_retrieved_at` 字段比从 retrieval_log 查询更可靠（不受日志上限影响）。`long_facts` 报告让用户知道哪些 fact 被 penalty 影响，引导补充 summary。

### D5: summary 字段 + 双阈值设计

**选择**：facts 表新增 `summary TEXT DEFAULT NULL` 列

- summary 非空时，检索用 summary 匹配（FTS5 也索引 summary）
- summary 为空时，退化为原有 content 匹配

两个阈值分工明确：
- **300 字**：length penalty 的计算阈值（matchText ≤ 300 不惩罚）
- **500 字**：写入端数据质量警告阈值（content > 500 且无 summary → 返回 warning）

**替代方案**：
- (a) 自动用 LLM 生成 summary——需要额外依赖，不适合 MCP Server
- (b) 不加 summary，只靠 length penalty——治标不治本

**理由**：300 管检索评分（匹配文本质量），500 管写入质量（数据治理提示），职责不重叠。

### D7: 保留 refineQuery

**选择**：保留 v3 的 `refineQuery()` 查询提炼

**理由**：refineQuery 的核心功能是过滤纯操作指令（"运行测试"→ return null），避免无效检索。这个功能与权重策略无关，在静态权重下同样有用。移除它会导致"git commit"等操作也触发检索，浪费资源。

### D8: 启动时 learn 延迟执行

**选择**：server 启动时用 `process.nextTick()` 延迟执行 learn，不阻塞 stdio 初始化

**替代方案**：
- (a) 完全同步执行——可能阻塞 Claude 端初始化（未来上千条 fact 时）
- (b) 不自动执行，只手动调用——用户容易忘记

**理由**：better-sqlite3 是同步 API，70 条 fact 的遍历虽然只需毫秒，但未来数据增长后可能阻塞。`nextTick` 延迟确保 MCP 握手先完成，learn 在下一个事件循环执行。

### D9: 现有超长 fact 治理路径

**选择**：learn action 返回 `long_facts` 数据质量报告 + 新增 `audit` action

- learn 返回 `long_facts: [{id, content_length, penalty, has_summary}]`，列出被 length penalty 严重影响的 fact
- 新增 `fact_store(action="audit")` 返回完整数据质量报告：超长 fact 列表、无 summary 的长 fact、低 helpful 率 fact、老化候选

**理由**：用户需要知道为什么某些记忆突然排不上来（length penalty 影响），也需要工具引导治理。audit action 比 learn 更全面，专门做数据质量分析不改数据。

### D6: 移除 relevance gate

**选择**：完全移除 v3 的 `RELEVANCE_THRESHOLD = 0.15` 过滤

**理由**：0.15 阈值在短查询时经常误杀相关结果。length penalty 已经能更优雅地解决低质量问题。

## Risks / Trade-offs

- [Risk] summary 字段增加写入复杂度 → 回退策略：summary 为空时完全退化，零影响
- [Risk] learn action 误降核心记忆的 trust → 缓解：rate < 0.05 阈值很保守，需 30+ 次检索才能触发；trust 下降是渐进的（×0.9）
- [Risk] retrieval_log 表增长 → 缓解：保留最近 5000 条，超出自动删除最旧记录
- [Risk] length penalty 对无 summary 的超长 fact 影响过大 → 缓解：learn 返回 long_facts 报告 + audit action 引导用户补充 summary
- [Trade-off] 回退动态权重意味着放弃了"长查询偏 Jaccard"的策略 → 可接受：静态 0.5/0.5 经验证更准
- [Risk] 启动时 learn 在大数据量下阻塞 → 缓解：process.nextTick 延迟执行，MCP 握手先完成

## Migration Plan

1. ALTER TABLE facts ADD COLUMN summary TEXT DEFAULT NULL —— 向后兼容，无数据丢失
2. ALTER TABLE facts ADD COLUMN last_retrieved_at TEXT DEFAULT NULL —— 用于 aging 判断
3. CREATE TABLE retrieval_log —— 新表，无影响
4. 回退 retriever.ts 中的动态权重代码 —— 纯代码变更
5. 更新 FTS5 索引以包含 summary 列 —— 需要重建虚拟表（数据量 70 条，瞬间完成）
6. 发布为 minor version（v0.2.0），向后兼容 v0.1.4

## Open Questions

- ~~summary 为空时，是否应该自动用 content 前 100 字作为 fallback summary？~~ → 已决策：不自动截取，依赖用户/AI 提供或用 audit action 引导
- ~~learn action 的执行时机~~ → 已决策：启动时 process.nextTick 延迟执行
- ~~已有超长 fact 是否需要一次性治理~~ → 已决策：learn 返回 long_facts 报告 + audit action 引导
