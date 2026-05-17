## MODIFIED Requirements

### Requirement: Dream action 整理记忆库
系统 SHALL 提供 `fact_store(action="dream")` 操作，优先使用 LLM 做语义级整理（合并、摘要、分类），LLM 不可用时降级到规则引擎。整理前自动备份数据库。

#### Scenario: LLM 驱动的语义合并
- **WHEN** 同 category 内存在语义重复的 fact（由 LLM 判断）
- **THEN** 系统合并重复 fact，保留内容更完整的，在 dream report 中记录合并对和原因

#### Scenario: LLM 驱动的智能摘要
- **WHEN** fact 的 content 长度 > 200 字且 summary 为 NULL
- **THEN** 系统由 LLM 生成精准摘要（≤ 150 字）写入 summary 字段

#### Scenario: LLM 驱动的智能分类
- **WHEN** fact 的 category 为 "general" 但内容属于其他 category
- **THEN** 系统由 LLM 判断正确分类并更新

#### Scenario: 降级到规则引擎
- **WHEN** LLM 服务不可用（连接失败/超时）
- **THEN** 系统自动降级到规则引擎（Jaccard 合并、截取摘要、关键词分类），report 中标记 fallback: true

#### Scenario: Dream 前备份
- **WHEN** dream action 被触发
- **THEN** 系统在执行任何修改前，自动将数据库备份到备份目录

#### Scenario: 输出 dream report
- **WHEN** dream 整理完成
- **THEN** 系统返回 JSON 报告，包含 merged、compressed、reclassified、deleted 计数、health 统计、fallback 标记

### Requirement: CLI dream 命令
系统 SHALL 提供 `mnemo-dream` CLI 命令，手动触发 LLM 驱动的 dream 整理。

#### Scenario: 手动执行 dream
- **WHEN** 用户运行 `mnemo-dream`
- **THEN** 系统执行 LLM 驱动的 dream cycle 并输出 report 到 stdout

### Requirement: 高频 fact 保护
Dream 整理 SHALL 保护检索次数 > 100 或信任度 > 0.8 的 fact 不被删除，无论 LLM 是否建议删除。

#### Scenario: 高频/高信任 fact 不被合并删除
- **WHEN** LLM 建议删除 retrieval_count > 100 或 trust_score > 0.8 的 fact
- **THEN** 系统拒绝该删除操作
