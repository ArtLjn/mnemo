## MODIFIED Requirements

### Requirement: 搜索结果精简格式
搜索返回结果 SHALL 返回完整 content 作为 display 字段，不再使用 summary。

#### Scenario: display 返回完整 content
- **WHEN** 搜索结果返回给调用方
- **THEN** display 字段 SHALL 返回 fact 的完整 content，不截断、不使用 summary

#### Scenario: 返回字段结构
- **WHEN** 搜索结果返回给调用方
- **THEN** 每条结果包含 factId、display（完整 content）、category、trustScore、score，不包含 summary、keywords、tags 等冗余字段
