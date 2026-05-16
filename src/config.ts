import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { LLMConfig } from './types.js'

const DEFAULT_CONFIG: LLMConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3:8b',
  temperature: 0.1,
}

export function loadConfig(): LLMConfig {
  const configPath = join(homedir(), '.mnemo', 'config.json')
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    const llm = parsed.llm ?? {}
    return {
      baseUrl: llm.baseUrl ?? DEFAULT_CONFIG.baseUrl,
      model: llm.model ?? DEFAULT_CONFIG.model,
      apiKey: llm.apiKey,
      temperature: llm.temperature ?? DEFAULT_CONFIG.temperature,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
