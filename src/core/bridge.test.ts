import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';

// Mock @github/copilot-sdk before importing bridge
vi.mock('@github/copilot-sdk', () => {
  const mockClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnValue(() => {}),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'test-session', disconnect: vi.fn() }),
  };
  const MockCopilotClient = vi.fn(function MockCopilotClient() {
    return mockClient;
  });
  return { CopilotClient: MockCopilotClient };
});

import { CopilotBridge } from './bridge.js';
import { CopilotClient } from '@github/copilot-sdk';

describe('CopilotBridge constructor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes os.homedir() as cwd to CopilotClient when no cwd option given', () => {
    new CopilotBridge();
    expect(CopilotClient).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: os.homedir() })
    );
  });

  it('passes explicit cwd to CopilotClient when cwd option given', () => {
    new CopilotBridge({ cwd: '/custom/path' });
    expect(CopilotClient).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/custom/path' })
    );
  });

  it('still passes telemetry and env when provided alongside cwd', () => {
    const env = { FOO: 'bar' };
    new CopilotBridge({ env, cwd: '/some/dir' });
    expect(CopilotClient).toHaveBeenCalledWith(
      expect.objectContaining({ env, cwd: '/some/dir' })
    );
  });
});
