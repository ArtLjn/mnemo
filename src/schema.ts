export const SCHEMA = `
-- 事实表
CREATE TABLE IF NOT EXISTS facts (
  fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content         TEXT NOT NULL UNIQUE,
  category        TEXT DEFAULT 'general',
  tags            TEXT DEFAULT '',
  keywords        TEXT DEFAULT '[]',
  summary         TEXT DEFAULT NULL,
  trust_score     REAL DEFAULT 0.5,
  retrieval_count INTEGER DEFAULT 0,
  helpful_count   INTEGER DEFAULT 0,
  last_retrieved_at TEXT DEFAULT NULL,
  created_at      TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 实体表
CREATE TABLE IF NOT EXISTS entities (
  entity_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  entity_type TEXT DEFAULT 'unknown',
  aliases     TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 事实-实体关联表
CREATE TABLE IF NOT EXISTS fact_entities (
  fact_id   INTEGER NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, entity_id)
);

-- 检索日志表
CREATE TABLE IF NOT EXISTS retrieval_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  query     TEXT NOT NULL,
  results   TEXT DEFAULT NULL,
  timestamp TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_facts_trust    ON facts(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);
CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_log_ts ON retrieval_log(timestamp);

-- FTS5 全文索引（trigram tokenizer 支持中文子串匹配）
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
  USING fts5(content, tags, summary, content=facts, content_rowid=fact_id, tokenize='trigram');

-- FTS5 同步触发器：插入
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content, tags, summary)
    VALUES (new.fact_id, new.content, new.tags, COALESCE(new.summary, ''));
END;

-- FTS5 同步触发器：删除
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, tags, summary)
    VALUES ('delete', old.fact_id, old.content, old.tags, COALESCE(old.summary, ''));
END;

-- FTS5 同步触发器：更新
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, tags, summary)
    VALUES ('delete', old.fact_id, old.content, old.tags, COALESCE(old.summary, ''));
  INSERT INTO facts_fts(rowid, content, tags, summary)
    VALUES (new.fact_id, new.content, new.tags, COALESCE(new.summary, ''));
END;
`
