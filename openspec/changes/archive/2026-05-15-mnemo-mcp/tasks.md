## 1. 项目初始化

- [ ] 1.1 在 `~/Documents/demo/ocean/mnemo-mcp/` 创建项目目录，初始化 package.json（name: mnemo-mcp, bin 入口, dependencies: better-sqlite3, @modelcontextprotocol/sdk）
- [ ] 1.2 创建 tsconfig.json（target: ES2022, module: NodeNext, outDir: dist）
- [ ] 1.3 创建项目骨架文件：src/server.ts, src/store.ts, src/retriever.ts, src/schema.ts, src/security.ts, src/types.ts

## 2. 类型与 Schema 移植

- [ ] 2.1 移植 types.ts：去掉 ProviderContext/ToolSchema 等 Ocean CLI 特有类型，保留 Fact/ScoredFact/Contradiction/SearchOptions/FactStoreArgs/FactFeedbackArgs/FactCategory 等核心类型
- [ ] 2.2 移植 schema.ts：去掉 doc_index 表和 category_token_stats 表（v1 简化），保留 facts + entities + fact_entities + FTS5 索引 + 触发器

## 3. 存储层移植

- [ ] 3.1 移植 MemoryStore → store.ts：将 `bun:sqlite` 替换为 `better-sqlite3`，保留全部 public API（addFact/findSimilarFact/updateFact/removeFact/listFacts/recordFeedback/getFactsByEntity/getFactsByEntities/decayTrustScores/demoteContradictingFacts/auditContradictions）
- [ ] 3.2 移植实体提取逻辑（extractEntities/resolveEntity/classifyEntity/cleanOrphanEntities）
- [ ] 3.3 移植去重算法（三层递进：实体重叠+编辑距离 / Jaccard bigram / Containment）
- [ ] 3.4 移植信任衰减逻辑（decayTrustScores，按 category 宽限期 + 衰减率）
- [ ] 3.5 移植关键词提取逻辑（extractKeywords/tokenizeForKeywords/backfillKeywords + category_token_stats 表）

## 4. 检索层移植

- [ ] 4.1 移植 FactRetriever → retriever.ts：5 级 fallback（ftsCandidates/likeFallback/charOverlapFallback/categoryInferFallback/trustFallback）
- [ ] 4.2 移植评分逻辑（Jaccard + Containment + KeywordScore + Category 信号乘法 + 时间衰减）
- [ ] 4.3 移植高级检索（probe/related/reason/contradict）
- [ ] 4.4 移植双语查询扩展（getCnEnPairs/expandQueryBilingually + 种子表）
- [ ] 4.5 移植检索追踪（trackRetrieval: retrieval_count + top3 信任刷新）

## 5. 安全扫描移植

- [ ] 5.1 移植 security.ts：注入检测、PII 检测、不可见 Unicode 检测，保留全部函数签名

## 6. MCP Server 入口

- [ ] 6.1 实现 server.ts：McpServer 创建，stdio transport，注册 fact_store 和 fact_feedback 两个 tools
- [ ] 6.2 实现 fact_store tool handler：9 个 action（add/search/probe/related/reason/contradict/update/remove/list），调用 store + retriever
- [ ] 6.3 实现 fact_feedback tool handler：helpful/unhelpful 两个 action
- [ ] 6.4 实现启动初始化：创建 ~/.mnemo/ 目录、打开/创建数据库、执行信任衰减和矛盾审计、关键词补算
- [ ] 6.5 安全扫描集成：add/update 时调用 fullSecurityScan，将 warnings 附加到响应中

## 7. 构建与验证

- [ ] 7.1 配置构建脚本（tsc 编译），确认 `node dist/server.js` 可正常启动
- [ ] 7.2 用 MCP Inspector 或手动测试验证 tools/list 和 tools/call 响应格式正确
- [ ] 7.3 验证 add → search → feedback 完整流程可用
