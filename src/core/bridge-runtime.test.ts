import { afterEach, describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import { CopilotBridge } from './bridge.js';

vi.mock('@github/copilot-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@github/copilot-sdk')>(),
  CopilotClient: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('CopilotBridge runtime host', () => {
  it('uses the pinned full CLI host when no runtime override is configured', async () => {
    vi.stubEnv('COPILOT_CLI_PATH', undefined);
    new CopilotBridge();
    const path = fileURLToPath(import.meta.resolve('@github/copilot/npm-loader.js'));
    expect(CopilotClient).toHaveBeenCalledWith(expect.objectContaining({
      connection: { kind: 'stdio', path },
    }));
    await access(path);
  });

  it('preserves an inherited runtime override', () => {
    vi.stubEnv('COPILOT_CLI_PATH', '/custom/copilot');
    new CopilotBridge();
    expect(CopilotClient).toHaveBeenCalledWith(expect.objectContaining({
      connection: { kind: 'stdio', path: '/custom/copilot' },
    }));
  });

  it('resolves overrides from the explicit runtime environment, not the parent environment', () => {
    vi.stubEnv('COPILOT_CLI_PATH', '/parent/copilot');
    const env = { PATH: '/bin', COPILOT_CLI_PATH: '/service/copilot' };
    const telemetry = { exporterType: 'file' as const, filePath: '/tmp/bridge-trace.jsonl' };
    new CopilotBridge({ env, telemetry });
    expect(CopilotClient).toHaveBeenCalledWith({
      connection: { kind: 'stdio', path: '/service/copilot' }, env, telemetry,
    });
  });

  it('uses the pinned host when an explicit environment omits the parent override', () => {
    vi.stubEnv('COPILOT_CLI_PATH', '/parent/copilot');
    const env = { PATH: '/bin' };
    new CopilotBridge({ env });
    expect(CopilotClient).toHaveBeenCalledWith(expect.objectContaining({
      connection: { kind: 'stdio', path: fileURLToPath(import.meta.resolve('@github/copilot/npm-loader.js')) }, env,
    }));
  });
});
