## ADDED Requirements

### Requirement: 会话预热注入协议
系统 SHALL 通过 MCP Resource 机制实现会话启动时的自动预热注入，无需 LLM 主动调用 tool。

- 客户端在 session 启动时自动拉取所有 `mnemo://global/*` Resource
- Resource 内容作为 system context 注入，LLM 可直接访问
- 预热注入覆盖 identity/coding_style/tool_pref/workflow/general 全部 5 个分类

#### Scenario: 新会话自动获得全局记忆
- **WHEN** Claude Code 启动新 session
- **THEN** 系统自动拉取 5 个 category Resource，记忆内容出现在 system context 中

#### Scenario: 预热后 LLM 不需要主动 search 即可回答偏好问题
- **WHEN** 用户问 "我喜欢什么编辑器" 且预热 Resource 中包含 "用户偏好 VS Code 编辑器"
- **THEN** LLM 直接从预热 context 回答，无需调用 fact_store(search)

### Requirement: 按需补充查询触发规则
系统 SHALL 定义何时触发补充 fact_store(search) 调用的规则，替代当前"每条消息都搜"的模式。

触发条件（满足任一即触发）：
- 用户消息包含明确的记忆查询意图（"我记得说过""我之前说过""按我的习惯"）
- 用户消息涉及技术选型/工具选择且预热中未覆盖
- 用户显式要求记住新信息（触发 add 而非 search）

不触发条件：
- 纯操作指令（"创建文件""运行测试""git commit"）
- 通用技术问题（"怎么用 Promise""React hooks 语法"）
- 代码审查/解释请求

#### Scenario: 技术选型触发补充查询
- **WHEN** 用户说 "用 React 还是 Vue 开发这个项目" 且预热中无相关偏好
- **THEN** 触发 fact_store(search, query="React Vue 前端框架 偏好")

#### Scenario: 纯操作指令不触发
- **WHEN** 用户说 "运行测试"
- **THEN** 不触发 fact_store(search)，节省 MCP 调用

#### Scenario: 明确记忆查询触发
- **WHEN** 用户说 "我之前说不喜欢什么颜色来着"
- **THEN** 触发 fact_store(search, query="不喜欢 颜色")

### Requirement: 注入协议配置说明
系统 SHALL 在 README 或文档中提供更新后的 CLAUDE.md 规则模板，用户可直接复制使用。

#### Scenario: 用户更新 CLAUDE.md 规则
- **WHEN** 用户按文档更新 CLAUDE.md 中的记忆系统使用规则
- **THEN** 规则 1 从"每条消息都搜"变为"会话预热 + 按需触发"
