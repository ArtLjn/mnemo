## ADDED Requirements

### Requirement: 搜索结果精简格式
搜索返回结果 SHALL 优先返回 summary 而非完整 content，减少 token 消耗。

#### Scenario: 有 summary 的 fact
- **WHEN** 搜索结果中的 fact 有 summary 字段且非空
- **THEN** 返回 summary 作为 display 字段，不返回完整 content

#### Scenario: 无 summary 的 fact
- **WHEN** 搜索结果中的 fact 的 summary 为 NULL
- **THEN** 返回 content 前 100 字 + "..." 作为 display 字段

#### Scenario: 返回字段精简
- **WHEN** 搜索结果返回给调用方
- **THEN** 每条结果包含 factId、display（精简内容）、category、trustScore、score，不包含完整 content、keywords、tags 等冗余字段
