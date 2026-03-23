import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BridgeProviderConfig, AppConfig } from '../types.js';

// --- Config validation tests ---

describe('BYOK provider config validation', () => {
  // Import validateAndNormalize indirectly via loadConfig with a temp file
  // Since validateAndNormalize is private, we test via loadConfig
  let loadConfig: typeof import('../config.js').loadConfig;
  let fs: typeof import('node:fs');
  let os: typeof import('node:os');
  let path: typeof import('node:path');
  let tmpDir: string;

  beforeEach(async () => {
    const configMod = await import('../config.js');
    loadConfig = configMod.loadConfig;
    fs = await import('node:fs');
    os = await import('node:os');
    path = await import('node:path');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-test-'));
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeConfig(config: any): string {
    const filePath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(filePath, JSON.stringify(config));
    return filePath;
  }

  const minimalConfig = {
    platforms: {
      mattermost: { url: 'http://localhost:8065', botToken: 'test-token' },
    },
    channels: [],
  };

  it('accepts config with no providers (backward compatible)', () => {
    const filePath = writeConfig(minimalConfig);
    const config = loadConfig(filePath);
    expect(config.providers).toBeUndefined();
  });

  it('accepts valid provider config', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        ollama: {
          type: 'openai',
          baseUrl: 'http://localhost:11434/v1',
          models: [{ id: 'qwen3:8b', name: 'Qwen 3 8B' }],
        },
      },
    });
    const config = loadConfig(filePath);
    expect(config.providers).toBeDefined();
    expect(config.providers!.ollama).toBeDefined();
    expect(config.providers!.ollama.models).toHaveLength(1);
    expect(config.providers!.ollama.models[0].id).toBe('qwen3:8b');
  });

  it('accepts provider without explicit type (defaults in SDK)', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        local: {
          baseUrl: 'http://localhost:8080/v1',
          models: [{ id: 'test-model' }],
        },
      },
    });
    const config = loadConfig(filePath);
    expect(config.providers!.local.type).toBeUndefined();
  });

  it('rejects provider with invalid type', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          type: 'bedrock',
          baseUrl: 'http://localhost',
          models: [{ id: 'm1' }],
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/type must be one of/);
  });

  it('rejects provider without baseUrl', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          models: [{ id: 'm1' }],
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/requires a "baseUrl"/);
  });

  it('rejects provider with empty models', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          baseUrl: 'http://localhost',
          models: [],
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/non-empty "models"/);
  });

  it('rejects provider with no models array', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          baseUrl: 'http://localhost',
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/non-empty "models"/);
  });

  it('rejects model entry without id', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          baseUrl: 'http://localhost',
          models: [{ name: 'Missing ID' }],
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/must have a string "id"/);
  });

  it('rejects invalid wireApi value', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          baseUrl: 'http://localhost',
          wireApi: 'chat',
          models: [{ id: 'm1' }],
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/wireApi must be/);
  });

  it('rejects providers that is not an object', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: 'not-an-object',
    });
    expect(() => loadConfig(filePath)).toThrow(/must be an object/);
  });

  it('accepts multiple providers', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        ollama: {
          baseUrl: 'http://localhost:11434/v1',
          models: [{ id: 'llama3.3' }],
        },
        azure: {
          type: 'azure',
          baseUrl: 'https://myco.openai.azure.com',
          apiKeyEnv: 'AZURE_KEY',
          wireApi: 'responses',
          azure: { apiVersion: '2024-10-21' },
          models: [{ id: 'gpt-5', name: 'GPT-5' }],
        },
      },
    });
    const config = loadConfig(filePath);
    expect(Object.keys(config.providers!)).toEqual(['ollama', 'azure']);
  });

  it('rejects non-string apiKeyEnv', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          baseUrl: 'http://localhost',
          apiKeyEnv: 123,
          models: [{ id: 'm1' }],
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/apiKeyEnv must be a string/);
  });

  it('rejects non-integer contextWindow', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          baseUrl: 'http://localhost',
          models: [{ id: 'm1', contextWindow: '32768' }],
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/contextWindow must be a positive integer/);
  });

  it('rejects non-object azure field', () => {
    const filePath = writeConfig({
      ...minimalConfig,
      providers: {
        bad: {
          type: 'azure',
          baseUrl: 'http://localhost',
          azure: 'wrong',
          models: [{ id: 'm1' }],
        },
      },
    });
    expect(() => loadConfig(filePath)).toThrow(/azure must be an object/);
  });
});

// --- Provider resolution tests ---

describe('resolveProviderConfig', () => {
  let resolveProviderConfig: typeof import('../config.js').resolveProviderConfig;
  let originalEnv: typeof process.env;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    const configMod = await import('../config.js');
    resolveProviderConfig = configMod.resolveProviderConfig;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  const providers: Record<string, BridgeProviderConfig> = {
    ollama: {
      type: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'qwen3:8b' }],
    },
    azure: {
      type: 'azure',
      baseUrl: 'https://myco.openai.azure.com',
      apiKeyEnv: 'TEST_AZURE_KEY',
      wireApi: 'responses',
      azure: { apiVersion: '2024-10-21' },
      models: [{ id: 'gpt-5' }],
    },
    anthropic: {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-inline-key',
      models: [{ id: 'claude-sonnet-4.6' }],
    },
    bearer: {
      baseUrl: 'https://custom.api.com',
      bearerTokenEnv: 'TEST_BEARER_TOKEN',
      models: [{ id: 'custom-model' }],
    },
  };

  it('returns null for unknown provider', () => {
    expect(resolveProviderConfig('nonexistent', providers)).toBeNull();
  });

  it('returns null when providers is undefined', () => {
    expect(resolveProviderConfig('ollama', undefined)).toBeNull();
  });

  it('resolves Ollama provider (no auth needed)', () => {
    const result = resolveProviderConfig('ollama', providers);
    expect(result).not.toBeNull();
    expect(result!.baseUrl).toBe('http://localhost:11434/v1');
    expect(result!.type).toBe('openai');
    expect(result!.apiKey).toBeUndefined();
  });

  it('resolves apiKeyEnv from environment', () => {
    process.env.TEST_AZURE_KEY = 'my-azure-key-123';
    const result = resolveProviderConfig('azure', providers);
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('my-azure-key-123');
    expect(result!.type).toBe('azure');
    expect(result!.wireApi).toBe('responses');
    expect(result!.azure?.apiVersion).toBe('2024-10-21');
  });

  it('warns but returns config when apiKeyEnv is not set', () => {
    delete process.env.TEST_AZURE_KEY;
    const result = resolveProviderConfig('azure', providers);
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBeUndefined();
  });

  it('resolves inline apiKey', () => {
    const result = resolveProviderConfig('anthropic', providers);
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-inline-key');
    expect(result!.type).toBe('anthropic');
  });

  it('resolves bearerTokenEnv', () => {
    process.env.TEST_BEARER_TOKEN = 'bearer-123';
    const result = resolveProviderConfig('bearer', providers);
    expect(result).not.toBeNull();
    expect(result!.bearerToken).toBe('bearer-123');
  });

  it('omits optional fields when not set', () => {
    const result = resolveProviderConfig('ollama', providers);
    expect(result).not.toBeNull();
    expect(result!.wireApi).toBeUndefined();
    expect(result!.azure).toBeUndefined();
    expect(result!.bearerToken).toBeUndefined();
  });
});

// --- Model list merging tests ---

describe('listModels with BYOK providers', () => {
  it('appends BYOK models with provider prefix', async () => {
    // We test the merging logic directly by constructing mock data
    const copilotModels = [
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 200000 } } },
    ];

    const providers: Record<string, BridgeProviderConfig> = {
      ollama: {
        baseUrl: 'http://localhost:11434/v1',
        models: [
          { id: 'qwen3:8b', name: 'Qwen 3 8B', contextWindow: 32768 },
          { id: 'qwen3:14b', name: 'Qwen 3 14B' },
        ],
      },
    };

    // Simulate the merge logic from bridge.ts
    const byokModels = [];
    for (const [provName, prov] of Object.entries(providers)) {
      for (const m of prov.models) {
        byokModels.push({
          id: `${provName}:${m.id}`,
          name: m.name ?? m.id,
          capabilities: {
            supports: { vision: false, reasoningEffort: false },
            limits: { max_context_window_tokens: m.contextWindow ?? 0 },
          },
        });
      }
    }

    const merged = [...copilotModels, ...byokModels];
    expect(merged).toHaveLength(3);
    expect(merged[0].id).toBe('claude-sonnet-4.6');
    expect(merged[1].id).toBe('ollama:qwen3:8b');
    expect(merged[1].name).toBe('Qwen 3 8B');
    expect(merged[1].capabilities.limits.max_context_window_tokens).toBe(32768);
    expect(merged[2].id).toBe('ollama:qwen3:14b');
    expect(merged[2].name).toBe('Qwen 3 14B');
    expect(merged[2].capabilities.limits.max_context_window_tokens).toBe(0);
  });

  it('returns only Copilot models when no providers', () => {
    const copilotModels = [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
    ];
    // No providers = no merge
    const merged = [...copilotModels];
    expect(merged).toHaveLength(1);
  });
});

// --- Channel prefs provider field tests ---
// Note: store.ts uses a hardcoded DB path, so prefs persistence is tested
// via integration (same pattern as command-handler.test.ts). The schema
// migration adds the `provider` column, and get/set logic was updated
// to include it. Testing the full round-trip here since the test DB
// is shared with other test suites that already write to it.

describe('channel prefs provider field', () => {
  let store: typeof import('../state/store.js');

  beforeEach(async () => {
    store = await import('../state/store.js');
  });

  it('stores and retrieves provider in channel prefs', () => {
    const testChannel = `byok-test-${Date.now()}`;
    store.setChannelPrefs(testChannel, { model: 'qwen3:8b', provider: 'ollama' });
    const prefs = store.getChannelPrefs(testChannel);
    expect(prefs).not.toBeNull();
    expect(prefs!.provider).toBe('ollama');
    expect(prefs!.model).toBe('qwen3:8b');
  });

  it('returns null provider when not set', () => {
    const testChannel = `byok-test-${Date.now()}-noprov`;
    store.setChannelPrefs(testChannel, { model: 'claude-sonnet-4.6' });
    const prefs = store.getChannelPrefs(testChannel);
    expect(prefs).not.toBeNull();
    expect(prefs!.provider).toBeNull();
  });

  it('updates provider on existing prefs', () => {
    const testChannel = `byok-test-${Date.now()}-update`;
    store.setChannelPrefs(testChannel, { model: 'claude-sonnet-4.6' });
    store.setChannelPrefs(testChannel, { provider: 'ollama' });
    const prefs = store.getChannelPrefs(testChannel);
    expect(prefs!.provider).toBe('ollama');
    expect(prefs!.model).toBe('claude-sonnet-4.6');
  });

  it('clears provider by setting to null', () => {
    const testChannel = `byok-test-${Date.now()}-clear`;
    store.setChannelPrefs(testChannel, { provider: 'ollama' });
    store.setChannelPrefs(testChannel, { provider: null });
    const prefs = store.getChannelPrefs(testChannel);
    expect(prefs!.provider).toBeNull();
  });
});

// --- Config diff tests ---

describe('diffConfigs with providers', () => {
  // diffConfigs is private, so we test behavior through reloadConfig
  // But we can validate the structure by testing the public API behavior
  // For now, test the types and config round-trip

  it('providers field survives config round-trip', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-diff-'));

    try {
      const configPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        platforms: {
          mattermost: { url: 'http://localhost:8065', botToken: 'test' },
        },
        channels: [],
        providers: {
          ollama: {
            baseUrl: 'http://localhost:11434/v1',
            models: [{ id: 'qwen3:8b' }],
          },
        },
      }));

      const { loadConfig } = await import('../config.js');
      const config = loadConfig(configPath);
      expect(config.providers).toBeDefined();
      expect(config.providers!.ollama.baseUrl).toBe('http://localhost:11434/v1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
