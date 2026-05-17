## Context

mnemo-mcp 当前架构中 `summary` 字段承担了三个职责：检索匹配（Jaccard/containment）、展示给 AI（display）、dream 内部使用。但 summary 质量不稳定：
- `extractSummary` 用 `.` 做句子分割，URL（smtp.qiye.163.com）和邮箱（junnan.liu_sx@aispeech.com）被截断为碎片
- LLM 生成的 summary 可能过短（30 字 vs 317 字 content），丢失关键信息
- 有 summary 后 `smartCompress` 不再处理（`summary IS NULL` 条件跳过），坏 summary 永远无法修复

当前检索流程：FTS5 候选 → Jaccard 重排序（用 summary）→ trust/时间/length penalty。summary 丢关键词 = 检索直接废掉。

## Goals / Non-Goals

**Goals:**
- content 成为唯一数据源，检索和展示都基于 content
- dream 职责简化：合并同主题 fact + LLM 精简 content
- 消除 summary 质量不稳定对检索准确性的影响

**Non-Goals:**
- 不删除 summary 字段（向后兼容，dream 内部可继续使用）
- 不改变 FTS5 索引结构
- 不改变 trust score、时间衰减等评分机制
- 不改变 LLM client 配置和接口

## Decisions

### Decision 1: 检索和展示统一使用 content

**选择**：`matchText = fact.content`，`display = fact.content`

**替代方案**：
- A) `matchText = summary + content` 合并 — 冗余，content 已包含所有信息
- B) 质量守卫 summary，保留 summary 匹配 — 增加复杂度，仍依赖 summary 质量

**理由**：content 始终包含最完整信息，直接用 content 消除 summary 引入的所有问题。

### Decision 2: dream 精简直接覆写 content

**选择**：LLM 重写 content（去冗余、保留关键信息），直接 UPDATE content 字段

**替代方案**：
- A) 保持 summary 字段，修复质量 — 治标不治本，仍需维护双字段一致性
- B) 新增 compressed_content 字段 — 增加字段复杂度

**理由**：content-only 架构最简单，LLM 精简后信息仍然完整，只是更紧凑。

### Decision 3: dream 流程改为 merge → compress

**选择**：先合并同主题 fact，再精简 content

**理由**：合并减少 fact 数量后，compress 处理的数据更少，LLM 调用次数更少。

### Decision 4: summary 字段保留但降级

**选择**：保留 summary 列，dream 内部批量处理时仍可使用，但不参与检索和展示

**理由**：避免数据库 migration，已有数据不丢失。

## Risks / Trade-offs

- **[LLM 覆写 content 可能丢信息]** → dream 前自动备份数据库（已有机制），compress prompt 强调保留关键信息（谁/什么/数据/决策）
- **[display 返回长 content 消耗更多 token]** → 通过 dream compress 持续精简 content，长期 token 消耗会降低；短 term 内 content 本身由用户输入，长度可控
- **[merge 误合并不同 fact]** → 保留信任分 > 0.8 和 retrieval_count > 100 的保护机制；LLM prompt 要求语义相同才合并
- **[向后兼容]** → summary 列不删除，只是不再用于检索/展示；已发布的 API 返回字段不变（display 内容从 summary 变为 content）
