## Why

mnemo-mcp 作为独立 MCP server，每次 tool 调用都直接查询 SQLite（FTS5 + Jaccard + 多级 fallback），相同 query 重复检索浪费计算资源。同时缺少批量操作能力，一次只能 add 一条事实，MCP 往返次数多。需要增加查询缓存和批量操作支持，提升响应速度和用户体验。

## What Changes

- 增加查询结果缓存层：相同 query + 参数在 60s 内直接返回缓存结果
- 增加批量 add 操作：支持一次写入多条事实，减少 MCP 往返
- 增加启动性能优化：延迟加载非关键索引、异步初始化
- 增加查询性能监控：记录检索耗时、缓存命中率（debug 模式）

## Capabilities

### New Capabilities
- `query-cache`: 查询结果缓存层，基于 query + category + limit + minTrust 做缓存键，TTL 60s
- `batch-operations`: 批量事实操作，支持一次 add 多条、一次 remove 多条
- `perf-metrics`: 性能监控，记录查询耗时、缓存命中率、检索 fallback 路径

### Modified Capabilities
- `fact-store`: 修改 fact_store tool 的 add action，支持传入数组批量写入

## Impact

- 修改文件：`src/store.ts`（增加缓存层、批量操作接口）
- 修改文件：`src/retriever.ts`（增加缓存查询、性能埋点）
- 修改文件：`src/server.ts`（增加 batch_add handler、perf_metrics 开关）
- 修改文件：`src/types.ts`（增加批量操作类型定义）
- 无外部依赖变化
- 预估性能提升：重复查询减少 80% 计算开销，批量操作减少 N 次 MCP 往返
