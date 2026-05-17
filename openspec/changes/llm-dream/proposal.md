## Why

当前 dream cycle 使用硬编码规则（Jaccard 词频合并、关键词重分类、截断压缩），无法理解语义。导致：
- 两条用词不同但语义相同的 fact（如"喜欢VS Code" vs "偏好Visual Studio Code"）永远无法合并
- 分类只靠关键词匹配，容易震荡（同一条 fact 反复换分类）
- 摘要只是截取前两句，不是真正的信息提炼

需要引入 LLM 做语义级别的记忆整理，让 dream 产生实际效果。

## What Changes

- 新增 LLM 客户端抽象层，支持 Ollama（默认）和 OpenAI 兼容 API
- 新增配置系统（`~/.mnemo/config.json`），支持 LLM provider/model/参数配置
- 改造 dream cycle 三个核心任务为 LLM 驱动：
  - **语义合并**：LLM 判断同 category facts 是否语义重复，输出合并建议
  - **智能摘要**：LLM 提取长 fact 的核心信息作为 summary
  - **智能分类**：LLM 判断 general 分类的 fact 应归属哪个 category
- 新增安全验证层（硬编码规则，不经过 LLM）：信任度保护、删除数量上限、备份
- Ollama 不可用时自动降级到当前规则引擎

## Capabilities

### New Capabilities
- `llm-client`: LLM 客户端抽象层，支持 Ollama 和 OpenAI 兼容 API，包含配置加载和健康检查
- `llm-dream-engine`: LLM 驱动的 dream engine，包含语义合并、智能摘要、智能分类三个任务，安全验证层，降级策略

### Modified Capabilities
- `dream-cycle`: runDream() 从纯规则引擎改为调用 LLM dream engine，保留规则引擎作为降级方案

## Impact

- **新增文件**：`src/llm-client.ts`（LLM 客户端）、`src/dream-engine.ts`（LLM dream engine）
- **修改文件**：`src/store.ts`（runDream 集成 dream engine）、`src/types.ts`（新增配置类型）、`src/server.ts`（dream action 传递配置）
- **新增依赖**：无（使用 Node.js 原生 fetch 调用 Ollama/OpenAI API）
- **配置文件**：新增 `~/.mnemo/config.json` 支持可选配置
- **向后兼容**：Ollama 不可用时自动降级到规则引擎，不影响现有用户
