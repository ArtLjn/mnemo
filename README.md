<p align="center">
  <img src="./banner.png" alt="mnemo" width="600">
</p>

<p align="center">
  <a href="./README_zh.md">简体中文</a> | <strong>English</strong>
</p>

---

## Why mnemo?

AI coding assistants forget everything between sessions. `CLAUDE.md` stores static rules, but it can't search or reason over accumulated knowledge.

mnemo gives your AI assistant a **searchable, structured memory layer** that persists across sessions:

- **Search by meaning** — FTS5 full-text search + Jaccard reranking + bilingual expansion
- **Session warmup** — MCP Resources auto-inject top facts at session start, zero tool calls
- **Query refinement** — strips action words and noise tokens before memory search
- **Trust scoring** — facts gain or lose trust over time based on feedback and decay
- **Entity graph** — automatic entity extraction with multi-hop relationship queries
- **Contradiction detection** — finds conflicting facts and demotes the older one
- **Auto-dedup** — three-layer deduplication prevents duplicate facts

## Quick Start

```bash
# Install
npm install -g @morningljn/mnemo

# One-command setup (register MCP + write rules + set permissions)
mnemo-init
```

That's it. Restart your AI assistant and it will have persistent memory.

### Manual Setup

If you prefer manual configuration:

**1. Register MCP server:**

```bash
claude mcp add mnemo -- mnemo
```

**2. Add memory rules to `~/.claude/CLAUDE.md`:**

```markdown
# Memory System

You have mnemo memory tools (fact_store / fact_feedback). Rules:

## Rule 1: Session warmup (automatic)
mnemo MCP Resources auto-inject global memory into system context at session start.
You do NOT need to call fact_store(search) for high-frequency memories.

## Rule 2: On-demand search
Only call fact_store(action="search") when:
- User message involves personal preferences/habits/tool choices not covered by warmup
- User explicitly queries memory ("what did I say before", "per my habits")
- Technical decisions need user preference confirmation

Do NOT trigger search for:
- Pure operations ("run tests", "git commit")
- General tech questions ("how to use Promise")
- Code review/explanation requests

## Rule 3: Write on request
When user says "remember", call `fact_store(action="add", content="...", category="...")`.
Search first to avoid duplicates. Categories: identity / coding_style / tool_pref / workflow / general.

## Rule 4: Feedback
When a memory was useful, call `fact_feedback(action="helpful", fact_id=...)`.
```

**3. Allow tools in `~/.claude/settings.json`:**

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

Add to your Codex MCP configuration:

```json
{
  "mcpServers": {
    "mnemo": {
      "command": "mnemo"
    }
  }
}
```

## Tools

### `fact_store`

The primary tool for reading and writing structured facts. Supports 9 actions:

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `add` | Add a new fact (auto-deduplicates; merges if similar exists) | `content`, `category`, `tags` |
| `search` | Keyword search with FTS5 + Jaccard reranking | `query`, `category`, `min_trust`, `limit` |
| `probe` | Find all facts about a specific entity | `entity`, `min_trust`, `limit` |
| `related` | Find facts related to an entity through shared context | `entity`, `min_trust`, `limit` |
| `reason` | Multi-entity reasoning: find facts connected to all given entities | `entities`, `min_trust`, `limit` |
| `contradict` | Detect pairs of facts that share entities but conflict in content | `limit` |
| `update` | Update an existing fact's content, tags, category, or trust score | `fact_id`, `content`, `tags`, `category`, `trust_delta` |
| `remove` | Delete a fact by ID | `fact_id` |
| `list` | Browse facts sorted by trust score | `category`, `min_trust`, `limit` |

### `fact_feedback`

Rate a fact after use. Good facts rise, bad facts decay.

| Action | Effect |
|--------|--------|
| `helpful` | +0.05 trust |
| `unhelpful` | -0.10 trust |

## MCP Resources

mnemo exposes 5 global category resources for **zero-cost session warmup**:

| Resource URI | Description |
|-------------|-------------|
| `mnemo://global/identity` | Identity facts (top 10 by trust) |
| `mnemo://global/coding_style` | Coding style preferences |
| `mnemo://global/tool_pref` | Tool preferences |
| `mnemo://global/workflow` | Workflow preferences |
| `mnemo://global/general` | General facts |

MCP clients (Claude Code, Codex) automatically fetch these resources at session start, injecting memory into system context without any tool calls. This eliminates the need for "search every message" patterns.

## Architecture

```
┌───────────────────┐   stdio    ┌────────────┐   SQLite    ┌─────────────────────┐
│   MCP Client      │◄─────────►│  mnemo     │◄───────────►│ ~/.mnemo/facts.db   │
│ (Claude / Codex)  │   JSON    │  server    │             │                     │
│                   │           └─────┬──────┘             │ Tables:             │
│  Auto-fetch:      │                 │                    │   facts             │
│  mnemo://global/* │      ┌──────────┼──────────┐         │   entities          │
│  (session warmup) │      │          │          │         │   fact_entities     │
└───────────────────┘      │          │          │         │ Indexes:            │
                           │          │          │         │   facts_fts (FTS5)  │
                     Resources   Retriever   Security       │   idx_facts_trust   │
                     (warmup,   (search,    (PII scan,     │   idx_facts_category│
                      cache)     probe,     injection      └─────────────────────┘
                                 reason)    detection)
                                └──────────────────┘
```

## Categories

| Category | Description | Decay Rate |
|----------|-------------|------------|
| `identity` | User identity: name, role, preferences | 0.02/week |
| `coding_style` | Coding conventions, naming, formatting | 0.03/week |
| `tool_pref` | Tool and framework preferences | 0.03/week |
| `workflow` | Development workflow, CI/CD, git practices | 0.02/week |
| `general` | General knowledge and other facts | 0.03/week |

## Development

```bash
npm install
npm test        # run tests with vitest
npm run build   # compile TypeScript
npm start       # start MCP server
```

## License

[MIT](./LICENSE)
