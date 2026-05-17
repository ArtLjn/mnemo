## 1. 类型定义与配置

- [ ] 1.1 在 `src/types.ts` 新增 LLM 相关类型：LLMConfig（baseUrl/model/apiKey/temperature）、LLMMessage（role/content）、DreamReport 新增 fallback/fallbackReason 字段
- [ ] 1.2 新增 `src/config.ts`：loadConfig() 函数，从 `~/.mnemo/config.json` 读取配置，文件不存在时返回默认值（localhost:11434/v1, qwen3:8b, temperature 0.1）

## 2. LLM 客户端

- [ ] 2.1 新增 `src/llm-client.ts`：实现 OpenAI 兼容 `/v1/chat/completions` 客户端，包含 chat(messages, options) 和 isAvailable() 方法
- [ ] 2.2 chat() 方法：POST 请求到 baseUrl/chat/completions，解析 choices[0].message.content，支持 JSON 响应提取
- [ ] 2.3 isAvailable() 方法：GET baseUrl/models，成功返回 true，失败返回 false（不抛错）
- [ ] 2.4 错误处理：LLMConnectionError（连接失败）、LLMResponseError（响应解析失败）

## 3. LLM Dream Engine

- [ ] 3.1 新增 `src/dream-engine.ts`：DreamEngine 类，接收 LLMClient 和 MemoryStore 实例
- [ ] 3.2 实现 llmSemanticMerge(category, facts)：将同 category 的 facts 按每批 20 条送 LLM，prompt 要求输出 JSON 格式的合并建议，解析后返回操作列表
- [ ] 3.3 实现 llmSmartCompress(facts)：将长 fact（content > 200, summary 为空）送 LLM 生成摘要，返回摘要操作列表
- [ ] 3.4 实现 llmSmartReclassify(facts)：将 general 分类的 facts 送 LLM 判断正确分类，返回分类操作列表
- [ ] 3.5 实现安全验证层 validateOperations(operations, totalFacts)：过滤掉 trust_score > 0.8、retrieval_count > 100 的删除操作，限制删除总数 ≤ 10%
- [ ] 3.6 实现降级逻辑：LLM 不可用时（isAvailable() 返回 false 或 chat 抛错），调用现有规则引擎方法

## 4. 集成到 Dream Cycle

- [ ] 4.1 修改 `src/store.ts` 的 runDream()：加载配置 → 创建 LLMClient → 创建 DreamEngine → 优先 LLM 整理 → 降级规则引擎
- [ ] 4.2 修改 `src/server.ts` 的 dream action：传递配置，处理 fallback 标记
- [ ] 4.3 修改 `src/dream.ts` CLI：确保 CLI 也使用新的 dream engine

## 5. 测试

- [ ] 5.1 新增 `tests/llm-client.test.ts`：测试 chat() 成功/失败/JSON 解析、isAvailable() 可用/不可用
- [ ] 5.2 新增 `tests/dream-engine.test.ts`：测试语义合并/智能摘要/智能分类（mock LLM 响应）、安全验证层、降级策略
- [ ] 5.3 更新 `tests/store.test.ts`：dream 测试用例适配新的 DreamReport 字段（fallback/fallbackReason）
