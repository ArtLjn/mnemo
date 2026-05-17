## 1. 检索层：content-only 改造

- [ ] 1.1 修改 `src/retriever.ts`：matchText 从 `summary ?? content` 改为 `fact.content`，length penalty 基于 content 长度
- [ ] 1.2 修改 `src/server.ts`：toCompactResult 的 display 从 `summary ?? content截断` 改为 `fact.content` 完整返回
- [ ] 1.3 更新 `tests/store.test.ts` 和检索相关测试，验证 display 返回完整 content

## 2. Dream 引擎：合并同主题 fact

- [ ] 2.1 重写 `src/dream-engine.ts` semanticMerge：LLM 判定同主题后，合并多条 fact 的 content 为一条完整 fact（而非只删除）
- [ ] 2.2 合并 prompt 设计：要求 LLM 输出合并后的 content 文本，系统覆写 kept fact 的 content，删除 removed fact
- [ ] 2.3 保留安全保护：trust_score > 0.8 和 retrieval_count > 100 的 fact 不被删除

## 3. Dream 引擎：LLM 精简 content

- [ ] 3.1 重写 `src/dream-engine.ts` smartCompress：从"生成 summary"改为"LLM 精简并覆写 content"
- [ ] 3.2 精简 prompt 设计：强调保留 URL、邮箱、数字、人名等关键实体，去除冗余描述
- [ ] 3.3 超长 content 截断：> 2000 字截断并标注 `[共XXX字，已截断]`，LLM 基于可见部分精简

## 4. Dream pipeline 调整

- [ ] 4.1 修改 `src/store.ts` runDream：pipeline 改为 merge → compress（先合并再精简），移除 reclassify 步骤
- [ ] 4.2 修改 dream report：移除 reclassified 计数（固定为 0），更新 report 字段说明
- [ ] 4.3 保留 LLM 不可用时的 fallback 到规则引擎逻辑

## 5. 修复遗留问题

- [ ] 5.1 修复 `src/store.ts` extractSummary 的 `.` 分割 bug（向后兼容，避免未来 fallback 时仍产生坏 summary）
- [ ] 5.2 清理 retriever.ts 中所有 summary 相关的匹配逻辑

## 6. 测试与发布

- [ ] 6.1 更新 `tests/dream-engine.test.ts`：测试新的 merge（content 合并）和 compress（content 覆写）行为
- [ ] 6.2 更新 `tests/store.test.ts`：dream report 验证、display 返回 content 验证
- [ ] 6.3 运行全量测试 `npm run build && npx vitest run`
- [ ] 6.4 本地 dream 测试：`node dist/dream.js` 验证 merge + compress 实际效果
- [ ] 6.5 更新 package.json 版本，发布 npm
