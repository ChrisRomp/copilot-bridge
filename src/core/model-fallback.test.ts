import { describe, it, expect } from 'vitest';
import { parseModelId, getFallbackChain, isModelError, tryWithFallback, buildFallbackChain } from './model-fallback.js';

// ---------------------------------------------------------------------------
// parseModelId
// ---------------------------------------------------------------------------

describe('parseModelId', () => {
  it('parses claude opus model', () => {
    const p = parseModelId('claude-opus-4.6');
    expect(p).toEqual({
      provider: 'claude',
      family: 'opus',
      version: '4.6',
      variant: undefined,
      raw: 'claude-opus-4.6',
    });
  });

  it('parses model with variant suffix', () => {
    const p = parseModelId('gpt-5.1-codex-max');
    expect(p).toEqual({
      provider: 'gpt',
      family: 'codex',
      version: '5.1',
      variant: 'max',
      raw: 'gpt-5.1-codex-max',
    });
  });

  it('parses claude sonnet model', () => {
    const p = parseModelId('claude-sonnet-4.5');
    expect(p).toEqual({
      provider: 'claude',
      family: 'sonnet',
      version: '4.5',
      variant: undefined,
      raw: 'claude-sonnet-4.5',
    });
  });

  it('parses claude haiku model', () => {
    const p = parseModelId('claude-haiku-4.5');
    expect(p).toEqual({
      provider: 'claude',
      family: 'haiku',
      version: '4.5',
      variant: undefined,
      raw: 'claude-haiku-4.5',
    });
  });

  it('parses gpt model without family', () => {
    const p = parseModelId('gpt-5.4');
    expect(p).toEqual({
      provider: 'gpt',
      family: '',
      version: '5.4',
      variant: undefined,
      raw: 'gpt-5.4',
    });
  });

  it('parses gpt codex model', () => {
    const p = parseModelId('gpt-5.3-codex');
    expect(p).toEqual({
      provider: 'gpt',
      family: 'codex',
      version: '5.3',
      variant: undefined,
      raw: 'gpt-5.3-codex',
    });
  });

  it('parses gpt codex model with variant', () => {
    const p = parseModelId('gpt-5.1-codex-max');
    expect(p).toEqual({
      provider: 'gpt',
      family: 'codex',
      version: '5.1',
      variant: 'max',
      raw: 'gpt-5.1-codex-max',
    });
  });

  it('parses gpt mini model', () => {
    const p = parseModelId('gpt-5-mini');
    expect(p).toEqual({
      provider: 'gpt',
      family: '',
      version: '5',
      variant: 'mini',
      raw: 'gpt-5-mini',
    });
  });

  it('parses gpt-4.1', () => {
    const p = parseModelId('gpt-4.1');
    expect(p).toEqual({
      provider: 'gpt',
      family: '',
      version: '4.1',
      variant: undefined,
      raw: 'gpt-4.1',
    });
  });

  it('parses gemini model', () => {
    const p = parseModelId('gemini-2.5-pro');
    expect(p).toEqual({
      provider: 'gemini',
      family: 'pro',
      version: '2.5',
      variant: undefined,
      raw: 'gemini-2.5-pro',
    });
  });

  it('parses o-series model', () => {
    const p = parseModelId('o3');
    expect(p).toEqual({
      provider: 'o',
      family: '',
      version: '3',
      variant: undefined,
      raw: 'o3',
    });
  });

  it('parses o-series with variant', () => {
    const p = parseModelId('o4-mini');
    expect(p).toEqual({
      provider: 'o',
      family: '',
      version: '4',
      variant: 'mini',
      raw: 'o4-mini',
    });
  });

  it('returns unknown for unrecognized models', () => {
    const p = parseModelId('some-future-model-v2');
    expect(p.provider).toBe('unknown');
    expect(p.raw).toBe('some-future-model-v2');
  });
});

// ---------------------------------------------------------------------------
// getFallbackChain
// ---------------------------------------------------------------------------

describe('getFallbackChain', () => {
  const ALL_MODELS = [
    'claude-opus-4.6', 'claude-opus-4.5',
    'claude-sonnet-4.6', 'claude-sonnet-4.5',
    'claude-haiku-4.5',
    'gpt-5.4', 'gpt-5.2', 'gpt-5.1',
    'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max',
    'gpt-5-mini', 'gpt-4.1',
    'o3', 'o4-mini',
  ];

  it('returns static fallbacks for claude-opus-4.6', () => {
    const chain = getFallbackChain('claude-opus-4.6', ALL_MODELS);
    expect(chain[0]).toBe('claude-opus-4.5');
    expect(chain).toContain('claude-sonnet-4.6');
    expect(chain).not.toContain('claude-opus-4.6'); // never includes self
  });

  it('returns static fallbacks for claude-sonnet-4.6', () => {
    const chain = getFallbackChain('claude-sonnet-4.6', ALL_MODELS);
    expect(chain[0]).toBe('claude-sonnet-4.5');
    expect(chain).toContain('claude-haiku-4.5');
  });

  it('returns static fallbacks for gpt-5.3-codex', () => {
    const chain = getFallbackChain('gpt-5.3-codex', ALL_MODELS);
    expect(chain[0]).toBe('gpt-5.2-codex');
    expect(chain).toContain('gpt-5.1-codex-max');
  });

  it('filters to only available models', () => {
    const limited = ['claude-sonnet-4.5', 'claude-haiku-4.5'];
    const chain = getFallbackChain('claude-opus-4.6', limited);
    // Only models in the limited set should appear
    for (const m of chain) {
      expect(limited).toContain(m);
    }
    expect(chain).toContain('claude-sonnet-4.5');
  });

  it('returns empty chain if no fallbacks available', () => {
    const chain = getFallbackChain('claude-opus-4.6', ['claude-opus-4.6']);
    expect(chain).toEqual([]);
  });

  it('returns empty chain for empty available list', () => {
    const chain = getFallbackChain('claude-opus-4.6', []);
    expect(chain).toEqual([]);
  });

  it('uses generic fallback for unknown models in same provider/family', () => {
    const available = ['claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-sonnet-3.0'];
    // A hypothetical future sonnet model
    const chain = getFallbackChain('claude-sonnet-5.0', available);
    // Should find sonnet models via generic strategy
    expect(chain.length).toBeGreaterThan(0);
    expect(chain).toContain('claude-sonnet-4.6');
  });

  it('returns empty for completely unknown models', () => {
    const chain = getFallbackChain('mystery-model-x', ALL_MODELS);
    expect(chain).toEqual([]);
  });

  it('does not duplicate entries between static and generic fallbacks', () => {
    const chain = getFallbackChain('claude-sonnet-4.6', ALL_MODELS);
    const uniqueChain = [...new Set(chain)];
    expect(chain).toEqual(uniqueChain);
  });

  it('never includes the original model in the chain', () => {
    for (const model of ALL_MODELS) {
      const chain = getFallbackChain(model, ALL_MODELS);
      expect(chain).not.toContain(model);
    }
  });

  it('generic fallback sorts by descending version', () => {
    const available = ['gpt-5.1', 'gpt-5.4', 'gpt-5.2'];
    // gpt-5.4 has a static chain, but let's test with a model that doesn't
    // to exercise the generic fallback
    const chain = getFallbackChain('gpt-6.0', available);
    // Generic: same provider (gpt), same family (''), sorted by version desc
    expect(chain[0]).toBe('gpt-5.4');
    expect(chain[1]).toBe('gpt-5.2');
    expect(chain[2]).toBe('gpt-5.1');
  });

  it('correctly orders multi-segment versions (4.10 > 4.9)', () => {
    const available = ['claude-sonnet-4.9', 'claude-sonnet-4.10', 'claude-sonnet-4.1'];
    const chain = getFallbackChain('claude-sonnet-5.0', available);
    expect(chain[0]).toBe('claude-sonnet-4.10');
    expect(chain[1]).toBe('claude-sonnet-4.9');
    expect(chain[2]).toBe('claude-sonnet-4.1');
  });
});

// ---------------------------------------------------------------------------
// buildFallbackChain
// ---------------------------------------------------------------------------

describe('buildFallbackChain', () => {
  const ALL_MODELS = [
    'claude-opus-4.6', 'claude-opus-4.5',
    'claude-sonnet-4.6', 'claude-sonnet-4.5',
    'claude-haiku-4.5',
    'gpt-5.4', 'gpt-5.2', 'gpt-5.1',
  ];

  it('uses auto chain when no config fallbacks', () => {
    const chain = buildFallbackChain('claude-opus-4.6', ALL_MODELS);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain).not.toContain('claude-opus-4.6');
  });

  it('prioritizes config fallbacks over auto chain', () => {
    const chain = buildFallbackChain('claude-opus-4.6', ALL_MODELS, ['gpt-5.4', 'claude-sonnet-4.5']);
    expect(chain[0]).toBe('gpt-5.4');
    expect(chain[1]).toBe('claude-sonnet-4.5');
  });

  it('includes config fallbacks unfiltered when availableModels is empty', () => {
    const chain = buildFallbackChain('claude-opus-4.6', [], ['claude-sonnet-4.6', 'claude-sonnet-4.5']);
    expect(chain).toContain('claude-sonnet-4.6');
    expect(chain).toContain('claude-sonnet-4.5');
  });

  it('excludes the primary model from config fallbacks', () => {
    const chain = buildFallbackChain('claude-opus-4.6', ALL_MODELS, ['claude-opus-4.6', 'claude-sonnet-4.6']);
    expect(chain).not.toContain('claude-opus-4.6');
    expect(chain).toContain('claude-sonnet-4.6');
  });

  it('returns empty when no available models and no config fallbacks', () => {
    const chain = buildFallbackChain('claude-opus-4.6', []);
    expect(chain).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isModelError
// ---------------------------------------------------------------------------

describe('isModelError', () => {
  it('detects capacity errors in message', () => {
    expect(isModelError(new Error('Model is at capacity, please try again later'))).toBe(true);
    expect(isModelError(new Error('model capacity exceeded'))).toBe(true);
  });

  it('does not flag generic capacity errors', () => {
    expect(isModelError(new Error('disk capacity exceeded'))).toBe(false);
    expect(isModelError(new Error('request payload exceeds capacity'))).toBe(false);
  });

  it('detects overloaded errors', () => {
    expect(isModelError(new Error('The model is currently overloaded'))).toBe(true);
  });

  it('does not flag generic overloaded errors', () => {
    expect(isModelError(new Error('Gateway overloaded'))).toBe(false);
    expect(isModelError(new Error('Connection pool overloaded'))).toBe(false);
  });

  it('detects model not found errors', () => {
    expect(isModelError(new Error('model not found: claude-opus-99'))).toBe(true);
    expect(isModelError(new Error('model is not available'))).toBe(true);
    expect(isModelError(new Error('The requested model does not exist'))).toBe(true);
    expect(isModelError(new Error('The requested model is not supported'))).toBe(true);
  });

  it('detects rate limit errors', () => {
    expect(isModelError(new Error('rate limit exceeded'))).toBe(true);
    expect(isModelError(new Error('Too many requests'))).toBe(true);
  });

  it('detects HTTP 429 status', () => {
    expect(isModelError({ status: 429, message: 'Too Many Requests' })).toBe(true);
  });

  it('detects HTTP 503 status', () => {
    expect(isModelError({ statusCode: 503, message: 'Service Unavailable' })).toBe(true);
  });

  it('does not flag generic service unavailable by message alone', () => {
    expect(isModelError(new Error('Service unavailable'))).toBe(false);
  });

  it('detects resource exhausted errors', () => {
    expect(isModelError(new Error('resource exhausted: quota limit reached'))).toBe(true);
  });

  it('detects quota exceeded errors', () => {
    expect(isModelError(new Error('Quota exceeded for model'))).toBe(true);
  });

  it('detects temporarily unavailable', () => {
    expect(isModelError(new Error('Model temporarily unavailable'))).toBe(true);
  });

  it('does not flag general errors', () => {
    expect(isModelError(new Error('Network timeout'))).toBe(false);
    expect(isModelError(new Error('Authentication failed'))).toBe(false);
    expect(isModelError(new Error('Invalid session'))).toBe(false);
    expect(isModelError(new Error('Permission denied'))).toBe(false);
  });

  it('does not flag null/undefined', () => {
    expect(isModelError(null)).toBe(false);
    expect(isModelError(undefined)).toBe(false);
  });

  it('handles string errors', () => {
    expect(isModelError('model is at capacity')).toBe(true);
    expect(isModelError('something unrelated')).toBe(false);
  });

  it('does not flag HTTP 400/401/404 by status alone', () => {
    expect(isModelError({ status: 400, message: 'Bad request' })).toBe(false);
    expect(isModelError({ status: 401, message: 'Unauthorized' })).toBe(false);
    expect(isModelError({ status: 404, message: 'Not found' })).toBe(false);
  });

  it('flags HTTP 400 if the message also matches a pattern', () => {
    expect(isModelError({ status: 400, message: 'model not available' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tryWithFallback
// ---------------------------------------------------------------------------

describe('tryWithFallback', () => {
  const available = [
    'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5',
  ];

  it('returns primary model result when it succeeds', async () => {
    const result = await tryWithFallback(
      'claude-sonnet-4.6',
      available,
      undefined,
      async (model) => `ok-${model}`,
    );
    expect(result.usedModel).toBe('claude-sonnet-4.6');
    expect(result.result).toBe('ok-claude-sonnet-4.6');
    expect(result.didFallback).toBe(false);
  });

  it('falls back on model error', async () => {
    let callCount = 0;
    const result = await tryWithFallback(
      'claude-sonnet-4.6',
      available,
      undefined,
      async (model) => {
        callCount++;
        if (model === 'claude-sonnet-4.6') {
          throw Object.assign(new Error('model is at capacity'), { status: 429 });
        }
        return `ok-${model}`;
      },
    );
    expect(result.usedModel).toBe('claude-sonnet-4.5');
    expect(result.didFallback).toBe(true);
    expect(callCount).toBe(2);
  });

  it('tries multiple fallbacks until one succeeds', async () => {
    const tried: string[] = [];
    const result = await tryWithFallback(
      'claude-sonnet-4.6',
      available,
      undefined,
      async (model) => {
        tried.push(model);
        if (model !== 'claude-haiku-4.5') {
          throw new Error('model is overloaded');
        }
        return `ok-${model}`;
      },
    );
    expect(result.usedModel).toBe('claude-haiku-4.5');
    expect(tried).toEqual(['claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5']);
  });

  it('throws if all fallbacks fail', async () => {
    await expect(
      tryWithFallback(
        'claude-sonnet-4.6',
        available,
        undefined,
        async () => { throw new Error('model is overloaded'); },
      ),
    ).rejects.toThrow('overloaded');
  });

  it('throws immediately on non-model errors', async () => {
    await expect(
      tryWithFallback(
        'claude-sonnet-4.6',
        available,
        undefined,
        async () => { throw new Error('Authentication failed'); },
      ),
    ).rejects.toThrow('Authentication failed');
  });

  it('uses config fallbacks with priority over auto chain', async () => {
    const tried: string[] = [];
    const result = await tryWithFallback(
      'claude-sonnet-4.6',
      available,
      ['claude-haiku-4.5'], // config says try haiku first
      async (model) => {
        tried.push(model);
        if (model === 'claude-sonnet-4.6') {
          throw new Error('model is overloaded');
        }
        return `ok-${model}`;
      },
    );
    expect(result.usedModel).toBe('claude-haiku-4.5');
    // Config fallback (haiku) should be tried before auto-detected (sonnet-4.5)
    expect(tried[1]).toBe('claude-haiku-4.5');
  });

  it('filters config fallbacks against available models', async () => {
    const tried: string[] = [];
    await tryWithFallback(
      'claude-sonnet-4.6',
      available, // only sonnet-4.6, sonnet-4.5, haiku-4.5
      ['claude-opus-4.6', 'claude-haiku-4.5'], // opus not available
      async (model) => {
        tried.push(model);
        if (model === 'claude-sonnet-4.6') {
          throw new Error('model is overloaded');
        }
        return `ok-${model}`;
      },
    );
    // opus-4.6 should be skipped (not available), haiku tried directly
    expect(tried).not.toContain('claude-opus-4.6');
    expect(tried).toContain('claude-haiku-4.5');
  });

  it('throws when no fallbacks exist', async () => {
    await expect(
      tryWithFallback(
        'mystery-model',
        [],
        undefined,
        async () => { throw new Error('model not found'); },
      ),
    ).rejects.toThrow('model not found');
  });
});
