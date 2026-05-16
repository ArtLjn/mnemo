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
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? this.config.temperature,
        stream: false,
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
    try {
      return JSON.parse(text)
    } catch {
      const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (match) {
        return JSON.parse(match[1].trim())
      }
      throw new Error(`LLM response is not valid JSON: ${text.slice(0, 200)}`)
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${this.config.baseUrl}/models`
      const resp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      })
      return resp.ok
    } catch {
      return false
    }
  }
}
