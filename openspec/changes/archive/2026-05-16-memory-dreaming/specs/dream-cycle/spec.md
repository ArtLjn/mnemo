## ADDED Requirements

### Requirement: Dream action 整理记忆库
系统 SHALL 提供 `fact_store(action="dream")` 操作，执行三阶段整理：Collect → Consolidate → Evaluate。

#### Scenario: 合并重叠 fact
- **WHEN** 同 category 内两条 fact 的 Jaccard 相似度 > 0.6
- **THEN** 系统保留 content 更长的 fact，将另一条标记删除，并在 dream report 中记录合并对

#### Scenario: 压缩长 fact
- **WHEN** fact 的 content 长度 > 200 字且 summary 为 NULL
- **THEN** 系统从 content 提取前 2 个完整句子（总长 ≤ 150 字）写入 summary 字段

#### Scenario: 分类修正
- **WHEN** fact 的 category 与内容不匹配（如 identity 类 fact 内容包含"编码规范"）
- **THEN** 系统根据关键词规则表将 fact 挪到正确 category

#### Scenario: Dream 前备份
- **WHEN** dream action 被触发
- **THEN** 系统在执行任何修改前，自动将数据库备份到 `~/.mnemo/backup/dream-<timestamp>.db`

#### Scenario: 输出 dream report
- **WHEN** dream 整理完成
- **THEN** 系统返回 JSON 报告，包含 merged、compressed、reclassified、deleted 计数和 health 统计

### Requirement: CLI dream 命令
系统 SHALL 提供 `mnemo dream` CLI 命令，手动触发 dream 整理。

#### Scenario: 手动执行 dream
- **WHEN** 用户运行 `npx mnemo dream` 或 `mnemo dream`
- **THEN** 系统执行完整 dream cycle 并输出 report 到 stdout

### Requirement: 高频 fact 保护
Dream 整理 SHALL 保护检索次数 > 100 的 fact 不被删除。

#### Scenario: 高频 fact 不被合并删除
- **WHEN** 两条 fact 满足合并条件，但其中一条 retrieval_count > 100
- **THEN** 系统保留高频 fact，仅删除另一条低频 fact
