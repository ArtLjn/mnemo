## ADDED Requirements

### Requirement: facts table has summary and last_retrieved_at columns
`facts` 表 MUST 包含 `summary TEXT DEFAULT NULL` 和 `last_retrieved_at TEXT DEFAULT NULL` 列。summary 非空时用于检索匹配，为空时退化为 content 匹配。last_retrieved_at 由检索日志写入时自动更新。

#### Scenario: Add fact without summary
- **WHEN** 调用 `fact_store(action="add", content="用户偏好深色主题")`
- **THEN** summary 为 NULL，last_retrieved_at 为 NULL，检索时使用 content

#### Scenario: Add fact with summary
- **WHEN** 调用 `fact_store(action="add", content="...", summary="用户偏好深色主题")`
- **THEN** summary 被存储，检索时优先使用 summary 匹配

### Requirement: Write operation warns on long content without summary（500 字阈值）
当 add/update 的 content 长度超过 500 字且未提供 summary 时，系统 MUST 返回警告提示。

#### Scenario: Long fact without summary triggers warning
- **WHEN** 调用 `fact_store(action="add", content="<600字内容>")` 且未提供 summary
- **THEN** 操作成功，但返回 JSON 包含 `warnings: ["content 超过 500 字，建议提供 summary 或拆分为多条 fact"]`

#### Scenario: Long fact with summary has no warning
- **WHEN** 调用 `fact_store(action="add", content="<600字内容>", summary="核心摘要")`
- **THEN** 操作成功，无长度警告

#### Scenario: 300-500 字 content without summary has no warning
- **WHEN** 调用 `fact_store(action="add", content="<400字内容>")` 且未提供 summary
- **THEN** 操作成功，无警告（300-500 字处于灰色地带，只受 length penalty 影响不受写入警告）

### Requirement: FTS5 indexes summary when present
FTS5 虚拟表 MUST 索引 summary 列。当 summary 非空时，FTS5 使用 summary 进行匹配；summary 为空时使用 content。

#### Scenario: FTS5 matches on summary
- **WHEN** 一条 fact 的 content="很长很长的内容..."（2000字），summary="用户偏好 VS Code"
- **THEN** 搜索 "VS Code" 时能通过 summary 匹配到该 fact

#### Scenario: FTS5 falls back to content when no summary
- **WHEN** 一条 fact 的 summary=NULL，content="用户偏好 VS Code"
- **THEN** 搜索 "VS Code" 时通过 content 匹配到该 fact

### Requirement: Backward compatible migration
ALTER TABLE 为已有数据库添加新列时 MUST 不丢失任何现有数据。

#### Scenario: Existing database gets new columns
- **WHEN** mnemo-mcp 启动且 facts 表没有 summary 或 last_retrieved_at 列
- **THEN** 自动执行 ALTER TABLE 添加缺失列，所有现有 fact 不受影响
