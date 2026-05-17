## ADDED Requirements

### Requirement: MCP server 启动与工具注册
系统 SHALL 作为 MCP server 通过 stdio transport 运行，注册 `fact_store` 和 `fact_feedback` 两个 tools。

#### Scenario: 正常启动
- **WHEN** 运行 `npx mnemo-mcp` 或 `node dist/server.js`
- **THEN** server 通过 stdio 建立 MCP 连接，注册 fact_store（9 个 action）和 fact_feedback（2 个 action）两个 tools

#### Scenario: 客户端连接
- **WHEN** Claude Code 或 Codex 通过 MCP 配置启动 mnemo-mcp
- **THEN** server 响应 `tools/list` 请求返回两个 tool schema，响应 `tools/call` 请求执行对应操作

### Requirement: 存储路径
系统 SHALL 使用 `~/.mnemo/facts.db` 作为默认存储路径，目录不存在时自动创建。

#### Scenario: 首次运行
- **WHEN** `~/.mnemo/` 目录不存在
- **THEN** server 自动创建目录和数据库文件，执行 schema 初始化

#### Scenario: 数据库已存在
- **WHEN** `~/.mnemo/facts.db` 已存在
- **THEN** server 打开已有数据库，执行增量迁移（如添加新列），不破坏已有数据

### Requirement: 错误处理
系统 SHALL 在 tool 调用失败时返回包含 error 字段的 JSON，不抛出未捕获异常。

#### Scenario: 无效 action
- **WHEN** fact_store 被调用且 action 为未知值
- **THEN** 返回 `{"error": "Unknown action: xxx"}`

#### Scenario: 缺少必需参数
- **WHEN** add action 缺少 content 参数
- **THEN** 返回 `{"error": "Missing required argument: content"}`
