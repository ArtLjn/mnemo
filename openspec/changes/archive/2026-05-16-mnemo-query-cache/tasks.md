## 1. Query Cache Layer

- [ ] 1.1 Create `src/cache.ts` with `QueryCache` class
- [ ] 1.2 Implement cache key generation: hash of query + category + limit + minTrust
- [ ] 1.3 Implement `get(key)` and `set(key, results)` with TTL (60s)
- [ ] 1.4 Implement `clear()` for cache invalidation on writes
- [ ] 1.5 Integrate cache into `FactRetriever.search()` — check cache before DB query
- [ ] 1.6 Integrate cache into `FactRetriever.probe()`, `related()`, `reason()`, `contradict()`
- [ ] 1.7 Call `cache.clear()` on add/update/remove operations in server.ts

## 2. Batch Operations

- [ ] 2.1 Update `FactStoreArgs` type in `src/types.ts`: `content` accepts `string | string[]`
- [ ] 2.2 Update `fact_id` type: accepts `number | number[]` for batch remove
- [ ] 2.3 Implement batch add handler in `server.ts`: iterate array, call `store.addFact()` per item
- [ ] 2.4 Implement batch remove handler in `server.ts`: iterate array, call `store.removeFact()` per item
- [ ] 2.5 Update response format: return array of individual results for batch operations
- [ ] 2.6 Ensure backward compatibility: single string/number still works

## 3. Performance Metrics

- [ ] 3.1 Create `src/metrics.ts` with `PerfMetrics` class
- [ ] 3.2 Implement query timing: record start/end timestamps around retriever calls
- [ ] 3.3 Implement retrieval path tracking: log which fallback stages were executed
- [ ] 3.4 Implement cache hit/miss tracking
- [ ] 3.5 Implement aggregate statistics: totalQueries, cacheHits, cacheMisses, avgQueryTime
- [ ] 3.6 Add `MNEMO_DEBUG` env var check: only record metrics when set to "1"
- [ ] 3.7 Add debug log output: print metrics after each query when debug enabled

## 4. Startup Optimization

- [ ] 4.1 Remove `auditContradictions()` from startup path in `server.ts`
- [ ] 4.2 Remove `decayTrustScores()` from startup path in `server.ts`
- [ ] 4.3 Add lazy initialization: first tool call triggers audit + decay if not yet run
- [ ] 4.4 Add flag to prevent duplicate lazy initialization

## 5. Testing & Verification

- [ ] 5.1 Verify identical query returns cached result within TTL
- [ ] 5.2 Verify cache is cleared after fact addition
- [ ] 5.3 Verify batch add works with string array
- [ ] 5.4 Verify batch remove works with number array
- [ ] 5.5 Verify single fact add remains backward compatible
- [ ] 5.6 Verify debug mode logs query timing and cache stats
- [ ] 5.7 Verify startup is faster (no immediate audit/decay)
