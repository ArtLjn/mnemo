#!/usr/bin/env node

import { MemoryStore } from './store.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dbPath = join(homedir(), '.mnemo', 'facts.db')
const store = new MemoryStore(dbPath)

try {
  console.log('[mnemo dream] 开始整理记忆库...\n')
  const report = await store.runDream()
  console.log(JSON.stringify(report, null, 2))
  console.log(`\n[mnemo dream] 完成: merged=${report.merged} compressed=${report.compressed} reclassified=${report.reclassified} deleted=${report.deleted}`)
} catch (err) {
  console.error('[mnemo dream] error:', err)
  process.exit(1)
} finally {
  store.close()
}
