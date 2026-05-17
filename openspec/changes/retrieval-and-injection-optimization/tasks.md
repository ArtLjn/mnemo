## 1. MCP Resource 注册与缓存

- [ ] 1.1 在 `src/server.ts` 中注册 5 个 MCP Resource URI（`mnemo://global/{identity,coding_style,tool_pref,workflow,general}`），每个 Resource 返回对应 category 的 top-10 事实 JSON 数组
- [ ] 1.2 实现 Resource 缓存层：进程内 Map，写操作时清空，首次访问惰性计算
- [ ] 1.3 在 `resources/list` 响应中暴露所有 5 个 Resource 条目（含 name + description）
- [ ] 1.4 验证：启动 server 后用 MCP Inspector 拉取 Resource 确认返回格式正确

## 2. 查询提炼层

- [ ] 2.1 在 `src/retriever.ts` 中实现 `refineQuery(rawQuery: string): string | null` 纯函数，过滤虚词 + 动作词 + 提取高信号 token
- [ ] 2.2 修改 `search()` 入口：先调 refineQuery()，返回 null 时直接返回空结果；返回非空时用提炼结果作为查询词
- [ ] 2.3 保留原始查询 fallback：当用户显式调用 search action（非自动触发）时，即使 refineQuery 返回 null 也用原始查询
- [ ] 2.4 验证：测试 "帮我用 TypeScript 重构 auth 模块" → 提炼出 "TypeScript auth"；"运行测试" → 返回 null

## 3. 动态评分权重

- [ ] 3.1 修改 `search()` 中的评分公式：根据 query token 数动态设置 ftsWeight/jaccardWeight（≤3 token → 0.7/0.3，>3 → 0.3/0.7）
- [ ] 3.2 新增 relevance score 阈值门控：综合评分 < 0.15 的结果不返回
- [ ] 3.3 替换 category-per-top1 硬性去重为 Jaccard 相似度去重（> 0.7 的只保留高分）
- [ ] 3.4 验证：general 类多条不同事实可以同时出现在结果中

## 4. 注入协议文档

- [ ] 4.1 编写更新后的 CLAUDE.md 记忆系统使用规则模板（会话预热 + 按需触发 + 写入/反馈规则）
- [ ] 4.2 更新 README.md 添加注入协议说明和 CLAUDE.md 规则配置示例
- [ ] 4.3 验证：按新规则配置 CLAUDE.md 后启动 session，确认 Resource 自动拉取且无需每条消息都调 search

## 5. 集成测试

- [ ] 5.1 编写 `tests/resource.test.ts`：验证 Resource 返回格式、缓存命中、写操作后缓存失效
- [ ] 5.2 编写 `tests/refine.test.ts`：验证查询提炼的虚词过滤、动作词剥离、null 返回场景
- [ ] 5.3 更新 `tests/retriever.test.ts`：验证动态权重、relevance 门控、Jaccard 去重
- [ ] 5.4 运行全量测试 `npm run test` 确认无回归
