## ADDED Requirements

### Requirement: OpenAI 兼容 LLM 客户端
系统 SHALL 提供统一 LLM 客户端，使用 OpenAI 兼容的 `/v1/chat/completions` 接口。通过配置 baseUrl 支持 Ollama 本地、Ollama 云端（ollama.com/v1）、智谱、DeepSeek 等任何 OpenAI 兼容 API。

#### Scenario: 连接 Ollama 本地
- **WHEN** config.baseUrl 为 "http://localhost:11434/v1"
- **THEN** 系统向 `localhost:11434/v1/chat/completions` 发送请求，无需 apiKey

#### Scenario: 连接 Ollama 云端
- **WHEN** config.baseUrl 为 "https://ollama.com/v1" 且提供 apiKey
- **THEN** 系统向 `ollama.com/v1/chat/completions` 发送请求，附带 Authorization header

#### Scenario: 连接第三方 OpenAI 兼容 API
- **WHEN** config.baseUrl 为 "https://open.bigmodel.cn/api/paas/v4" 且提供 apiKey
- **THEN** 系统向对应 `/chat/completions` 端点发送请求

### Requirement: LLM 聊天接口
系统 SHALL 提供 `chat(messages, options)` 方法，返回 LLM 文本响应。

#### Scenario: 成功调用返回文本
- **WHEN** 调用 chat([{ role: "user", content: "..." }], { temperature: 0.1 })
- **THEN** 系统返回 LLM 生成的文本内容

#### Scenario: 连接失败抛出错误
- **WHEN** LLM 服务不可用（连接拒绝/超时）
- **THEN** 系统抛出 LLMConnectionError，包含原始错误信息

#### Scenario: JSON 响应解析
- **WHEN** LLM 响应内容可解析为 JSON
- **THEN** 系统返回解析后的 JSON 对象

#### Scenario: JSON 解析失败
- **WHEN** LLM 响应不是有效 JSON
- **THEN** 系统抛出 LLMResponseError，包含原始响应文本

### Requirement: LLM 健康检查
系统 SHALL 提供 `isAvailable()` 方法，检测 LLM 服务是否可达。

#### Scenario: 服务可用
- **WHEN** 调用 isAvailable()
- **THEN** 系统向 baseUrl/models 端点发送 GET 请求，成功返回 true

#### Scenario: 服务不可用
- **WHEN** 调用 isAvailable()
- **THEN** 连接失败返回 false，不抛出错误

### Requirement: 配置加载
系统 SHALL 从 `~/.mnemo/config.json` 加载 LLM 配置。文件不存在时使用默认配置。

#### Scenario: 配置文件存在
- **WHEN** `~/.mnemo/config.json` 存在且包含 llm 字段
- **THEN** 系统使用配置文件中的 baseUrl/model/apiKey/temperature

#### Scenario: 配置文件不存在
- **WHEN** `~/.mnemo/config.json` 不存在
- **THEN** 系统使用默认配置：`{ baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", temperature: 0.1 }`
