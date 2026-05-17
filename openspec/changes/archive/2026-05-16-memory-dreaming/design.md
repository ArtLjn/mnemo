## Context

mnemo-mcp 是一个基于 SQLite + FTS5 的结构化事实记忆系统。长期使用后，fact 库会出现以下问题：
- 多条 fact 内容重叠（如 5 条 Python 编码规范偏好，内容有交叉）
- 单条 fact 过长（超 500 字的"万能条"，占 token、降低检索精度）
- 分类错误（identity 类里混了 workflow 内容）
- trust 评分不准确（`runLearning` 只看 feedback rate，忽略高频检索信号）

当前 `runLearning()` 仅调 trust 分，`runAudit()` 只读不改。没有内容层面的整理能力。

## Goals / Non-Goals

**Goals:**
- 定期自动整理 fact 库：合并重叠、压缩长文、修正分类
- 整理后搜索结果更精准、token 消耗更少
- 支持 CLI 命令 `mnemo dream` 手动触发，也支持 cron 定时
- 整理操作安全：合并前确认、可回滚

**Non-Goals:**
- 不做 AI 生成 summary（用规则提取关键句，不调 LLM）
- 不做跨项目记忆迁移
- 不做可视化 dashboard
- 不改变 MCP Resource 注入方式

## Decisions

### 1. 合并策略：Jaccard 相似度 > 0.6 且同 category

用现有的 `tokenizeForDedup()` + `jaccardSimilarity()` 计算两两相似度。同 category 内 Jaccard > 0.6 的 fact 对，合并为一条（保留 content 更长或 trust 更高的，删除另一条）。

**不跨 category 合并**：不同 category 的 fact 即使内容相似也保留（可能是不同语境）。

### 2. 长文压缩：规则提取关键句

content > 200 字且无 summary 的 fact，自动提取前 2 个完整句子作为 summary。不调 LLM，纯规则：
- 按中文句号（。）、英文句号（.）、换行符分割
- 取前 2 个句子（总长 ≤ 150 字）

### 3. 分类修正：关键词规则表

硬编码规则表，dream 时扫描并修正：
- 包含"角色设定/暖暖/身份" → identity
- 包含"编码规范/代码风格/pytest" → coding_style
- 包含"工作流/OpenSpec/工作流" → workflow
- 包含"偏好/VS Code/编辑器" → tool_pref

### 4. Dream report 输出格式

```
{
  merged: 3,
  compressed: 5,
  reclassified: 2,
  deleted: 4,
  health: { total: 65, avg_trust: 0.62, avg_length: 180, coverage: { identity: 8, coding_style: 12, ... } }
}
```

### 5. 搜索结果精简

`search` 返回时：
- 有 summary → 返回 summary
- 无 summary → 返回 content 前 100 字 + "..."
- 始终返回 factId、category、trustScore、score
- 不返回完整 content（减少 token）

## Risks / Trade-offs

- **[误合并]** → Jaccard > 0.6 可能误判相似内容。缓解：合并前 log 记录，dream report 列出所有合并对
- **[summary 质量低]** → 规则提取的前 2 句可能不是最关键的。缓解：用户可手动 update summary
- **[不可逆删除]** → 合并后删除冗余 fact 是不可逆的。缓解：dream 前自动备份数据库
