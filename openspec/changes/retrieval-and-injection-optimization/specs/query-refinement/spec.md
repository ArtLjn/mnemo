## ADDED Requirements

### Requirement: 查询提炼函数
系统 SHALL 提供 `refineQuery(rawQuery: string): string | null` 纯函数，从用户原始消息中提取记忆相关关键词。

提炼流程：
1. 分词（按空格 + 中文字符边界）
2. 过滤中文虚词（复用 CN_STOP_WORDS）
3. 过滤动作词（"帮我""看看""做一下""帮我看看""能不能""为什么""怎么""是什么"）
4. 提取高信号 token（引号内容、大写开头连续词、书名号内容）
5. 剩余 token 作为提炼结果
6. 如果提炼后为空（纯操作指令），返回 null

#### Scenario: 包含实体的查询成功提炼
- **WHEN** 输入 "帮我用 TypeScript 重构 auth 模块"
- **THEN** 提炼结果包含 "TypeScript" "auth" 等关键词（过滤掉"帮我""重构""模块"）

#### Scenario: 纯操作指令返回 null
- **WHEN** 输入 "运行测试" 或 "git status"
- **THEN** 返回 null，表示不需要检索记忆

#### Scenario: 引号内容优先保留
- **WHEN** 输入 "我喜欢「深色主题」"
- **THEN** 提炼结果包含 "深色主题"

#### Scenario: 提炼结果集成到 search
- **WHEN** search() 接收到原始查询
- **THEN** 先调用 refineQuery()；若返回 null 则直接返回空结果；若返回非空则用提炼结果作为 FTS5 查询词

### Requirement: 提炼为空时的 fallback
系统 SHALL 在 refineQuery 返回 null 时保留原始查询作为 fallback，由调用方决定是否跳过检索。

#### Scenario: 调用方选择跳过
- **WHEN** refineQuery 返回 null 且调用方为自动触发（CLAUDE.md 规则 1）
- **THEN** 跳过检索，返回空结果

#### Scenario: 调用方显式搜索
- **WHEN** 用户显式调用 `fact_store(action="search", query="运行测试")`
- **THEN** 即使 refineQuery 返回 null，仍用原始查询执行检索
