## 1. 存储层：schema 迁移

- [ ] 1.1 `src/store.ts` — 新增 `retrieval_log` 表创建（id, query, results JSON, timestamp）
- [ ] 1.2 `src/store.ts` — `facts` 表 `ALTER TABLE ADD COLUMN summary TEXT DEFAULT NULL`（兼容已有库）
- [ ] 1.3 `src/store.ts` — `facts` 表 `ALTER TABLE ADD COLUMN last_retrieved_at TEXT DEFAULT NULL`
- [ ] 1.4 `src/store.ts` — 重建 FTS5 虚拟表以包含 summary 列
- [ ] 1.5 `src/store.ts` — 新增 `logRetrieval(query, results: [{id, score}])` 方法，写入 retrieval_log + 更新各 fact 的 last_retrieved_at
- [ ] 1.6 `src/store.ts` — 新增 `pruneRetrievalLog(maxEntries=5000)` 方法，超出上限删除最旧记录
- [ ] 1.7 `src/types.ts` — 新增 `RetrievalLogEntry` 类型、`FactStoreArgs` 增加 `summary` 字段、Fact 类型增加 `summary` 和 `last_retrieved_at`

## 2. 检索层：回退 + length penalty + summary

- [ ] 2.1 `src/retriever.ts` — 回退动态权重为静态 `ftsWeight=0.5, jaccardWeight=0.5`
- [ ] 2.2 `src/retriever.ts` — 移除 relevance gate（`RELEVANCE_THRESHOLD` 相关代码）
- [ ] 2.3 `src/retriever.ts` — 评分公式末尾新增 length penalty：`score *= min(1.0, 300 / matchText.length)`，matchText = summary（非空时）或 content
- [ ] 2.4 `src/retriever.ts` — FTS5 候选查询改为优先匹配 summary（非空时用 summary，空时用 content）
- [ ] 2.5 `src/retriever.ts` — Jaccard tokenization 同样优先使用 summary
- [ ] 2.6 `src/retriever.ts` — search() 方法末尾调用 `store.logRetrieval(query, results)` 记录检索日志
- [ ] 2.7 保留 `src/refine.ts` 的 refineQuery（过滤纯操作指令的功能与权重策略无关）

## 3. 自学习层：learn + audit

- [ ] 3.1 `src/store.ts` — 新增 `runLearning()` 方法：遍历所有 fact，按 rate 规则调整 trust_score
  - `retrieval_count > 30 && rate < 0.05` → `trust_score *= 0.9`
  - `retrieval_count > 30 && rate > 0.3` → `trust_score = min(1.0, trust_score + 0.05)`
  - `last_retrieved_at` 超过 60 天 → `trust_score *= 0.95`
  - `last_retrieved_at` 为 NULL（新 fact）→ 不老化
- [ ] 3.2 `src/store.ts` — `runLearning()` 返回 `{promoted, demoted, aged, unchanged, long_facts: [{id, content_length, penalty, has_summary}]}`
- [ ] 3.3 `src/store.ts` — 新增 `runAudit()` 方法：返回数据质量报告（超长无 summary、低 helpful 率、老化候选），不修改数据
- [ ] 3.4 `src/server.ts` — 新增 `fact_store(action="learn")` handler，调用 `store.runLearning()`
- [ ] 3.5 `src/server.ts` — 新增 `fact_store(action="audit")` handler，调用 `store.runAudit()`
- [ ] 3.6 `src/server.ts` — server 启动时通过 `process.nextTick()` 延迟调用 `store.runLearning()`，输出摘要到 stderr

## 4. 写入端：质量控制

- [ ] 4.1 `src/server.ts` — add handler 支持 `summary` 参数，存入 summary 列
- [ ] 4.2 `src/server.ts` — add/update 时 content 长度 > 500 且无 summary → 返回 warnings 提示
- [ ] 4.3 `src/server.ts` — add/update 写操作后调用 `store.pruneRetrievalLog()` 保持日志上限
- [ ] 4.4 `src/server.ts` — update handler 支持 `summary` 参数更新

## 5. 清理：移除 v3 遗留代码

- [ ] 5.1 `src/retriever.ts` — 移除动态权重计算逻辑（`tokenCount <= 3` 判断分支）
- [ ] 5.2 `src/retriever.ts` — 移除 content dedup（Jaccard > 0.7 去重），改为仅 score 排序
- [ ] 5.3 `src/refine.ts` — 保留 refineQuery（过滤纯操作指令），但移除与动态权重的耦合

## 6. 测试 + 验证

- [ ] 6.1 `tests/store.test.ts` — 新增 retrieval_log CRUD 测试（写入、查询、自动清理）
- [ ] 6.2 `tests/store.test.ts` — 新增 summary 列读写测试
- [ ] 6.3 `tests/store.test.ts` — 新增 `runLearning()` 信任调整测试（promote/demote/aging/新 fact 保护）
- [ ] 6.4 `tests/store.test.ts` — 新增 `runAudit()` 测试（返回报告不修改数据）
- [ ] 6.5 `tests/retriever.test.ts` — 新增 length penalty 测试（有/无 summary 两种场景）
- [ ] 6.6 `tests/retriever.test.ts` — 新增 summary 匹配测试（FTS5 + Jaccard 用 summary）
- [ ] 6.7 `tests/retriever.test.ts` — 验证静态权重（不再随查询长度变化）
- [ ] 6.8 端到端验证：`npm run build && npx vitest run`
