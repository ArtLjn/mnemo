## ADDED Requirements

### Requirement: LLM 精简 content
系统 SHALL 在 dream 周期中，由 LLM 对冗长的 content 进行精简，直接覆写 content 字段。

#### Scenario: 精简长 content
- **WHEN** fact 的 content 长度 > 200 字
- **THEN** LLM 重写 content，去除冗余描述和过程细节，保留关键信息（谁/什么/数据/决策/URL/邮箱），精简后直接 UPDATE content 字段

#### Scenario: 精简后信息完整性
- **WHEN** LLM 精简 content
- **THEN** 精简后 content SHALL 保留原文中的所有 URL、邮箱地址、数字数据、人名等关键实体

#### Scenario: 超长 content 分批处理
- **WHEN** 单条 content 长度 > 2000 字
- **THEN** 截断到 2000 字并标注 `[共XXX字，已截断]` 后喂给 LLM，LLM 基于可见部分精简

#### Scenario: 批量处理
- **WHEN** 有多条 fact 需要精简
- **THEN** 每批 20 条 fact，一次性提交给 LLM 处理，减少 API 调用次数

#### Scenario: LLM 不可用时跳过
- **WHEN** LLM 服务不可用（连接失败或超时）
- **THEN** 跳过精简步骤，content 保持不变，report 中标记 fallback
