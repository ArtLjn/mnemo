## ADDED Requirements

### Requirement: Query results are cached with TTL
The system SHALL cache query results and return cached data for identical queries within the TTL period.

Cache key:
- SHALL be derived from query string, category, limit, and minTrust parameters
- SHALL NOT include trust_score or updated_at values (these change frequently)

Cache behavior:
- Cache TTL SHALL be 60 seconds by default
- Cache SHALL be stored in process memory (Map)
- Cache SHALL be cleared on any write operation (add/update/remove)

#### Scenario: Identical query returns cached result
- **WHEN** a search query with parameters {query: "用户偏好", category: "identity", limit: 10} is executed
- **AND** the same query is executed again within 60 seconds
- **THEN** the second call SHALL return the cached results
- **AND** no database query SHALL be executed

#### Scenario: Cache cleared on fact addition
- **WHEN** a new fact is added via fact_store
- **THEN** all cached query results SHALL be invalidated
- **AND** the next query SHALL hit the database

#### Scenario: Cache entry expires after TTL
- **WHEN** a cached query result ages beyond 60 seconds
- **THEN** the next identical query SHALL execute against the database
- **AND** generate a new cache entry

### Requirement: Cache supports all search actions
The system SHALL apply caching to all read-only fact_store actions.

Cached actions:
- search
- probe
- related
- reason
- contradict
- list

Non-cached actions:
- add
- update
- remove

#### Scenario: Probe query is cached
- **WHEN** a probe action is executed with entity "TypeScript"
- **AND** the same probe is executed again within TTL
- **THEN** the second call SHALL return cached results

### Requirement: Cache hit/miss is trackable
The system SHALL record cache statistics when debug mode is enabled.

Debug metrics:
- Total queries processed
- Cache hits and misses
- Cache hit ratio (hits / total)
- Average query execution time (cache miss only)

#### Scenario: Debug mode logs cache metrics
- **WHEN** MNEMO_DEBUG=1 is set
- **AND** a query is executed
- **THEN** the system SHALL log whether the query was a cache hit or miss
- **AND** SHALL include execution time for cache misses
