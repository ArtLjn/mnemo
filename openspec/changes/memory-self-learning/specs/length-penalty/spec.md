## ADDED Requirements

### Requirement: Scoring formula includes length penalty based on match text
检索评分公式 MUST 对实际匹配文本（summary 非空时用 summary，否则用 content）长度超过 300 字的 fact 施加线性惩罚：`score *= min(1.0, 300 / matchText.length)`。

#### Scenario: Short fact gets no penalty
- **WHEN** 检索到一个 content 长度为 150 字、summary 为 NULL 的 fact，原始 score=0.5
- **THEN** matchText = content (150字)，最终 score = 0.5 × min(1.0, 300/150) = 0.5

#### Scenario: Long fact without summary gets penalized
- **WHEN** 检索到一个 content 长度为 1500 字、summary 为 NULL 的 fact，原始 score=0.5
- **THEN** matchText = content (1500字)，最终 score = 0.5 × min(1.0, 300/1500) = 0.1

#### Scenario: Long fact with short summary gets no penalty
- **WHEN** 检索到一个 content 长度为 2000 字、summary 长度为 50 字的 fact，原始 score=0.5
- **THEN** matchText = summary (50字)，最终 score = 0.5 × min(1.0, 300/50) = 0.5 × 1.0 = 0.5

#### Scenario: Boundary at 300 chars of match text
- **WHEN** 检索到一个 matchText 长度恰好 300 字的 fact
- **THEN** penalty = min(1.0, 300/300) = 1.0，无惩罚

### Requirement: Length penalty applies after all other scoring
length penalty MUST 在 FTS/Jaccard/trust 评分计算完成后、排序前应用。

#### Scenario: Penalty stacks with trust score
- **WHEN** 一个 fact 的 fts+jaccard relevance=0.6, trust=0.8, matchText 长度=900 字, summary=NULL
- **THEN** score = 0.6 × 0.8 × min(1.0, 300/900) = 0.48 × 0.333 = 0.16
