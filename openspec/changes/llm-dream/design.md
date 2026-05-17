## Context

mnemo-mcp 是一个 SQLite 驱动的记忆管理 MCP 服务器，当前 dream cycle 通过硬编码规则（Jaccard 词频、关键词匹配、截断压缩）整理记忆。用户有 71 条事实，规则引擎几乎不产生效果（merge=0, compress=0, reclassified=反复震荡）。

用户本地有 Ollama（HomeUbuntu 上运行 qwen3:8b 等），也有云端 API（智谱/DeepSeek/Kimi）。触发方式保持手动（CLI `mnemo-dream` 或 MCP `dream` action）。

## Goals / Non-Goals

**Goals:**
- LLM 理解语义后做合并、摘要、分类，产生实际可感知的整理效果
- 本地优先：默认 Ollama，零成本
- 云端可插拔：支持 OpenAI 兼容 API（智谱/DeepSeek/Kimi 等）
- 安全：硬编码安全层保护高信任/高频 fact
- 降级：LLM 不可用时回退到规则引擎

**Non-Goals:**
- 自动定时触发（保持手动触发）
- 流式输出 / 进度回调
- 多轮对话式确认（全自动，触发即执行）
- 训练/微调模型

## Decisions

### Decision 1: 统一使用 OpenAI 兼容 `/v1/chat/completions` 接口

**选择**: 只实现一个 OpenAI 兼容客户端。Ollama 本地（localhost:11434/v1）和 Ollama 云端（ollama.com/v1）以及所有国产模型 API（智谱/DeepSeek/Kimi）都走 `/v1/chat/completions`

**备选**: 分别实现 Ollama 原生 API（/api/chat）和 OpenAI API 两个客户端

**理由**:
- Ollama 已原生支持 OpenAI 兼容接口（`/v1/chat/completions`）
- 用户可配置 baseUrl 指向：本地 Ollama / ollama.com / 智谱 / DeepSeek / 任意 OpenAI 兼容 API
- 只需一个客户端实现，零 SDK 依赖，用 Node.js 原生 `fetch()`
- 配置示例：`{ baseUrl: "http://localhost:11434/v1" }` 或 `{ baseUrl: "https://ollama.com/v1", apiKey: "..." }`

### Decision 2: 批量处理，每批 20 条 fact 送 LLM

**选择**: 同 category 的 facts 按每批 20 条分组，一次性送 LLM 分析

**备选**: 逐条送 LLM / 全部一次性送

**理由**:
- 逐条：token 浪费（每次都传 system prompt），延迟高
- 全部一次：71 条 fact 的 content 总长约 40K 字，超出小模型上下文
- 每批 20 条：约 5-10K 字 input，适合 8B 模型（如 qwen3:8b 的 32K 上下文）

### Decision 3: 配置文件可选，无配置时用默认值

**选择**: `~/.mnemo/config.json` 为可选文件。不存在时默认 `ollama/localhost:11434/qwen3:8b`

**备选**: 必须配置才能使用 LLM dream

**理由**:
- 用户 HomeUbuntu 上已有 Ollama 运行，开箱即用
- 零配置降低使用门槛
- macOS 本地无 Ollama 时自动降级到规则引擎

### Decision 4: 安全层在 LLM 输出之后、数据库操作之前执行

**选择**: LLM 返回操作建议 → 安全层校验（信任度/数量/格式） → 执行数据库操作

**备选**: 在 LLM prompt 中加入安全约束

**理由**:
- LLM 可能不遵守 prompt 约束（尤其是小模型）
- 安全长用硬编码 TypeScript 保证不会误删
- 职责分离：LLM 负责理解语义，代码负责安全边界

### Decision 5: Prompt 用中文，适配中文记忆内容

**选择**: 所有 LLM prompt 使用中文指令

**理由**:
- mnemo 的 fact 内容主要是中文
- 中文 prompt 对中文内容的理解更准确
- qwen3 对中文支持好

## Risks / Trade-offs

- **[小模型幻觉风险]** qwen3:8b 可能输出格式错误的 JSON → 用 try-catch 解析，解析失败丢弃该批结果，降级到规则引擎处理该批
- **[Ollama 连接失败]** 用户本地未启动 Ollama → 自动降级到规则引擎，dream report 中标记 `fallback: true`
- **[Token 成本]** 使用云端 API 时每次 dream 消耗 token → 配置中可设 provider，默认 Ollama 零成本
- **[删除误伤]** LLM 可能错误判断"语义重复" → 安全层限制：单次最多删除 10% fact，信任度 > 0.8 禁止删除
- **[处理速度]** 71 条 fact 批量送 LLM，每批 20 条约 3 批，总耗时 10-30 秒（取决于模型速度） → 可接受，dream 本就不频繁
