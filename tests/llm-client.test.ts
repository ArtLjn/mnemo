import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMClient } from '../src/llm-client.js'
import type { LLMConfig, LLMMessage } from '../src/types.js'

const mockConfig: LLMConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'test-model',
  temperature: 0.1,
}

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

describe('LLMClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('chat', () => {
    it('sends request and returns text content', async () => {
      const mockResp = {
        choices: [{ message: { content: 'Hello from LLM' } }],
      }
      globalThis.fetch = mockFetchResponse(mockResp)

      const client = new LLMClient(mockConfig)
      const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }]
      const result = await client.chat(messages)

      expect(result).toBe('Hello from LLM')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      )
    })

    it('includes Authorization header when apiKey is set', async () => {
      const configWithKey = { ...mockConfig, apiKey: 'sk-test-key' }
      globalThis.fetch = mockFetchResponse({
        choices: [{ message: { content: 'ok' } }],
      })

      const client = new LLMClient(configWithKey)
      await client.chat([{ role: 'user', content: 'test' }])

      const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
      expect(callArgs.headers).toHaveProperty('Authorization', 'Bearer sk-test-key')
    })

    it('throws on connection failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const client = new LLMClient(mockConfig)
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('ECONNREFUSED')
    })

    it('throws on non-ok HTTP status', async () => {
      globalThis.fetch = mockFetchResponse({ error: 'bad request' }, false, 400)
      const client = new LLMClient(mockConfig)
      await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow('400')
    })

    it('extracts JSON from markdown code fence', async () => {
      const jsonBody = { result: [1, 2] }
      const fenced = '```json\n' + JSON.stringify(jsonBody) + '\n```'
      globalThis.fetch = mockFetchResponse({
        choices: [{ message: { content: fenced } }],
      })

      const client = new LLMClient(mockConfig)
      const result = await client.chatJSON([{ role: 'user', content: 'test' }])
      expect(result).toEqual(jsonBody)
    })

    it('throws on invalid JSON response in chatJSON', async () => {
      globalThis.fetch = mockFetchResponse({
        choices: [{ message: { content: 'not json at all' } }],
      })
      const client = new LLMClient(mockConfig)
      await expect(client.chatJSON([{ role: 'user', content: 'test' }])).rejects.toThrow()
    })

    it('extracts JSON from text with leading/trailing content', async () => {
      const jsonBody = { merges: [{ kept: 1, removed: 2 }] }
      const mixedText = '根据分析结果如下：\n' + JSON.stringify(jsonBody) + '\n以上就是分析。'
      globalThis.fetch = mockFetchResponse({
        choices: [{ message: { content: mixedText } }],
      })
      const client = new LLMClient(mockConfig)
      const result = await client.chatJSON<{ merges: unknown[] }>([{ role: 'user', content: 'test' }])
      expect(result.merges).toHaveLength(1)
    })
  })

  describe('isAvailable', () => {
    it('returns true when service is reachable', async () => {
      globalThis.fetch = mockFetchResponse({ data: [] })
      const client = new LLMClient(mockConfig)
      expect(await client.isAvailable()).toBe(true)
    })

    it('returns false when service is unreachable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'))
      const client = new LLMClient(mockConfig)
      expect(await client.isAvailable()).toBe(false)
    })
  })
})
