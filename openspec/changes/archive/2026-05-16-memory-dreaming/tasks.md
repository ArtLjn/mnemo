## 1. 搜索结果精简

- [ ] 1.1 修改 `ScoredFact` 类型定义，新增 `display` 字段（精简内容）
- [ ] 1.2 修改 `retriever.ts` search 方法：有 summary 用 summary，无 summary 截取 content 前 100 字
- [ ] 1.3 修改 `server.ts` search/probe/related/reason 响应格式：返回 display 而非完整 content
- [ ] 1.4 更新 `tests/retriever.test.ts` 验证精简格式

## 2. Dream Cycle - Store 层

- [ ] 2.1 实现 `mergeOverlappingFacts()` — 同 category 内 Jaccard > 0.6 的 fact 合并，高频（retrieval > 100）保护
- [ ] 2.2 实现 `compressLongFacts()` — content > 200 字且无 summary 的 fact 自动提取前 2 句
- [ ] 2.3 实现 `reclassifyFacts()` — 按关键词规则表修正 category
- [ ] 2.4 实现 `backupDatabase()` — dream 前备份到 `~/.mnemo/backup/dream-<timestamp>.db`
- [ ] 2.5 实现 `runDream()` — 编排以上步骤，生成 dream report（merged/compressed/reclassified/deleted + health）
- [ ] 2.6 新增 `dream` action 到 `server.ts` 的 fact_store handler

## 3. CLI 命令

- [ ] 3.1 新增 `src/dream.ts` CLI 入口，执行 `store.runDream()` 并输出 report
- [ ] 3.2 在 `package.json` 添加 `mnemo dream` bin 入口

## 4. 测试

- [ ] 4.1 `tests/store.test.ts` — mergeOverlappingFacts 合并 + 高频保护测试
- [ ] 4.2 `tests/store.test.ts` — compressLongFacts 提取 summary 测试
- [ ] 4.3 `tests/store.test.ts` — reclassifyFacts 分类修正测试
- [ ] 4.4 `tests/store.test.ts` — runDream 端到端测试（备份数据库 + 整理 + report）
