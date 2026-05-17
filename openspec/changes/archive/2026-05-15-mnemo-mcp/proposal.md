## Why

Ocean CLI 内置了一套结构化事实记忆系统（SQLite + FTS5），具备信任评分、实体图谱、矛盾检测、双语检索等能力。这套系统完全独立于 Ocean CLI 的业务逻辑，但被耦合在代码中，无法被其他 AI 编程工具（Codex、Cursor 等）复用。需要将其提取为独立的 MCP server，让团队成员在任意 AI 编程工具中使用同一套个人记忆。

## What Changes

- 新建独立项目 `mnemo-mcp`，从 Ocean CLI 移植核心记忆逻辑
- 砍掉编排层（MemoryManager、MemoryProvider 抽象、instance 单例）
- 砍掉注入层（system prompt 拼接、围栏注入、prefetch 机制）
- 砍掉项目库双层存储，简化为单库 `~/.mnemo/facts.db`
- 将 `bun:sqlite` 替换为 `better-sqlite3`（Node.js 兼容）
- 新增 MCP server 入口，使用 `@modelcontextprotocol/sdk` 注册 tools
- 保留完整的核心算法：检索管线、去重、信任衰减、矛盾检测、关键词提取、双语扩展、安全扫描

## Capabilities

### New Capabilities
- `mcp-server`: MCP 协议适配层，注册 fact_store / fact_feedback 两个 tools，stdio transport
- `fact-store`: 结构化事实存储核心（SQLite + FTS5 + 实体图谱 + 信任评分 + 矛盾检测）
- `fact-retrieval`: 混合检索管线（FTS5 → LIKE → 字符交叉 → 分类推断 → trust fallback），含双语扩展和 category 信号
- `security`: 安全扫描（注入检测、PII 检测、不可见 Unicode）

### Modified Capabilities

（无，全新项目）

## Impact

- 新项目依赖：better-sqlite3、@modelcontextprotocol/sdk、TypeScript
- 存储位置：`~/.mnemo/facts.db`（独立于 `~/.claude/`）
- 配置方式：各 AI 工具的 MCP server 配置文件中添加 mnemo-mcp
- 用户数据：从 Ocean CLI 的 `~/.claude/memory/facts.db` 迁移脚本（可选）
