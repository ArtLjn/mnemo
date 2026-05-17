## ADDED Requirements

### Requirement: Query execution time is recorded
The system SHALL record the execution time of every database query when debug mode is enabled.

Recorded metrics:
- Query type (search/probe/related/reason/contradict/list)
- Execution time in milliseconds
- Number of results returned
- Retrieval path (which fallback stages were used)

#### Scenario: Debug mode records search timing
- **WHEN** MNEMO_DEBUG=1 is set
- **AND** a search query is executed
- **THEN** the system SHALL log the query type, execution time, and result count

#### Scenario: Non-debug mode skips recording
- **WHEN** MNEMO_DEBUG is not set or is 0
- **AND** a query is executed
- **THEN** no performance metrics SHALL be recorded
- **AND** no debug logs SHALL be emitted

### Requirement: Retrieval path is tracked
The system SHALL record which retrieval stages were executed for each search query.

Retrieval stages:
- FTS5 (ftsCandidates)
- LIKE fallback (likeFallback)
- Character overlap fallback (charOverlapFallback)
- Category inference fallback (categoryInferFallback)
- Trust fallback (trustFallback)

#### Scenario: Search hits FTS5 path
- **WHEN** a search query matches via FTS5
- **THEN** the logged retrieval path SHALL include "FTS5"
- **AND** SHALL NOT include subsequent fallback stages

#### Scenario: Search falls through to LIKE
- **WHEN** a search query finds no FTS5 results but matches via LIKE
- **THEN** the logged retrieval path SHALL include "FTS5,LIKE"

### Requirement: Cache statistics are aggregated
The system SHALL maintain aggregate cache statistics over the process lifetime.

Aggregated metrics:
- totalQueries: total number of queries processed
- cacheHits: number of queries served from cache
- cacheMisses: number of queries executed against database
- avgQueryTime: average execution time for cache misses (ms)
- totalTimeSaved: estimated time saved by cache hits (sum of miss avg × hit count)

#### Scenario: Cache stats are queryable
- **WHEN** the system has processed multiple queries
- **AND** MNEMO_DEBUG=1 is set
- **THEN** a special internal call SHALL return the aggregated statistics
