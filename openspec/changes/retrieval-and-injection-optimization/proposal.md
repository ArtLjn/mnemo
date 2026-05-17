## Why

mnemo-mcp 作为纯全局记忆系统（不含项目记忆），当前检索和注入机制存在两个核心问题：**检索准确率不足**（查询直接用原始用户消息、评分权重静态固定、category 多样性策略误伤高密度类），以及**注入成本过高**（CLAUDE.md 规则要求每条用户消息都触发一次 `fact_store(search)` MCP 调用，即使消息与记忆完全无关）。随着事实库增长到 70+ 条，这两个问题将导致噪音召回增加和 token 浪费加剧。

## What Changes

- 新增 **MCP Resource** 端点，暴露 5 个全局 category 的 top-N 高信任记忆，实现会话启动时零成本预热注入
- 新增**查询提炼层**（query refinement），从用户消息中提取记忆相关关键词，过滤动作词和无关 token
- **评分公式动态化**：根据查询长度和类型自适应调整 FTS/Jaccard 权重比例
- **注入时机重构**：从"每条消息都搜"改为"MCP Resource 预热 + 按需补充"，需配合 CLAUDE.md 规则变更
- 修复 **category 多样性策略**：对高密度 category（如 general）允许多条入选，改为基于相关性去重而非硬性 category 去重
- 新增**相关性门控**：检索结果在 trust 阈值之上增加 relevance score 阈值过滤

## Capabilities

### New Capabilities
- `mcp-resources`: 通过 MCP Resource 协议暴露全局记忆，支持会话预热零调用注入
- `query-refinement`: 用户消息 → 记忆关键词提炼，过滤动作词/虚词/无关 token
- `adaptive-scoring`: 查询长度自适应的 FTS/Jaccard 权重分配 + relevance 门控
- `injection-protocol`: 优化后的注入协议定义（何时查、何时注入、何时跳过），需同步更新 CLAUDE.md 规则

### Modified Capabilities
<!-- 无既有 spec 需要修改 -->

## Impact

- `src/server.ts`：新增 Resource handler，修改 search 入口加查询提炼
- `src/retriever.ts`：评分公式动态化、多样性策略修复、relevance 门控
- `CLAUDE.md`（用户侧配置）：规则 1 从"每条消息都搜"改为"会话预热 + 按需触发"
- 向后兼容：所有变更对现有 fact_store/fact_feedback tool 调用透明，不影响已有客户端
