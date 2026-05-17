## Context

mnemo-mcp 是纯全局记忆 MCP server，服务于 Claude Code / Codex 等客户端。当前架构：

```
用户消息 → CLAUDE.md 规则触发 fact_store(search) → MCP tool call → FTS5 检索 → 注入 context
```

当前问题：
- **每条消息**都触发一次 search MCP 调用，90%+ 的消息与记忆无关（如"git status""运行测试"）
- 查询直接使用原始用户消息，"帮我重构 auth 模块"中的"帮我""重构"是噪音 token
- FTS/Jaccard 权重固定 0.5/0.5，短查询和长查询用同一套评分
- Category 多样性策略硬性限制每个 category 只取 top1，general 类事实被误伤

事实库现状：70+ 条全局事实，5 个 category（identity/coding_style/tool_pref/workflow/general）。

## Goals / Non-Goals

**Goals:**
- 检索准确率：减少噪音召回，提高 top-K 结果与查询的语义相关性
- 注入效率：将 MCP 调用频率从"每条消息"降至"会话预热 + 按需补充"
- 向后兼容：所有变更对现有 tool 调用接口透明

**Non-Goals:**
- 不引入向量数据库或 embedding 模型（保持零依赖、纯本地运行）
- 不做项目记忆（scope 明确只做全局记忆）
- 不改 MCP 协议本身，只利用现有 Resource + Tool 机制

## Decisions

### D1: MCP Resource 暴露全局记忆

**选择**：为每个 category 注册 MCP Resource URI（`mnemo://global/{category}`），返回该 category 下 trust 排名 top-N 的事实摘要。

**替代方案**：
- A) SessionStart hook 触发 bulk search → 需要客户端支持，且仍有 MCP 调用开销
- B) 静态文件注入 → 无法动态更新

**理由**：MCP Resource 是协议原生的"客户端主动拉取"机制。Claude Code 在 session 启动时自动拉取所有 MCP Resource 并注入 system context。这实现了**零 MCP tool call 的预热注入**——LLM 直接在 system prompt 中看到记忆，不需要主动调 search。

Resource URI 设计：
```
mnemo://global/identity      → identity 类 top-10
mnemo://global/coding_style  → coding_style 类 top-10
mnemo://global/tool_pref     → tool_pref 类 top-10
mnemo://global/workflow      → workflow 类 top-10
mnemo://global/general       → general 类 top-10
```

每个 Resource 返回 JSON 格式，客户端（Claude Code）会自动序列化为文本注入。

### D2: 查询提炼层

**选择**：在 `search()` 入口前加 `refineQuery()` 纯函数，做 token 级过滤。

**提炼策略**：
1. 移除中文虚词（已有 `CN_STOP_WORDS`，复用）
2. 移除动作词（"帮我""看看""做一下""帮我看看"等）
3. 提取实体词（引号内容、大写开头词、书名号内容）
4. 如果提炼后为空（纯操作指令如"运行测试"），返回空查询 → 跳过检索

**不选 LLM-based 查询重写**：引入模型调用成本，违反零依赖原则。

### D3: 动态评分权重

**选择**：根据查询 token 数动态调整 FTS/Jaccard 权重。

```typescript
// 短查询（≤3 token）→ 更依赖 FTS 精确匹配
// 长查询（>3 token）→ 更依赖 Jaccard 语义覆盖
const ftsWeight = tokenCount <= 3 ? 0.7 : 0.3
const jaccardWeight = tokenCount <= 3 ? 0.3 : 0.7
```

**不选机器学习权重**：过重，事实库规模不够训练。

### D4: 多样性策略修复

**选择**：去掉硬性 category-per-top1 限制，改为 relevance score 去重——如果两条事实的 Jaccard 相似度 > 0.7（内容高度重叠），只保留评分高的那条。

**理由**：全局记忆 5 个 category，general 占比通常 > 50%。硬性去重导致 general 只取 1 条，丢掉大量有效记忆。

### D5: 相关性门控

**选择**：在 trust 阈值（0.3）之上增加 relevance score 阈值（0.15）。score < 0.15 的结果不返回。

**理由**：trust 是事实质量的静态指标，relevance 是与当前查询的匹配度。两者必须同时满足。

### D6: 注入协议

**选择**：将 CLAUDE.md 规则 1 从"每条消息都搜"改为：

```
会话启动 → MCP Resource 自动预热（系统层，LLM 不参与）
用户消息 → LLM 判断是否需要补充查询记忆
  ├─ 涉及个人偏好/习惯/工具选择 → search
  ├─ 纯操作/技术问题 → 不查
  └─ 模糊 → 可查可不查（偏向不查）
```

**风险**：LLM 可能判断失误，遗漏该查的场景。但 Resource 预热已经覆盖了高频记忆，遗漏的主要是边缘场景。

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| Resource 预热数据量过大占用 context window | 每个 category 限 top-10，总共 ≤50 条，约 2000 token |
| LLM 判断"不需要查"导致遗漏 | Resource 预热覆盖 80%+ 高频场景；边缘 case 通过 fact_feedback 自然淘汰 |
| 查询提炼过度过滤导致召回不足 | 保留原始查询作为 fallback（提炼为空时用原始查询） |
| 动态权重在中等长度查询时表现不稳定 | token 阈值 3 是经验值，可通过 fact_feedback 数据调优 |
| Content-based 去重（Jaccard > 0.7）可能误判 | 去重只影响 top-K 选择，不影响存储；误判只是多返回一条 |

## Open Questions

- Resource 返回格式：JSON 数组 vs Markdown 文本？Claude Code 如何渲染 MCP Resource 内容？
- 是否需要 `mnemo://global/all` 聚合 Resource，还是 5 个独立 Resource 分别拉取？
- CLAUDE.md 规则变更需要用户手动更新，是否提供自动迁移脚本？
