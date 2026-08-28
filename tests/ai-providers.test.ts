import { afterEach, describe, expect, test } from 'bun:test';
import { normalizeProvider, getProviderConfig, config } from '../src/server/config.ts';
import { aiHealth, getAvailableProviders, translateBlocks, visionTranslate, explainStream } from '../src/server/ai.ts';
import server from '../src/server/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubUpstream(reply: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(reply(String(input), init))) as typeof fetch;
}

describe('AI Provider Configuration', () => {
  test('normalizeProvider normalizes names correctly', () => {
    expect(normalizeProvider('openrouter')).toBe('openrouter');
    expect(normalizeProvider('OPENROUTER')).toBe('openrouter');
    expect(normalizeProvider('ollama')).toBe('ollama');
    expect(normalizeProvider('OLLAMA')).toBe('ollama');
    expect(normalizeProvider('openaicompatible')).toBe('openaicompatible');
    expect(normalizeProvider('openai-compatible')).toBe('openaicompatible');
    expect(normalizeProvider('openai_compatible')).toBe('openaicompatible');
    expect(normalizeProvider('openai')).toBe('openaicompatible');
    expect(normalizeProvider(undefined, 'openrouter')).toBe('openrouter');
  });

  test('getProviderConfig returns correct provider configuration', () => {
    const ollama = getProviderConfig('ollama');
    expect(ollama.name).toBe('ollama');
    expect(ollama.baseUrl).toBeDefined();

    const openrouter = getProviderConfig('openrouter');
    expect(openrouter.name).toBe('openrouter');
    expect(openrouter.baseUrl).toContain('openrouter.ai');

    const openaiComp = getProviderConfig('openaicompatible');
    expect(openaiComp.name).toBe('openaicompatible');
  });

  test('getAvailableProviders lists openrouter, ollama, and openaicompatible', () => {
    const data = getAvailableProviders();
    expect(data.active).toBe(config.ai.provider);
    expect(data.providers.map((p) => p.id)).toEqual(['ollama', 'openrouter', 'openaicompatible']);
  });
});

describe('AI API endpoints with multi-provider support', () => {
  test('GET /api/ai/providers returns available providers and active provider', async () => {
    const res = await server.fetch(new Request('http://127.0.0.1/api/ai/providers'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { active: string; providers: { id: string }[] };
    expect(data.active).toBeDefined();
    expect(data.providers.length).toBe(3);
  });

  test('aiHealth directly returns provider health info', async () => {
    stubUpstream((url) => {
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'ollama-model' }] }));
      }
      return new Response('', { status: 404 });
    });

    const health = await aiHealth('ollama');
    expect(health.ok).toBe(true);
    expect(health.provider).toBe('ollama');
    expect(health.model).toBe('ollama-model');
  });

  test('GET /api/ai/health returns health status per provider', async () => {
    stubUpstream((url) => {
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }));
      }
      return new Response('', { status: 404 });
    });

    const res = await server.fetch(new Request('http://127.0.0.1/api/ai/health?provider=openrouter'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; provider: string; model: string };
    expect(data.ok).toBe(true);
    expect(data.provider).toBe('openrouter');
    expect(data.model).toBe('test-model');
  });

  test('translateBlocks works with openrouter provider', async () => {
    stubUpstream((url) => {
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'meta-llama/llama-3.3-70b-instruct' }] }));
      }
      return new Response(
        JSON.stringify({
          id: 'gen-123',
          model: 'meta-llama/llama-3.3-70b-instruct',
          created: Date.now(),
          choices: [{ index: 0, message: { role: 'assistant', content: '[{"id":0,"pt":"OLA MUNDO"}]' }, finish_reason: 'stop' }],
        }),
      );
    });

    const res = await translateBlocks({
      blocks: [{ id: 0, text: 'HELLO WORLD' }],
      provider: 'openrouter',
    });
    expect(res).toEqual([{ id: 0, pt: 'OLA MUNDO' }]);
  });

  test('translateBlocks works with openaicompatible provider', async () => {
    stubUpstream((url) => {
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'custom-model' }] }));
      }
      return new Response(
        JSON.stringify({
          id: 'gen-456',
          model: 'custom-model',
          choices: [{ message: { role: 'assistant', content: '[{"id":1,"pt":"BOM DIA"}]' } }],
        }),
      );
    });

    const res = await translateBlocks({
      blocks: [{ id: 1, text: 'GOOD MORNING' }],
      provider: 'openaicompatible',
    });
    expect(res).toEqual([{ id: 1, pt: 'BOM DIA' }]);
  });

  test('visionTranslate works with AI SDK multimodal prompt', async () => {
    config.ai.ollama.visionModel = 'llama3.2-vision';
    stubUpstream(() => {
      return new Response(
        JSON.stringify({
          id: 'gen-789',
          model: 'llama3.2-vision',
          choices: [{ message: { role: 'assistant', content: '[{"original":"こんにちは","pt":"Ola"}]' } }],
        }),
      );
    });

    const res = await visionTranslate({
      imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      provider: 'ollama',
    });
    expect(res).toEqual([{ original: 'こんにちは', pt: 'Ola' }]);
  });

  test('explainStream streams text from AI SDK', async () => {
    stubUpstream((url) => {
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5:7b-instruct' }] }));
      }
      // Return SSE stream for chat completions
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Explicacao "}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"da cena."}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });

    const stream = await explainStream({
      question: 'O que houve?',
      provider: 'ollama',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toBe('Explicacao da cena.');
  });

  test('POST /api/ai/config updates and returns providers', async () => {
    const res = await server.fetch(
      new Request('http://127.0.0.1/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          active: 'openrouter',
          provider: 'openrouter',
          model: 'google/gemini-2.5-flash',
          apiKey: 'test-token',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { active: string; providers: { id: string; model: string; hasKey: boolean }[] };
    expect(data.active).toBe('openrouter');
    const or = data.providers.find((p) => p.id === 'openrouter');
    expect(or?.model).toBe('google/gemini-2.5-flash');
    expect(or?.hasKey).toBe(true);
  });

  test('GET /api/ai/models lists models from provider endpoint', async () => {
    stubUpstream((url) => {
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
      }
      return new Response('', { status: 404 });
    });

    const res = await server.fetch(new Request('http://127.0.0.1/api/ai/models?provider=ollama'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; models: string[] };
    expect(data.ok).toBe(true);
    expect(data.models).toEqual(['model-a', 'model-b']);
  });
});

