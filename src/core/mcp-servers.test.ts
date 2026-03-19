import { describe, it, expect } from 'vitest';
import { mergeMcpServers } from './session-manager.js';

describe('mergeMcpServers', () => {
  it('injects cwd into local global servers without explicit cwd', () => {
    const global = {
      myserver: { command: 'npx', args: ['my-mcp'], type: 'local' },
    };
    const result = mergeMcpServers(global, {}, {}, '/workspace/bot1');
    expect(result.myserver.cwd).toBe('/workspace/bot1');
  });

  it('injects cwd into servers with no type (defaults to local)', () => {
    const global = {
      myserver: { command: 'node', args: ['server.js'] },
    };
    const result = mergeMcpServers(global, {}, {}, '/workspace/bot1');
    expect(result.myserver.cwd).toBe('/workspace/bot1');
  });

  it('injects cwd into stdio-type servers', () => {
    const global = {
      myserver: { command: 'node', args: ['server.js'], type: 'stdio' },
    };
    const result = mergeMcpServers(global, {}, {}, '/workspace/bot1');
    expect(result.myserver.cwd).toBe('/workspace/bot1');
  });

  it('preserves explicit cwd on global servers', () => {
    const global = {
      myserver: { command: 'npx', args: ['my-mcp'], type: 'local', cwd: '/custom/path' },
    };
    const result = mergeMcpServers(global, {}, {}, '/workspace/bot1');
    expect(result.myserver.cwd).toBe('/custom/path');
  });

  it('does not inject cwd into remote servers', () => {
    const global = {
      remote: { type: 'http', url: 'https://mcp.example.com', tools: [] },
    };
    const result = mergeMcpServers(global, {}, {}, '/workspace/bot1');
    expect(result.remote.cwd).toBeUndefined();
  });

  it('injects cwd into workspace-level local servers', () => {
    const workspace = {
      wsserver: { command: 'python3', args: ['mcp.py'], type: 'local' },
    };
    const result = mergeMcpServers({}, workspace, {}, '/workspace/bot1');
    expect(result.wsserver.cwd).toBe('/workspace/bot1');
  });

  it('preserves explicit cwd on workspace servers', () => {
    const workspace = {
      wsserver: { command: 'python3', args: ['mcp.py'], type: 'local', cwd: '/other' },
    };
    const result = mergeMcpServers({}, workspace, {}, '/workspace/bot1');
    expect(result.wsserver.cwd).toBe('/other');
  });

  it('injects workspace env into local global servers', () => {
    const global = {
      myserver: { command: 'npx', args: ['my-mcp'], type: 'local' },
    };
    const env = { API_KEY: 'abc123' };
    const result = mergeMcpServers(global, {}, env, '/workspace/bot1');
    expect(result.myserver.env).toEqual({ API_KEY: 'abc123' });
  });

  it('merges workspace env with existing server env', () => {
    const global = {
      myserver: { command: 'npx', args: ['my-mcp'], type: 'local', env: { EXISTING: 'val' } },
    };
    const env = { API_KEY: 'abc123' };
    const result = mergeMcpServers(global, {}, env, '/workspace/bot1');
    expect(result.myserver.env).toEqual({ API_KEY: 'abc123', EXISTING: 'val' });
  });

  it('server env takes precedence over workspace env', () => {
    const global = {
      myserver: { command: 'npx', args: ['my-mcp'], type: 'local', env: { API_KEY: 'server-val' } },
    };
    const env = { API_KEY: 'workspace-val' };
    const result = mergeMcpServers(global, {}, env, '/workspace/bot1');
    expect(result.myserver.env.API_KEY).toBe('server-val');
  });

  it('does not mutate original global config', () => {
    const global = {
      myserver: { command: 'npx', args: ['my-mcp'], type: 'local' },
    };
    mergeMcpServers(global, {}, {}, '/workspace/bot1');
    expect((global.myserver as any).cwd).toBeUndefined();
  });

  it('does not mutate original workspace config', () => {
    const wsserver = { command: 'python3', args: ['mcp.py'], type: 'local' };
    const workspace = { wsserver };
    mergeMcpServers({}, workspace, {}, '/workspace/bot1');
    expect(wsserver).not.toHaveProperty('cwd');
  });

  it('workspace servers override global servers with same name', () => {
    const global = {
      shared: { command: 'npx', args: ['global-mcp'], type: 'local' },
    };
    const workspace = {
      shared: { command: 'npx', args: ['workspace-mcp'], type: 'local' },
    };
    const result = mergeMcpServers(global, workspace, {}, '/workspace/bot1');
    expect(result.shared.args).toEqual(['workspace-mcp']);
    expect(result.shared.cwd).toBe('/workspace/bot1');
  });

  it('two bots get independent cwd values', () => {
    const global = {
      myserver: { command: 'npx', args: ['my-mcp'] },
    };
    const result1 = mergeMcpServers(global, {}, {}, '/workspace/bot1');
    const result2 = mergeMcpServers(global, {}, {}, '/workspace/bot2');
    expect(result1.myserver.cwd).toBe('/workspace/bot1');
    expect(result2.myserver.cwd).toBe('/workspace/bot2');
  });
});
