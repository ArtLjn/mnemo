## Why

当前 summary 字段同时承担检索匹配、展示、dream 内部使用三个职责，但 LLM 生成的 summary 质量不稳定（如 30 字残缺摘要丢失关键信息），导致：
1. 检索只用 summary 匹配，丢关键词（如"伊军"不在 summary 中导致搜不到）
2. 展示给 AI 的是残缺 summary，回答不完整
3. `extractSummary` 用 `.` 做句子分割，URL/邮箱被截断

根本问题：summary 不应该参与检索和展示，content 才是唯一数据源。

## What Changes

- **BREAKING**: 检索打分和展示统一使用 content，不再使用 summary
- **BREAKING**: dream 引擎职责简化为「合并同主题 fact」+「LLM 精简 content」，直接覆写 content 而非生成 summary
- 移除 `toCompactResult` 中 summary 优先逻辑，display 直接返回 content
- 移除 retriever 中 `matchText = summary ?? content`，永远用 content
- `smartCompress` 改为 LLM 重写 content（去冗余、保留关键信息、直接覆写）
- `semanticMerge` 改为 LLM 合并同主题 fact 的 content 为一条完整 fact
- 修复 `extractSummary` 的 `.` 分割 bug（向后兼容，旧 summary 不再影响检索）
- summary 字段保留但降级为 dream 内部批量对比用，不对外暴露

## Capabilities

### New Capabilities

- `content-compress`: LLM 直接精简 content 字段，去除冗余保留关键信息，覆写原 content

### Modified Capabilities

- `compact-search`: display 从 summary 优先改为直接返回 content，检索打分使用 content
- `dream-cycle`: dream 职责从「生成 summary + 删除重复 + 分类修正」改为「合并同主题 + 精简 content」

## Impact

- `src/retriever.ts` — matchText 改为 content，移除 summary 依赖
- `src/server.ts` — toCompactResult display 改为 content
- `src/dream-engine.ts` — smartCompress 改为覆写 content，semanticMerge 改为合并 content
- `src/store.ts` — extractSummary 修复 `.` 分割 bug，runDream pipeline 调整
- `tests/dream-engine.test.ts` — 测试用例适配新行为
- `tests/store.test.ts` — 测试用例适配
- 向后兼容：已有 summary 数据保留，但不再影响检索和展示
