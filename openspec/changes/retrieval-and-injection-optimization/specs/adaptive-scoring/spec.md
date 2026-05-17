## ADDED Requirements

### Requirement: 查询长度自适应权重
系统 SHALL 根据查询 token 数动态调整 FTS 和 Jaccard 的权重比例。

- 短查询（token 数 ≤ 3）：FTS 权重 0.7，Jaccard 权重 0.3（偏精确匹配）
- 长查询（token 数 > 3）：FTS 权重 0.3，Jaccard 权重 0.7（偏语义覆盖）

#### Scenario: 短查询使用高 FTS 权重
- **WHEN** 查询为 "深色主题"（2 个 token）
- **THEN** 评分公式中 FTS 权重为 0.7，Jaccard 权重为 0.3

#### Scenario: 长查询使用高 Jaccard 权重
- **WHEN** 查询为 "为什么 TypeScript 编译报错找不到模块"（7 个 token）
- **THEN** 评分公式中 FTS 权重为 0.3，Jaccard 权重为 0.7

### Requirement: 相关性评分门控
系统 SHALL 在 trust 阈值之上增加 relevance score 阈值。综合评分（relevance × trustScore × temporalDecay）低于 0.15 的结果 SHALL 被过滤。

#### Scenario: 低相关性结果被过滤
- **WHEN** 一条事实 trust_score=0.9 但与查询的 relevance score=0.1
- **THEN** 综合评分 = 0.1 × 0.9 = 0.09 < 0.15，该结果不返回

#### Scenario: 高相关性结果通过
- **WHEN** 一条事实 trust_score=0.4 且与查询的 relevance score=0.8
- **THEN** 综合评分 = 0.8 × 0.4 = 0.32 > 0.15，该结果正常返回

### Requirement: 内容相似度去重
系统 SHALL 对检索结果中内容高度重叠的事实进行去重——两条事实的 Jaccard 相似度 > 0.7 时，只保留评分高的那条。

替换现有的 category-per-top1 硬性去重策略。

#### Scenario: 相似事实去重
- **WHEN** 检索结果中有两条事实内容 Jaccard 相似度 > 0.7
- **THEN** 只保留评分高的那条，另一条被移除

#### Scenario: 不同 category 的不同事实不被误去重
- **WHEN** 一条 identity 事实和一条 coding_style 事实内容不相似（Jaccard < 0.7）
- **THEN** 两者都保留在结果中

#### Scenario: general 类允许返回多条
- **WHEN** general category 有 5 条高相关性事实且内容不重复
- **THEN** 5 条都保留在结果中（不再受 category-per-top1 限制）
