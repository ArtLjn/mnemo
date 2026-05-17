## ADDED Requirements

### Requirement: 事实 CRUD
系统 SHALL 支持 add / update / remove / list 四种事实操作，事实以 (content, category, tags, trust_score) 结构存储。

#### Scenario: 添加新事实
- **WHEN** 调用 `fact_store(action="add", content="用户偏好深色主题", category="tool_pref", tags="theme,dark")`
- **THEN** 创建事实记录，返回 `{"fact_id": N, "status": "added", "category": "tool_pref"}`

#### Scenario: 添加重复事实
- **WHEN** 调用 add 时 content 与已有事实精确相同
- **THEN** 返回已有 fact_id，不创建重复记录

#### Scenario: 添加相似事实
- **WHEN** 调用 add 时 content 与已有事实通过三层去重检测（实体重叠+编辑距离 / Jaccard / Containment）判定为相似
- **THEN** 更新已有事实内容，返回 `{"fact_id": N, "status": "updated", "reason": "similar_fact_merged"}`

#### Scenario: 更新事实
- **WHEN** 调用 `fact_store(action="update", fact_id=1, content="新内容", trust_delta=0.1)`
- **THEN** 更新指定事实的字段，重新提取实体

#### Scenario: 删除事实
- **WHEN** 调用 `fact_store(action="remove", fact_id=1)`
- **THEN** 删除事实及其实体关联，清理孤立实体

#### Scenario: 浏览事实
- **WHEN** 调用 `fact_store(action="list", category="identity", min_trust=0.5, limit=10)`
- **THEN** 返回符合条件的事实列表，按 trust_score 降序

### Requirement: 实体自动提取
系统 SHALL 从事实内容中自动提取中英文实体并建立关联图谱。

#### Scenario: 英文实体提取
- **WHEN** 添加内容包含大写首字母词组（如 "Visual Studio Code"）、引号包裹词（如 "TypeScript"）
- **THEN** 提取为实体，创建 entity 记录，关联到事实

#### Scenario: 中文实体提取
- **WHEN** 添加内容包含书名号（如《设计模式》）、引号包裹（如「记忆系统」）、声明模式（如"我叫暖暖"）
- **THEN** 提取为实体，创建 entity 记录

### Requirement: 信任评分系统
系统 SHALL 维护每个事实的 trust_score（0.0~1.0），支持反馈调整和时间衰减。

#### Scenario: 正向反馈
- **WHEN** 调用 `fact_feedback(action="helpful", fact_id=1)`
- **THEN** trust_score += 0.05（上限 1.0），helpful_count += 1

#### Scenario: 负向反馈
- **WHEN** 调用 `fact_feedback(action="unhelpful", fact_id=1)`
- **THEN** trust_score -= 0.10（下限 0.0）

#### Scenario: 时间衰减
- **WHEN** session 启动时执行信任衰减
- **THEN** 超过宽限期的事实按 category 配置的速率衰减，trust_score < 0.1 的自动删除

### Requirement: 矛盾检测
系统 SHALL 在写入新事实时检测同 category 中共享实体但内容冲突的旧事实，自动降权。

#### Scenario: 写入时矛盾降权
- **WHEN** 添加新事实后，同 category 中存在共享实体但编辑距离在 0.2~0.5 区间的旧事实
- **THEN** 旧事实 trust_score -= 0.10

#### Scenario: 启动时矛盾审计
- **WHEN** server 启动时
- **THEN** 扫描所有事实对（实体 JOIN + Jaccard 双层），降权较旧的矛盾事实

### Requirement: 关键词提取
系统 SHALL 从事实内容中自动提取主题关键词，用于检索增强。

#### Scenario: 关键词生成
- **WHEN** 添加或更新事实
- **THEN** 从 content + tags 中提取关键词（位置权重 × 频率 × 类别特异性 × tags 加权），存储为 JSON 数组

### Requirement: 分类固定为 5 个
系统 SHALL 支持固定的 5 个 category：identity / coding_style / tool_pref / workflow / general。

#### Scenario: 使用有效 category
- **WHEN** 调用 add 时 category 为 5 个之一
- **THEN** 正常存储

#### Scenario: 未指定 category
- **WHEN** 调用 add 时未提供 category
- **THEN** 默认为 "general"
