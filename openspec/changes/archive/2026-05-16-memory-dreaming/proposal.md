## Why

mnemo 的记忆库随着长期使用会积累大量冗余、重叠、过长的 fact，导致检索精度下降、token 浪费。当前 `runLearning()` 只调 trust 分，不整理内容。需要一套后台自动整理机制（类似 OpenClaw Dreaming），定期合并去重、压缩摘要、分类修正，保持数据库精炼。

## What Changes

- 新增 `dream` action（`fact_store(action="dream")`），执行三阶段整理：Collect → Consolidate → Evaluate
- 新增 `mnemo dream` CLI 命令，支持 cron 定时触发
- 合并 Jaccard > 0.6 的重叠 fact（保留最完整的，其余删除）
- 长 fact（content > 200 字且无 summary）自动提取关键句生成 summary
- 分类自动修正：按关键词规则将误分类的 fact 挪到正确 category
- 输出 dream report：合并/删除/压缩了什么，健康评分多少
- 搜索结果精简格式：返回 summary（优先）或 content 前 100 字，减少 token 消耗

## Capabilities

### New Capabilities
- `dream-cycle`: 后台定期整理记忆库（合并去重、摘要压缩、分类修正、健康评分）
- `compact-search`: 搜索结果精简格式（summary 优先、content 截断、限制条数）

### Modified Capabilities

（无已有 spec 需要修改）

## Impact

- `src/store.ts` — 新增 `runDream()` 方法（合并、压缩、分类修正、报告）
- `src/retriever.ts` — 搜索结果格式精简（返回 summary 而非完整 content）
- `src/server.ts` — `fact_store` 新增 `dream` action
- `src/init.ts` — `mnemo init` 可选配置 cron 定时 dream
- `tests/store.test.ts` — dream 相关测试
- 数据库 — dream 可能删除/合并 fact，不可逆操作需谨慎
