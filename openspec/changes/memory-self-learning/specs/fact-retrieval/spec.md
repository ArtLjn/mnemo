## MODIFIED Requirements

### Requirement: Static FTS/Jaccard weighting
检索评分 MUST 使用静态权重 FTS 0.5 / Jaccard 0.5，不再根据查询长度动态调整。

#### Scenario: Short query uses static weights
- **WHEN** 搜索 "深色主题"（2个token）
- **THEN** 评分使用 ftsWeight=0.5, jaccardWeight=0.5（不再是 0.7/0.3）

#### Scenario: Long query uses same static weights
- **WHEN** 搜索 "为什么 TypeScript 编译报错找不到模块"（8个token）
- **THEN** 评分使用 ftsWeight=0.5, jaccardWeight=0.5（不再是 0.3/0.7）

## REMOVED Requirements

### Requirement: Relevance gate threshold
**Reason**: 0.15 阈值在短查询时误杀相关结果，length penalty 能更优雅地解决低质量问题
**Migration**: 评分结果不再被 relevance gate 过滤，length penalty 自动惩罚低质量匹配

### Requirement: Dynamic scoring weights based on query length
**Reason**: 动态权重（短查询 FTS 0.7/长查询 0.3）实测降低检索准确率，BM25 正确排序被 Jaccard 覆盖
**Migration**: 所有查询统一使用静态 FTS 0.5 / Jaccard 0.5

## ADDED Requirements

### Requirement: Retrieval uses summary for matching when available
当 fact 的 summary 非空时，检索管线 MUST 使用 summary 进行 FTS5 和 Jaccard 匹配，而非 content。

#### Scenario: Search matches on summary
- **WHEN** 搜索 "VS Code" 且一条 fact 的 summary="用户偏好 VS Code"
- **THEN** FTS5 和 Jaccard 使用 summary 文本计算匹配度

#### Scenario: Returned results include full content
- **WHEN** 搜索返回一条 fact（summary 非空）
- **THEN** 返回的 JSON 中 content 字段为完整原始内容，summary 字段为摘要
