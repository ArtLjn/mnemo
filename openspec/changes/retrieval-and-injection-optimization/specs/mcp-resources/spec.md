## ADDED Requirements

### Requirement: MCP Resource 暴露全局分类记忆
系统 SHALL 为每个全局 category 注册 MCP Resource URI，返回该 category 下按 trust 排序的 top-N 事实摘要。

- URI 格式：`mnemo://global/{category}`，其中 category 为 identity / coding_style / tool_pref / workflow / general
- 每个 Resource 返回该 category 下 trust_score 最高的前 10 条事实
- 返回格式为 JSON 数组，每条包含 fact_id、content、trust_score
- Resource 内容在服务启动时计算并缓存，写操作（add/update/remove）时失效重算

#### Scenario: 客户端拉取 identity Resource
- **WHEN** MCP 客户端请求 `mnemo://global/identity`
- **THEN** 返回 identity category 下 trust_score DESC 排序的前 10 条事实 JSON 数组

#### Scenario: 写操作后 Resource 刷新
- **WHEN** 通过 fact_store 执行 add/update/remove 操作
- **THEN** 所有 Resource 缓存失效，下次拉取时重新从 DB 计算

#### Scenario: 空 category 返回空数组
- **WHEN** 某个 category 下没有任何事实
- **THEN** 对应 Resource 返回空 JSON 数组 `[]`

### Requirement: MCP Resource 列表发现
系统 SHALL 在 MCP `resources/list` 响应中暴露所有 5 个全局 category Resource，包含 name 和 description。

#### Scenario: 客户端发现可用 Resource
- **WHEN** MCP 客户端调用 `resources/list`
- **THEN** 响应包含 5 个 Resource 条目，每个的 URI 为 `mnemo://global/{category}`，name 为分类名，description 说明内容

### Requirement: Resource 缓存生命周期
系统 SHALL 维护 Resource 缓存，避免每次拉取都查询数据库。

- 缓存类型：进程内 Map，key 为 category
- 缓存失效：任何写操作（add/update/remove）触发全部缓存清空
- 首次访问时惰性计算

#### Scenario: 连续拉取命中缓存
- **WHEN** 短时间内连续两次拉取同一 category Resource，中间无写操作
- **THEN** 第二次直接返回缓存结果，不触发 DB 查询
