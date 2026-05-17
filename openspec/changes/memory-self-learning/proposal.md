## Why

mnemo-mcp 当前记忆检索准确率不足，根因有三：(1) **数据质量差**——29% 的 fact 超过 500 字，最长 3921 字的"万能条"像黑洞一样吸走所有检索请求（#144 被检索 628 次仅 4 次 helpful，率 0.6%）；(2) **v3 动态权重适得其反**——长查询给 FTS5 只留 30% 权重，把 BM25 的正确排序拉下来了（#60 "暖暖角色设定"FTS5 rank -10.17 排第一，但经 Jaccard 重排后被 #208 挤掉）；(3) **没有反馈闭环**——70 条事实累计检索上万次，fact_feedback 不足 100 次，系统无法自我优化。需要从全生命周期角度治理：数据质量 → 检索策略 → 自学习闭环。

## What Changes

- 回退 v3 动态权重，恢复 v2 静态 FTS/Jaccard 权重（0.5/0.5）
- 新增 **length penalty**：基于实际匹配文本（summary 或 content）长度的惩罚，超长无 summary 的 fact 自动降权
- 新增 **retrieval_log 表**：每次 search 自动记录 query + 每条结果的 `{id, score}`，为自学习和调试提供数据
- 新增 **`learn` action**：基于 rate 规则自动调整 trust_score + 数据质量报告（long_facts 列表）
- 新增 **`audit` action**：数据质量报告（超长无 summary、低 helpful 率、老化候选），不修改数据
- 新增 **summary 字段**：facts 表增加 summary + last_retrieved_at 列，超长 fact 存储提炼后的摘要
- 修改 **content 长度限制**：add/update 时 content 超 500 字且无 summary 返回警告（300-500 字只受 penalty 不警告）
- 移除 v3 的 **relevance gate**（0.15 阈值误杀有用结果）和 **动态权重逻辑**
- 保留 v3 的 **refineQuery**（过滤纯操作指令与权重策略无关）

## Capabilities

### New Capabilities
- `retrieval-log`: 检索日志自动记录，每次 search 写入 query + [{id, score}] + timestamp，同步更新 last_retrieved_at
- `self-learning`: learn action（trust 调整 + 数据质量报告）+ audit action（纯报告不改数据）+ 启动时 nextTick 延迟执行
- `length-penalty`: 基于 matchText（summary 优先于 content）的长度惩罚，有 summary 的 fact 不受 content 长度惩罚
- `fact-summary`: facts 表增加 summary + last_retrieved_at 字段 + 双阈值（300 penalty / 500 warning）

### Modified Capabilities
- `fact-retrieval`: 回退动态权重为静态 0.5/0.5，移除 relevance gate，集成 length penalty 和 summary 匹配，保留 refineQuery

## Impact

- `src/retriever.ts`：回退动态权重，移除 relevance gate，新增 length penalty（基于 matchText），summary 匹配
- `src/store.ts`：新增 retrieval_log 表、facts 表 summary + last_retrieved_at 字段、learn/audit 分析逻辑
- `src/server.ts`：新增 learn/audit action handler、search 时自动写入 retrieval_log、add/update 长度校验、启动 nextTick learn
- `src/types.ts`：新增 RetrievalLog 类型、summary/last_retrieved_at 字段、learn/audit 返回类型
- 数据库：新增 retrieval_log 表、facts 表加 summary + last_retrieved_at 列（ALTER TABLE，向后兼容）
- 向后兼容：所有变更对现有数据透明，summary 为空时退化为原始 content 匹配
