## MODIFIED Requirements

### Requirement: Dream action 整理记忆库
系统 SHALL 提供 `fact_store(action="dream")` 操作，执行两阶段整理：合并同主题 → 精简 content。

#### Scenario: 合并同主题 fact
- **WHEN** 同 category 内多条 fact 讲述同一主题（由 LLM 判定语义重复）
- **THEN** 系统 SHALL 将多条 fact 的 content 合并为一条完整 fact（保留所有关键信息），删除多余 fact，在 dream report 中记录合并对

#### Scenario: 精简长 content
- **WHEN** fact 的 content 长度 > 200 字
- **THEN** 系统 SHALL 由 LLM 精简 content（去除冗余、保留关键信息），直接覆写 content 字段

#### Scenario: Dream 前备份
- **WHEN** dream action 被触发
- **THEN** 系统在执行任何修改前，自动将数据库备份到 `~/.mnemo/backup/dream-<timestamp>.db`

#### Scenario: 输出 dream report
- **WHEN** dream 整理完成
- **THEN** 系统返回 JSON 报告，包含 merged、compressed、reclassified（0）、deleted 计数和 health 统计

#### Scenario: LLM 不可用回退
- **WHEN** LLM 服务不可用
- **THEN** 系统 SHALL 回退到规则引擎执行基本合并（Jaccard > 0.6），不执行精简，report 中标记 `fallback: true`

### Requirement: 高频 fact 保护
Dream 整理 SHALL 保护高信任分和高频检索的 fact 不被删除。

#### Scenario: 高信任分 fact 不被合并删除
- **WHEN** 两条 fact 满足合并条件，但其中一条 trust_score > 0.8
- **THEN** 系统保留高信任分 fact，将其 content 作为合并基础

#### Scenario: 高频检索 fact 不被合并删除
- **WHEN** 两条 fact 满足合并条件，但其中一条 retrieval_count > 100
- **THEN** 系统保留高频 fact，仅删除另一条低频 fact

## REMOVED Requirements

### Requirement: 压缩长 fact（生成 summary）
**Reason**: summary 不再用于检索和展示，改由 LLM 直接精简 content
**Migration**: `smartCompress` 从"生成 summary"改为"LLM 覆写 content"

### Requirement: 分类修正
**Reason**: LLM 精简和合并已隐含分类优化，不再需要独立的分类修正步骤
**Migration**: dream 流程简化为 merge → compress 两步
