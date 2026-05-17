## ADDED Requirements

### Requirement: 多级 fallback 检索
系统 SHALL 实现 5 级 fallback 检索管线：FTS5 → LIKE → 字符交叉 → 分类推断 → trust fallback。

#### Scenario: FTS5 命中
- **WHEN** 搜索 "用户偏好" 且 FTS5 索引返回匹配结果
- **THEN** 返回 FTS5 候选集，进入 Jaccard + 信任 + 时间衰减重排序

#### Scenario: FTS5 无结果 fallback 到 LIKE
- **WHEN** FTS5 无匹配
- **THEN** 使用 LIKE 模糊匹配（含中文 bigram/trigram 滑动窗口）

#### Scenario: LIKE 无结果 fallback 到字符交叉
- **WHEN** LIKE 也无匹配
- **THEN** 提取查询中文字符，与事实内容做单字交叉匹配（≥40% 命中率）

#### Scenario: 全部无结果 fallback 到 trust
- **WHEN** 所有检索级别都无匹配且查询为个人/身份相关
- **THEN** 按 trust_score 返回 top-N 事实

### Requirement: 检索结果评分
系统 SHALL 对检索结果计算综合评分：FTS 权重 × ftsScore + Jaccard 权重 × (0.20 × Jaccard + 0.45 × Containment + 0.35 × KeywordScore) × trustScore × 时间衰减。

#### Scenario: 评分排序
- **WHEN** 搜索返回多条结果
- **THEN** 按综合评分降序排列

#### Scenario: Category 信号强化
- **WHEN** 查询命中某个 category 的特有 tag
- **THEN** 该 category 的事实获得乘法强化（1 + 0.5 × 集中度 × 归一化信号）

### Requirement: Category 多样性
系统 SHALL 在返回结果中保证 category 多样性，避免同类事实垄断。

#### Scenario: 去重补位
- **WHEN** 返回结果中同一 category 事实过多
- **THEN** 每个 category 优先保留评分最高的，不足 limit 时从原列表补位

### Requirement: 检索追踪
系统 SHALL 追踪检索命中的事实，递增 retrieval_count，top 3 的 trust_score += 0.01 并重置 updated_at。

#### Scenario: 命中追踪
- **WHEN** search 返回结果
- **THEN** 所有返回事实的 retrieval_count += 1，top 3 获得信任微增和时间续命

### Requirement: 高级检索操作
系统 SHALL 支持 probe（实体探测）、related（实体关联）、reason（多实体推理）、contradict（矛盾检测）四种高级操作。

#### Scenario: 实体探测
- **WHEN** 调用 `fact_store(action="probe", entity="TypeScript")`
- **THEN** 返回所有关联 TypeScript 实体的事实

#### Scenario: 实体关联
- **WHEN** 调用 `fact_store(action="related", entity="TypeScript")`
- **THEN** 返回与 TypeScript 共享上下文的其他实体关联的事实（排除原始事实）

#### Scenario: 多实体推理
- **WHEN** 调用 `fact_store(action="reason", entities=["TypeScript", "测试"])`
- **THEN** 返回同时关联两个实体的事实

#### Scenario: 矛盾检测
- **WHEN** 调用 `fact_store(action="contradict")`
- **THEN** 返回高实体重叠 + 低内容相似度的矛盾事实对

### Requirement: 双语查询扩展
系统 SHALL 自动学习中英术语对照，搜索时将查询中的术语翻译为对端语言。

#### Scenario: 中文搜英文
- **WHEN** 搜索 "部署" 且已学习 "部署→deploy" 映射
- **THEN** 查询扩展为 "部署 deploy"，同时命中中英文事实

#### Scenario: 英文搜中文
- **WHEN** 搜索 "cache" 且已学习 "缓存→cache" 映射
- **THEN** 查询扩展为 "cache 缓存"
