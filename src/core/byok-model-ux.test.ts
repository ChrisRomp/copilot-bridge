import { describe, it, expect } from 'vitest';
import { resolveModel, parseProviderModel, handleCommand, type ModelInfo } from './command-handler.js';
import { buildFallbackChain } from './model-fallback.js';

// --- Helper: build test model lists ---

const copilotModels: ModelInfo[] = [
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
  { id: 'gpt-5.4', name: 'GPT-5.4', billing: { multiplier: 1 } },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', billing: { multiplier: 2 }, supportedReasoningEfforts: ['low', 'medium', 'high'] },
];

const byokModels: ModelInfo[] = [
  { id: 'ollama-local:qwen3:8b', name: 'Qwen 3 8B' },
  { id: 'ollama-local:qwen3:14b', name: 'Qwen 3 14B' },
  { id: 'azure-prod:gpt-5', name: 'GPT-5 (Azure)' },
];

const allModels = [...copilotModels, ...byokModels];
const providerNames = ['ollama-local', 'azure-prod'];

// --- parseProviderModel ---

describe('parseProviderModel', () => {
  it('extracts provider and bare model from prefixed input', () => {
    const result = parseProviderModel('ollama-local:qwen3:8b', providerNames);
    expect(result).toEqual({ provider: 'ollama-local', bareModel: 'qwen3:8b' });
  });

  it('returns null when prefix is not a known provider', () => {
    expect(parseProviderModel('qwen3:8b', providerNames)).toBeNull();
  });

  it('returns null when there is no colon', () => {
    expect(parseProviderModel('gpt-5.4', providerNames)).toBeNull();
  });

  it('returns null for empty prefix before colon', () => {
    expect(parseProviderModel(':qwen3:8b', providerNames)).toBeNull();
  });

  it('is case-insensitive on provider name', () => {
    const result = parseProviderModel('Ollama-Local:qwen3:8b', providerNames);
    expect(result).toEqual({ provider: 'ollama-local', bareModel: 'qwen3:8b' });
  });

  it('handles azure provider with simple model', () => {
    const result = parseProviderModel('azure-prod:gpt-5', providerNames);
    expect(result).toEqual({ provider: 'azure-prod', bareModel: 'gpt-5' });
  });
});

// --- resolveModel with providers ---

describe('resolveModel (provider-aware)', () => {
  it('resolves full provider:model ID exactly', () => {
    const result = resolveModel('ollama-local:qwen3:8b', allModels, providerNames);
    expect('model' in result).toBe(true);
    if ('model' in result) {
      expect(result.model.id).toBe('ollama-local:qwen3:8b');
    }
  });

  it('resolves bare model against BYOK when Copilot has no match', () => {
    const result = resolveModel('qwen3:8b', allModels, providerNames);
    expect('model' in result).toBe(true);
    if ('model' in result) {
      expect(result.model.id).toBe('ollama-local:qwen3:8b');
    }
  });

  it('resolves Copilot models first for bare IDs', () => {
    const result = resolveModel('gpt-5.4', allModels, providerNames);
    expect('model' in result).toBe(true);
    if ('model' in result) {
      expect(result.model.id).toBe('gpt-5.4');
    }
  });

  it('scoped provider search: fuzzy match within provider', () => {
    const result = resolveModel('ollama-local:qwen3', allModels, providerNames);
    expect('model' in result).toBe(true);
    if ('model' in result) {
      // Should pick best match (shorter ID = 8b)
      expect(result.model.id).toBe('ollama-local:qwen3:8b');
      expect(result.alternatives!.length).toBeGreaterThan(0);
    }
  });

  it('returns error for unknown provider:model', () => {
    const result = resolveModel('ollama-local:nonexistent', allModels, providerNames);
    expect('error' in result).toBe(true);
  });

  it('still works without provider names (backward compat)', () => {
    const result = resolveModel('claude-sonnet-4.6', copilotModels);
    expect('model' in result).toBe(true);
    if ('model' in result) {
      expect(result.model.id).toBe('claude-sonnet-4.6');
    }
  });

  it('fuzzy matches across all models', () => {
    const result = resolveModel('qwen', allModels, providerNames);
    expect('model' in result).toBe(true);
    if ('model' in result) {
      expect(result.model.id).toContain('qwen');
    }
  });

  it('returns error for empty input', () => {
    const result = resolveModel('', allModels, providerNames);
    expect('error' in result).toBe(true);
  });

  it('returns error for provider prefix with no model name', () => {
    const result = resolveModel('ollama-local:', allModels, providerNames);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('model name after the provider');
    }
  });
});

// --- /model listing ---

describe('/model command listing', () => {
  const channelId = 'test-channel';
  const sessionInfo = { sessionId: 'sess-1', model: 'claude-sonnet-4.6', agent: null };
  const prefs = { verbose: false, permissionMode: 'interactive', reasoningEffort: null };
  const meta = { workingDirectory: '/tmp', bot: 'copilot' };
  const providers = {
    'ollama-local': {
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'qwen3:8b' }, { id: 'qwen3:14b' }],
    },
  };

  it('groups models by provider in listing', () => {
    const result = handleCommand(channelId, '/model', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('GitHub Copilot');
    expect(result.response).toContain('ollama-local');
  });

  it('shows current model indicator for Copilot model', () => {
    const result = handleCommand(channelId, '/model', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    expect(result.response).toContain('← current');
  });

  it('filters by provider name', () => {
    const result = handleCommand(channelId, '/model ollama-local', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('qwen3:8b');
    expect(result.response).not.toContain('claude-sonnet');
  });

  it('hides Billing column for BYOK provider sections', () => {
    const result = handleCommand(channelId, '/model', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    // Copilot section should have Billing in table header
    const sections = result.response!.split('**ollama-local**');
    expect(sections[0]).toContain('| Model | Billing |');
    // BYOK section table header should NOT have Billing
    const byokTable = sections[1].split('🧠')[0]; // before the legend
    expect(byokTable).not.toContain('Billing');
  });

  it('hides Billing column when filtering to BYOK provider', () => {
    const result = handleCommand(channelId, '/model ollama-local', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    expect(result.response).not.toContain('Billing');
  });

  it('shows no-provider listing without providers', () => {
    const result = handleCommand(channelId, '/model', sessionInfo, prefs, meta, copilotModels);
    expect(result.handled).toBe(true);
    expect(result.response).not.toContain('GitHub Copilot'); // no grouping without providers
    expect(result.response).toContain('claude-sonnet-4.6');
  });
});

// --- /model switch with provider ---

describe('/model switch (provider-aware)', () => {
  const channelId = 'test-channel';
  const sessionInfo = { sessionId: 'sess-1', model: 'claude-sonnet-4.6', agent: null };
  const prefs = { verbose: false, permissionMode: 'interactive', reasoningEffort: null };
  const meta = { workingDirectory: '/tmp', bot: 'copilot' };
  const providers = {
    'ollama-local': {
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'qwen3:8b' }, { id: 'qwen3:14b' }],
    },
    'azure-prod': {
      baseUrl: 'https://myco.openai.azure.com',
      models: [{ id: 'gpt-5' }],
    },
  };

  it('returns provider in payload for BYOK model switch', () => {
    const result = handleCommand(channelId, '/model ollama-local:qwen3:8b', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    expect(result.action).toBe('switch_model');
    expect(result.payload).toEqual({ modelId: 'qwen3:8b', provider: 'ollama-local' });
  });

  it('returns null provider for Copilot model switch', () => {
    const result = handleCommand(channelId, '/model gpt-5.4', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    expect(result.action).toBe('switch_model');
    expect(result.payload).toEqual({ modelId: 'gpt-5.4', provider: null });
  });

  it('returns bare model ID (not prefixed) in payload', () => {
    const result = handleCommand(channelId, '/model azure-prod:gpt-5', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    expect(result.payload).toEqual({ modelId: 'gpt-5', provider: 'azure-prod' });
  });

  it('resolves bare BYOK model name to correct provider', () => {
    const result = handleCommand(channelId, '/model qwen3:8b', sessionInfo, prefs, meta, allModels, undefined, null, providers);
    expect(result.action).toBe('switch_model');
    expect(result.payload).toEqual({ modelId: 'qwen3:8b', provider: 'ollama-local' });
  });

  it('returns structured payload even when models list unavailable', () => {
    const result = handleCommand(channelId, '/model some-model', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.action).toBe('switch_model');
    expect(result.payload).toEqual({ modelId: 'some-model', provider: null });
  });

  it('parses provider prefix when models list unavailable', () => {
    const result = handleCommand(channelId, '/model ollama-local:qwen3:8b', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.action).toBe('switch_model');
    expect(result.payload).toEqual({ modelId: 'qwen3:8b', provider: 'ollama-local' });
  });
});

// --- Fallback chain excludes BYOK ---

describe('buildFallbackChain (BYOK exclusion)', () => {
  const allModelIds = [
    'claude-sonnet-4.6', 'claude-opus-4.6', 'gpt-5.4',
    'ollama-local:qwen3:8b', 'ollama-local:qwen3:14b',
  ];
  const byokPrefixes = ['ollama-local'];

  it('excludes BYOK models from auto-fallback chain', () => {
    const chain = buildFallbackChain('claude-opus-4.6', allModelIds, undefined, byokPrefixes);
    expect(chain.every(m => !m.startsWith('ollama-local:'))).toBe(true);
  });

  it('allows BYOK models when explicitly in configFallbacks', () => {
    const chain = buildFallbackChain('claude-opus-4.6', allModelIds, ['ollama-local:qwen3:8b'], byokPrefixes);
    expect(chain).toContain('ollama-local:qwen3:8b');
  });

  it('still builds chain for Copilot models', () => {
    const chain = buildFallbackChain('claude-opus-4.6', allModelIds, undefined, byokPrefixes);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every(m => !m.includes(':'))).toBe(true);
  });

  it('works without byokPrefixes (backward compat)', () => {
    const chain = buildFallbackChain('claude-opus-4.6', allModelIds);
    // Without prefixes, BYOK models may appear in chain (no filtering)
    expect(chain.length).toBeGreaterThan(0);
  });
});
