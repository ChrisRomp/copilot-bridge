import { describe, it, expect, vi } from 'vitest';
import { handleCommand, type ModelInfo } from './command-handler.js';

// Mock config for admin detection
vi.mock('../config.js', () => ({
  isBotAdminAny: (botName: string) => botName === 'admin',
}));

const channelId = 'test-channel';
const sessionInfo = { sessionId: 'sess-1', model: 'claude-sonnet-4.6', agent: null };
const prefs = { verbose: false, permissionMode: 'interactive', reasoningEffort: null };
const meta = { workingDirectory: '/tmp', bot: 'copilot' };

const providers = {
  'ollama-local': {
    baseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'qwen3:8b', name: 'Qwen 3 8B' },
      { id: 'qwen3:14b', name: 'Qwen 3 14B' },
    ],
  },
  'azure-prod': {
    type: 'azure' as const,
    baseUrl: 'https://myco.openai.azure.com',
    apiKeyEnv: 'AZURE_KEY',
    wireApi: 'responses' as const,
    azure: { apiVersion: '2024-10-21' },
    models: [{ id: 'gpt-5', name: 'GPT-5 (Azure)' }],
  },
};

// --- /provider list ---

describe('/provider command', () => {
  it('lists configured providers', async () => {
    const result = await handleCommand(channelId, '/provider', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('ollama-local');
    expect(result.response).toContain('azure-prod');
    expect(result.response).toContain('localhost:11434');
    expect(result.response).toContain('qwen3:8b');
  });

  it('shows helpful message when no providers configured', async () => {
    const result = await handleCommand(channelId, '/provider', sessionInfo, prefs, meta, []);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('No BYOK providers');
    expect(result.response).toContain('config.json');
  });

  it('/providers alias works', async () => {
    const result = await handleCommand(channelId, '/providers', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('ollama-local');
  });

  it('shows auth method in provider listing', async () => {
    const result = await handleCommand(channelId, '/provider', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.response).toContain('apiKeyEnv: AZURE_KEY');
    expect(result.response).toContain('none'); // ollama has no auth
  });
});

// --- /provider test ---

describe('/provider test', () => {
  it('returns provider_test action for known provider', async () => {
    const result = await handleCommand(channelId, '/provider test ollama-local', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.action).toBe('provider_test');
    expect(result.payload).toBe('ollama-local');
  });

  it('returns error for unknown provider', async () => {
    const result = await handleCommand(channelId, '/provider test nonexistent', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Unknown provider');
    expect(result.action).toBeUndefined();
  });

  it('is case-insensitive on provider name', async () => {
    const result = await handleCommand(channelId, '/provider test OLLAMA-LOCAL', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.action).toBe('provider_test');
    expect(result.payload).toBe('ollama-local');
  });
});

// --- /provider add|remove guidance ---

describe('/provider add|remove', () => {
  it('guides non-admin user to config.json for add', async () => {
    const result = await handleCommand(channelId, '/provider add ollama', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('config.json');
    expect(result.response).toContain('/reload config');
  });

  it('offers to help when bot is admin', async () => {
    const adminMeta = { workingDirectory: '/tmp', bot: 'admin' };
    const result = await handleCommand(channelId, '/provider add ollama', sessionInfo, prefs, adminMeta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('I can help');
    expect(result.response).not.toContain('Ask the');
  });

  it('guides user to config.json for remove', async () => {
    const result = await handleCommand(channelId, '/provider remove azure-prod', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('config.json');
  });

  it('guides user to config.json for delete', async () => {
    const result = await handleCommand(channelId, '/provider delete azure-prod', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('config.json');
  });
});

// --- /provider unknown subcommand ---

describe('/provider unknown subcommand', () => {
  it('shows usage for unknown subcommand', async () => {
    const result = await handleCommand(channelId, '/provider foo', sessionInfo, prefs, meta, [], undefined, null, providers);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Unknown subcommand');
    expect(result.response).toContain('/provider test');
  });
});
