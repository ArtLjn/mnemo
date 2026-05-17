## ADDED Requirements

### Requirement: LLM 语义合并
系统 SHALL 将同 category 的 facts 按每批 20 条送 LLM，由 LLM 判断语义重复并输出合并建议。

#### Scenario: LLM 识别语义重复
- **WHEN** 同 category 内存在两条用词不同但语义相同的 fact（如"喜欢VS Code"和"偏好Visual Studio Code"）
- **THEN** LLM 返回 merge 建议 `{"kept": factId, "removed": factId, "reason": "..."}`，系统执行合并

#### Scenario: LLM 判断不重复
- **WHEN** 同 category 内两条 fact 语义不同
- **THEN** LLM 不输出合并建议，系统不操作

#### Scenario: LLM 输出格式错误
- **WHEN** LLM 返回的 JSON 无法解析或缺少必需字段（kept/removed）
- **THEN** 系统丢弃该批合并建议，不执行任何操作

### Requirement: LLM 智能摘要
系统 SHALL 将 content > 200 字且 summary 为 NULL 的 fact 送 LLM 生成精准摘要。

#### Scenario: LLM 生成摘要
- **WHEN** fact 的 content 长度 > 200 且 summary 为空
- **THEN** LLM 返回 `{"summary": "核心信息..."}`，系统写入 summary 字段，摘要长度 SHALL ≤ 150 字

#### Scenario: 已有摘要跳过
- **WHEN** fact 已有 summary
- **THEN** 系统不发送给 LLM，跳过该 fact

#### Scenario: LLM 摘要超长
- **WHEN** LLM 返回的 summary 长度 > 150 字
- **THEN** 系统截断到 150 字

### Requirement: LLM 智能分类
系统 SHALL 将 category 为 "general" 的 facts 送 LLM 判断正确分类。

#### Scenario: LLM 正确分类
- **WHEN** general 分类中的 fact 内容属于 identity/coding_style/tool_pref/workflow
- **THEN** LLM 返回 `{"fact_id": id, "to": "target_category"}`，系统更新 category

#### Scenario: LLM 判断应保持 general
- **WHEN** fact 内容不属于其他四个 category
- **THEN** LLM 返回 `{"fact_id": id, "to": "general"}`，系统不操作

#### Scenario: LLM 返回无效 category
- **WHEN** LLM 返回的 target 不在 [identity, coding_style, tool_pref, workflow, general] 中
- **THEN** 系统丢弃该分类建议

### Requirement: 安全验证层
系统 SHALL 在执行 LLM 建议的数据库操作前，进行硬编码安全校验。

#### Scenario: 高信任 fact 禁止删除
- **WHEN** LLM 建议删除 trust_score > 0.8 的 fact
- **THEN** 系统拒绝该删除操作

#### Scenario: 单次删除数量限制
- **WHEN** LLM 建议删除的 fact 数量超过总量的 10%
- **THEN** 系统只执行前 10% 的删除，丢弃多余建议

#### Scenario: 高频 fact 保护
- **WHEN** LLM 建议删除 retrieval_count > 100 的 fact
- **THEN** 系统拒绝该删除操作

### Requirement: 降级策略
系统 SHALL 在 LLM 不可用时自动降级到规则引擎。

#### Scenario: Ollama 不可用自动降级
- **WHEN** Ollama 连接失败或超时
- **THEN** 系统自动使用当前硬编码规则引擎执行 dream，report 中标记 `fallback: true`

#### Scenario: 降级后 report 包含 fallback 标记
- **WHEN** dream 执行了降级路径
- **THEN** DreamReport 中 `fallback` 字段为 true，`fallbackReason` 字段记录原因
