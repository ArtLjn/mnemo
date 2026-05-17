## ADDED Requirements

### Requirement: learn action adjusts trust scores automatically
系统 SHALL 提供 `fact_store(action="learn")` 操作，基于检索日志统计自动调整各 fact 的 trust_score。

#### Scenario: High retrieval low helpful fact gets demoted
- **WHEN** 调用 `fact_store(action="learn")` 且某 fact 的 retrieval_count=100, helpful_count=2 (rate=2%)
- **THEN** 该 fact 的 trust_score 被乘以 0.9

#### Scenario: High helpful rate fact gets promoted
- **WHEN** 调用 `fact_store(action="learn")` 且某 fact 的 retrieval_count=50, helpful_count=20 (rate=40%)
- **THEN** 该 fact 的 trust_score 增加 0.05（上限 1.0）

#### Scenario: Low retrieval count facts are not adjusted
- **WHEN** 调用 `fact_store(action="learn")` 且某 fact 的 retrieval_count=10
- **THEN** 该 fact 的 trust_score 不受 rate 规则影响（低于 30 次阈值）

### Requirement: learn action applies aging decay based on last_retrieved_at
系统 MUST 对 `last_retrieved_at` 超过 60 天的 fact 施加老化衰减，trust_score 乘以 0.95。

#### Scenario: Stale fact gets aged
- **WHEN** 调用 `fact_store(action="learn")` 且某 fact 的 last_retrieved_at 在 61 天前
- **THEN** 该 fact 的 trust_score 被乘以 0.95

#### Scenario: Recently retrieved fact is not aged
- **WHEN** 调用 `fact_store(action="learn")` 且某 fact 的 last_retrieved_at 在 10 天前
- **THEN** 该 fact 不受老化规则影响

#### Scenario: Never retrieved fact gets aged
- **WHEN** 调用 `fact_store(action="learn")` 且某 fact 的 last_retrieved_at 为 NULL
- **THEN** 该 fact 被视为从未检索，不受老化规则影响（新 fact 保护期）

### Requirement: learn returns adjustment summary with quality report
`learn` action MUST 返回调整摘要，包含被调整的 fact 数量、方向以及数据质量报告。

#### Scenario: Learn returns summary with long_facts report
- **WHEN** 调用 `fact_store(action="learn")`
- **THEN** 返回 JSON 包含：
```json
{
  "promoted": 2,
  "demoted": 5,
  "aged": 3,
  "unchanged": 60,
  "long_facts": [
    {"id": 144, "content_length": 3921, "penalty": 0.077, "has_summary": false},
    {"id": 169, "content_length": 3095, "penalty": 0.097, "has_summary": false}
  ]
}
```

### Requirement: Server startup triggers learn with non-blocking delay
mnemo-mcp 启动时 MUST 通过 `process.nextTick()` 延迟执行 learn，不阻塞 MCP stdio 握手。

#### Scenario: Learn runs after MCP handshake
- **WHEN** mnemo-mcp server 启动完成 MCP 初始化
- **THEN** 在下一个事件循环中自动执行 learn 并输出调整摘要到 stderr

### Requirement: audit action returns data quality report
系统 SHALL 提供 `fact_store(action="audit")` 操作，返回完整数据质量报告，不修改任何数据。

#### Scenario: Audit returns quality report
- **WHEN** 调用 `fact_store(action="audit")`
- **THEN** 返回 JSON 包含：超长 fact 列表（>500字无 summary）、低 helpful 率 fact（rate<5%且retrieval>30）、老化候选（>60天未检索）、总统计

#### Scenario: Audit does not modify data
- **WHEN** 调用 `fact_store(action="audit")`
- **THEN** 不修改任何 fact 的 trust_score、retrieval_count 或其他字段
