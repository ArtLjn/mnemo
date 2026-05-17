## ADDED Requirements

### Requirement: Search operations automatically log retrieval results
每次 `search` 操作 MUST 自动将 query 和返回的 fact 结果写入 `retrieval_log` 表，包含每个 fact 的 id 和 score。

#### Scenario: Search logs query and scored results
- **WHEN** 调用 `fact_store(action="search", query="用户偏好")` 返回 fact_ids [27, 51, 60] 对应 scores [0.45, 0.32, 0.28]
- **THEN** `retrieval_log` 表新增一条记录，query="用户偏好"，results='[{"id":27,"score":0.45},{"id":51,"score":0.32},{"id":60,"score":0.28}]'

#### Scenario: Empty search results are still logged
- **WHEN** 调用 `fact_store(action="search", query="完全不存在的查询")` 返回空结果
- **THEN** `retrieval_log` 表新增一条记录，query="完全不存在的查询"，results="[]"

### Requirement: Retrieval log has a size cap
`retrieval_log` 表 MUST 保留最近 5000 条记录，超出时自动删除最旧记录。

#### Scenario: Auto-prune when exceeding 5000 entries
- **WHEN** `retrieval_log` 已有 5000 条记录，新 search 写入第 5001 条
- **THEN** 最旧的一条记录被删除，总数保持 5000

### Requirement: retrieval_log table schema
系统 MUST 创建以下表结构：
```sql
CREATE TABLE retrieval_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT NOT NULL,
  results    TEXT NOT NULL,
  timestamp  TEXT DEFAULT (datetime('now'))
);
```

#### Scenario: Table exists after database initialization
- **WHEN** mnemo-mcp 启动并打开 `~/.mnemo/facts.db`
- **THEN** `retrieval_log` 表存在且符合上述 schema

### Requirement: logRetrieval updates last_retrieved_at
每次写入 retrieval_log 时 MUST 同步更新返回的每条 fact 的 `last_retrieved_at` 字段。

#### Scenario: last_retrieved_at is updated on retrieval
- **WHEN** 搜索返回 fact_ids [27, 51]
- **THEN** fact 27 和 51 的 `last_retrieved_at` 被更新为当前时间
