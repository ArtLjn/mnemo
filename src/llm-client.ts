import type { LLMConfig, LLMMessage } from './types.js'

export class LLMClient {
  constructor(private config: LLMConfig) {}

  async chat(messages: LLMMessage[], options?: { temperature?: number }): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? this.config.temperature,
        max_tokens: 8192,
        stream: false,
        enable_thinking: false,
      }),
    })

    if (!resp.ok) {
      throw new Error(`LLM request failed: ${resp.status} ${await resp.text()}`)
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    return data.choices[0]?.message?.content ?? ''
  }

  async chatJSON<T = unknown>(messages: LLMMessage[]): Promise<T> {
    const text = await this.chat(messages)
    // 1. 直接解析
    try {
      return JSON.parse(text)
    } catch {}
    // 2. 提取 markdown code fence
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()) } catch {}
    }
    // 3. 找到第一个 { 和最后一个 } 之间的内容
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)) } catch {}
    }
    // 4. 找到第一个 [ 和最后一个 ] 之间的内容
    const arrStart = text.indexOf('[')
    const arrEnd = text.lastIndexOf(']')
    if (arrStart !== -1 && arrEnd > arrStart) {
      try { return JSON.parse(text.slice(arrStart, arrEnd + 1)) } catch {}
    }
    throw new Error(`LLM response is not valid JSON: ${text.slice(0, 200)}`)
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${this.config.baseUrl}/models`
      const headers: Record<string, string> = {}
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`
      }
      const resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000),
      })
      return resp.ok
    } catch {
      return false
    }
  }
}
