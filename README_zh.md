<p align="center">
  <img src="./banner.png" alt="mnemo" width="600">
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="./README.md">English</a>
</p>

---

## 为什么需要 mnemo？

AI 编程助手在会话结束后会忘记所有内容。`CLAUDE.md` 只能存储静态规则，无法搜索或推理积累的知识。

mnemo 为你的 AI 助手提供**可搜索、结构化的记忆层**，跨会话持久化：

- **语义搜索** — FTS5 全文检索 + Jaccard 重排序 + 中英双语扩展
- **信任评分** — 事实随时间根据反馈和衰减获得或失去信任
- **实体图谱** — 自动实体抽取，支持多跳关联查询
- **矛盾检测** — 发现冲突事实并降级较旧的那条
- **自动去重** — 三层去重机制（实体重叠、Jaccard 相似度、包含检测）

## 快速开始

```bash
# 安装
npm install -g @morningljn/mnemo

# 一键配置（注册 MCP + 写入规则 + 设置权限）
mnemo-init
```

重启你的 AI 助手即可拥有持久记忆。

### 手动配置

如果你更喜欢手动配置：

**1. 注册 MCP 服务器：**

```bash
claude mcp add mnemo -- mnemo
```

**2. 在 `~/.claude/CLAUDE.md` 中添加记忆规则：**

```markdown
# 记忆系统

你有 mnemo 记忆工具（fact_store / fact_feedback）。规则：

## 规则 1：回复前搜索
收到用户消息后，调用 `fact_store(action="search", query="<用户消息的关键词>")`。
必须从用户消息中动态提取关键词，不要用固定模板。

## 规则 2：按需写入
用户说"记住"时，调用 `fact_store(action="add", content="...", category="...")`。
先搜索避免重复。类别：identity / coding_style / tool_pref / workflow / general。

## 规则 3：反馈强化
记忆有用时，调用 `fact_feedback(action="helpful", fact_id=...)`。
```

**3. 在 `~/.claude/settings.json` 中允许工具：**

```json
{
  "permissions": {
    "allow": [
      "mcp__mnemo__fact_store",
      "mcp__mnemo__fact_feedback"
    ]
  }
}
```

### Codex

添加到你的 Codex MCP 配置：

```json
{
  "mcpServers": {
    "mnemo": {
      "command": "mnemo"
    }
  }
}
```

## 工具

### `fact_store`

读写结构化事实的主工具，支持 9 种操作：

| 操作 | 说明 | 关键参数 |
|------|------|----------|
| `add` | 添加事实（自动去重，相似则合并） | `content`、`category`、`tags` |
| `search` | 关键词搜索（FTS5 + Jaccard 重排序） | `query`、`category`、`min_trust`、`limit` |
| `probe` | 查找某实体的所有事实 | `entity`、`min_trust`、`limit` |
| `related` | 通过共享上下文查找关联事实 | `entity`、`min_trust`、`limit` |
| `reason` | 多实体推理：查找与所有给定实体相关的事实 | `entities`、`min_trust`、`limit` |
| `contradict` | 检测共享实体但内容冲突的事实对 | `limit` |
| `update` | 更新事实的内容、标签、类别或信任分 | `fact_id`、`content`、`tags`、`category`、`trust_delta` |
| `remove` | 按 ID 删除事实 | `fact_id` |
| `list` | 按信任分浏览事实 | `category`、`min_trust`、`limit` |

### `fact_feedback`

使用事实后评分。好事实上升，坏事实下降。

| 操作 | 效果 |
|------|------|
| `helpful` | +0.05 信任 |
| `unhelpful` | -0.10 信任 |

## 架构

```
┌───────────────────┐   stdio    ┌────────────┐   SQLite    ┌─────────────────────┐
│   MCP Client      │◄─────────►│  mnemo     │◄───────────►│ ~/.mnemo/facts.db   │
│ (Claude / Codex)  │   JSON    │  server    │             │                     │
└───────────────────┘           └─────┬──────┘             │ 数据表：             │
                                      │                    │   facts             │
                               ┌──────┴──────┐             │   entities          │
                               │             │             │   fact_entities     │
                               │  Retriever  │  Security   │ 索引：              │
                               │  (搜索、    │  (PII 扫描、 │   facts_fts (FTS5)  │
                               │   探测、    │   注入检测)  │   idx_facts_trust   │
                               │   推理)     │             │   idx_facts_category│
                               └─────────────┘             └─────────────────────┘
```

## 类别

| 类别 | 说明 | 衰减率 |
|------|------|--------|
| `identity` | 用户身份：姓名、角色、偏好 | 0.02/周 |
| `coding_style` | 编码规范、命名、格式化 | 0.03/周 |
| `tool_pref` | 工具和框架偏好 | 0.03/周 |
| `workflow` | 开发工作流、CI/CD、Git 实践 | 0.02/周 |
| `general` | 通用知识和其他事实 | 0.03/周 |

## 开发

```bash
npm install
npm test        # 运行测试（vitest）
npm run build   # 编译 TypeScript
npm start       # 启动 MCP 服务器
```

## 许可证

[MIT](./LICENSE)
