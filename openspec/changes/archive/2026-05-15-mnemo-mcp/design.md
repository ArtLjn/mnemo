## Context

Ocean CLI（ocean-cc-cli）内置了一套从 Hermes 项目移植的结构化事实记忆系统，核心代码在 `src/memory/` 目录下约 2000 行 TypeScript。该系统包含：

- **存储层**：MemoryStore（SQLite + FTS5，`bun:sqlite` 绑定）
- **检索层**：FactRetriever（5 级 fallback 混合检索管线）
- **编排层**：MemoryManager + MemoryProvider 抽象 + HolographicProvider 实现
- **辅助**：安全扫描（security.ts）、类型定义（types.ts）、DDL（schema.ts）、注入工具（injection.ts）

系统被设计为"双层存储"（全局库 + 项目库）+ 多 provider 编排，与 Ocean CLI 的生命周期深度耦合。

目标：将核心存储和检索逻辑提取为独立 MCP server，支持 Claude Code 和 Codex 等任意 MCP 客户端。

## Goals / Non-Goals

**Goals:**
- 独立 npm 包 `mnemo-mcp`，一行配置即可在任何 MCP 客户端使用
- 忠实移植全部核心算法（检索管线、去重、信任、矛盾、关键词、双语）
- Node.js 兼容（使用 `better-sqlite3` 替代 `bun:sqlite`）
- 单库存储 `~/.mnemo/facts.db`，去掉项目库概念
- 零外部服务依赖，纯本地运行

**Non-Goals:**
- 不做多用户 / 中心化存储
- 不做 system prompt 注入逻辑（MCP 客户端自行决定如何消费数据）
- 不做项目库 / 双层架构
- 不做数据迁移工具（v1 用户可手动复制 SQLite 文件）
- 不做 Web UI / 管理界面
- 不修改 Ocean CLI 现有代码

## Decisions

### 1. SQLite 绑定：better-sqlite3

**选择**：better-sqlite3
**替代方案**：sql.js（纯 WASM）、drizzle-orm（抽象层）
**理由**：better-sqlite3 是 Node.js 生态最成熟的 SQLite 绑定，同步 API（和 bun:sqlite 一致），迁移成本最低。sql.js 性能差，drizzle 多一层抽象没必要。

### 2. 传输协议：stdio

**选择**：MCP stdio transport
**替代方案**：SSE transport（HTTP 长连接）
**理由**：本地工具标准模式，所有 MCP 客户端都支持 stdio。SSE 适合远程/多用户场景，v1 不需要。

### 3. 项目结构

```
mnemo-mcp/
├── src/
│   ├── server.ts        # MCP 入口，注册 tools
│   ├── store.ts          # MemoryStore 移植（better-sqlite3）
│   ├── retriever.ts      # FactRetriever 移植
│   ├── schema.ts         # DDL
│   ├── security.ts       # 安全扫描
│   └── types.ts          # 类型定义
├── package.json
├── tsconfig.json
└── README.md
```

**理由**：扁平结构，6 个文件，无子目录嵌套。核心代码从 Ocean CLI 直接移植，只改 import 和 SQLite 绑定。

### 4. category 保留 5 个固定分类

**选择**：identity / coding_style / tool_pref / workflow / general
**理由**：v1 不动分类，保持和 Ocean CLI 一致，降低移植风险。后续根据用户反馈迭代。

### 5. 去掉编排层和抽象

**选择**：不移植 MemoryManager、MemoryProvider、HolographicProvider、instance.ts、injection.ts
**理由**：MCP server 只需要一个 store + 一个 retriever，不需要 provider 抽象和编排。HolographicProvider 中的工具处理逻辑（handleFactStore/handleFactFeedback）直接下沉到 server.ts。

### 6. 安全扫描保留但降低为可选

**选择**：security.ts 移植但在 tool 响应中只做警告，不阻止操作
**理由**：MCP 客户端可能是 AI 自己调用，硬拦截可能导致功能异常。检测到风险时返回 warning 字段。

## Risks / Trade-offs

- **[better-sqlite3 native 编译]** → 用户安装时需要 C++ 编译环境。缓解：提供 prebuilt binaries（better-sqlite3 官方已支持 prebuild）。
- **[存储路径冲突]** → 多个 AI 工具同时写入 `~/.mnemo/facts.db`。缓解：SQLite WAL 模式支持并发读写，短锁等待即可。
- **[算法移植遗漏]** → 直接移植代码，关键算法用 diff 对比确认无遗漏。
- **[MCP SDK 版本]** → @modelcontextprotocol/sdk 仍在快速迭代。缓解：锁定具体版本，定期更新。
