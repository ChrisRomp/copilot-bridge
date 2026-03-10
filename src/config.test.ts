import { describe, it, expect } from 'vitest';
import { isHardDeny } from './config.js';

/** Helper: test a shell command against isHardDeny. */
function denied(command: string): boolean {
  return isHardDeny('shell', command);
}

describe('isHardDeny', () => {
  // --- Non-shell requests are never hard-denied ---
  it('ignores non-shell kinds', () => {
    expect(isHardDeny('read', 'rm -rf /')).toBe(false);
    expect(isHardDeny('write', 'mkfs /dev/sda')).toBe(false);
    expect(isHardDeny('mcp', 'rm -rf /')).toBe(false);
  });

  // --- launchctl unload ---
  it('denies launchctl unload', () => {
    expect(denied('launchctl unload com.example.service')).toBe(true);
  });
  it('allows launchctl load', () => {
    expect(denied('launchctl load com.example.service')).toBe(false);
  });

  // --- rm -rf / ---
  describe('rm -rf', () => {
    it('denies rm -rf /', () => {
      expect(denied('rm -rf /')).toBe(true);
    });
    it('denies rm -rf /*', () => {
      expect(denied('rm -rf /*')).toBe(true);
    });
    it('denies rm -rf ~', () => {
      expect(denied('rm -rf ~')).toBe(true);
    });
    it('allows rm -rf ~/subpath (not home root)', () => {
      expect(denied('rm -rf ~/Downloads')).toBe(false);
    });
    it('denies rm -rf $HOME', () => {
      expect(denied('rm -rf $HOME')).toBe(true);
    });
    it('allows rm -rf $HOME/.cache (subpath)', () => {
      expect(denied('rm -rf $HOME/.cache')).toBe(false);
    });
    it('denies rm -fr /', () => {
      expect(denied('rm -fr /')).toBe(true);
    });
    it('denies split flags: rm -r -f /', () => {
      expect(denied('rm -r -f /')).toBe(true);
    });
    it('denies --recursive --force', () => {
      expect(denied('rm --recursive --force /')).toBe(true);
    });
    it('allows rm -rf on a normal path', () => {
      expect(denied('rm -rf ./build')).toBe(false);
    });
    it('allows rm (no -rf)', () => {
      expect(denied('rm file.txt')).toBe(false);
    });
    it('allows rm -r (no -f) on /', () => {
      expect(denied('rm -r /')).toBe(false);
    });
  });

  // --- mkfs ---
  describe('mkfs', () => {
    it('denies mkfs', () => {
      expect(denied('mkfs /dev/sda')).toBe(true);
    });
    it('denies mkfs.ext4', () => {
      expect(denied('mkfs.ext4 /dev/sda1')).toBe(true);
    });
  });

  // --- dd to block devices ---
  describe('dd', () => {
    it('denies dd to /dev/', () => {
      expect(denied('dd if=/dev/zero of=/dev/sda bs=1M')).toBe(true);
    });
    it('allows dd to a file', () => {
      expect(denied('dd if=/dev/zero of=./disk.img bs=1M count=100')).toBe(false);
    });
  });

  // --- Fork bomb ---
  describe('fork bomb', () => {
    it('denies :(){ :|:& };:', () => {
      expect(denied(':(){ :|:& };:')).toBe(true);
    });
    it('denies spaced variant', () => {
      expect(denied(':() { :|:& }; :')).toBe(true);
    });
  });

  // --- chmod/chown -R on system paths ---
  describe('chmod/chown -R', () => {
    it('denies chmod -R 777 /', () => {
      expect(denied('chmod -R 777 /')).toBe(true);
    });
    it('denies chown -R root /', () => {
      expect(denied('chown -R root /')).toBe(true);
    });
    it('denies chmod -R on /etc', () => {
      expect(denied('chmod -R 755 /etc')).toBe(true);
    });
    it('denies chown -R on /usr', () => {
      expect(denied('chown -R nobody /usr')).toBe(true);
    });
    it('denies chmod -R on /var', () => {
      expect(denied('chmod -R 777 /var')).toBe(true);
    });
    it('denies chmod -R on ~', () => {
      expect(denied('chmod -R 777 ~')).toBe(true);
    });
    it('allows chmod -R on a normal path', () => {
      expect(denied('chmod -R 755 ./dist')).toBe(false);
    });
    it('allows chmod (no -R) on /', () => {
      expect(denied('chmod 755 /')).toBe(false);
    });
  });

  // --- Shell wrappers ---
  describe('shell wrappers', () => {
    it('denies sudo rm -rf /', () => {
      expect(denied('sudo rm -rf /')).toBe(true);
    });
    it('denies sudo mkfs /dev/sda', () => {
      expect(denied('sudo mkfs /dev/sda')).toBe(true);
    });
    it('denies sudo chmod -R 777 /', () => {
      expect(denied('sudo chmod -R 777 /')).toBe(true);
    });
    it('denies env rm -rf /', () => {
      expect(denied('env rm -rf /')).toBe(true);
    });
    it('denies /usr/bin/rm -rf /', () => {
      expect(denied('/usr/bin/rm -rf /')).toBe(true);
    });
    it('denies bash -c "rm -rf /"', () => {
      expect(denied('bash -c "rm -rf /"')).toBe(true);
    });
    it('denies sudo bash -c "rm -rf /"', () => {
      expect(denied('sudo bash -c "rm -rf /"')).toBe(true);
    });
    it('denies sh -c "mkfs /dev/sda"', () => {
      expect(denied('sh -c "mkfs /dev/sda"')).toBe(true);
    });
    it('denies eval rm -rf /', () => {
      expect(denied('eval rm -rf /')).toBe(true);
    });
    it('denies sudo -u root rm -rf /', () => {
      expect(denied('sudo -u root rm -rf /')).toBe(true);
    });
    it('denies sudo -i rm -rf /', () => {
      expect(denied('sudo -i rm -rf /')).toBe(true);
    });
    it('denies env FOO=bar rm -rf /', () => {
      expect(denied('env FOO=bar rm -rf /')).toBe(true);
    });
    it('denies sudo env bash -c "rm -rf /"', () => {
      expect(denied('sudo env bash -c "rm -rf /"')).toBe(true);
    });
  });

  // --- Safe commands should not be denied ---
  describe('safe commands', () => {
    it('allows ls', () => {
      expect(denied('ls -la')).toBe(false);
    });
    it('allows git push', () => {
      expect(denied('git push origin main')).toBe(false);
    });
    it('allows npm install', () => {
      expect(denied('npm install')).toBe(false);
    });
    it('allows cat', () => {
      expect(denied('cat /etc/hosts')).toBe(false);
    });
    it('allows sudo apt install', () => {
      expect(denied('sudo apt install curl')).toBe(false);
    });
  });
});

// --- reloadConfig tests ---

import { loadConfig, reloadConfig, getConfig, getConfigPath, registerDynamicChannel, markChannelAsDM, _resetConfigForTest } from './config.js';
import { describe as d2, it as it2, expect as expect2, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeConfig(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    platforms: {
      mattermost: {
        url: 'http://localhost:8065',
        bots: { copilot: { token: 'test-token-123' } },
      },
    },
    channels: [
      {
        id: 'ch1',
        platform: 'mattermost',
        bot: 'copilot',
        name: 'test',
        workingDirectory: os.tmpdir(),
        triggerMode: 'all',
        threadedReplies: false,
        verbose: false,
      },
    ],
    defaults: { model: 'claude-sonnet-4.6', triggerMode: 'mention' },
    ...overrides,
  };
}

describe('reloadConfig', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    _resetConfigForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-reload-test-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    _resetConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('successfully reloads a valid config', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    // Change triggerMode
    const updated = makeConfig({ defaults: { model: 'claude-sonnet-4.6', triggerMode: 'all' } });
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.some(c => c.includes('triggerMode'))).toBe(true);
    expect(getConfig().defaults.triggerMode).toBe('all');
  });

  it('rejects invalid JSON and keeps existing config', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    fs.writeFileSync(configFile, '{ invalid json !!!');

    const result = reloadConfig();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to read config/);
    // Original config preserved
    expect(getConfig().defaults.triggerMode).toBe('mention');
  });

  it('rejects validation errors and keeps existing config', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    // Write config with missing platform URL
    const bad = makeConfig();
    bad.platforms.mattermost.url = '';
    fs.writeFileSync(configFile, JSON.stringify(bad));

    const result = reloadConfig();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Validation failed/);
    expect(getConfig().platforms.mattermost.url).toBe('http://localhost:8065');
  });

  it('returns empty changes for identical config', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.restartNeeded).toEqual([]);
  });

  it('detects permission changes', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const updated = makeConfig({ permissions: { allow: ['shell(ls)'], deny: ['shell(rm)'] } });
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.changes).toContain('permissions updated');
  });

  it('detects channel field changes', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const updated = makeConfig();
    updated.channels[0].verbose = true;
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.changes.some(c => c.includes('ch1') && c.includes('verbose'))).toBe(true);
  });

  it('detects new channel additions', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const updated = makeConfig();
    updated.channels.push({
      id: 'ch2', platform: 'mattermost', bot: 'copilot',
      name: 'new', workingDirectory: os.tmpdir(),
      triggerMode: 'all', threadedReplies: false, verbose: false,
    });
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.changes.some(c => c.includes('ch2') && c.includes('added'))).toBe(true);
  });

  // --- Restart-needed detection ---

  it('flags platform URL change as restart-needed', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const updated = makeConfig();
    updated.platforms.mattermost.url = 'http://other:8065';
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.restartNeeded.some(r => r.includes('URL changed'))).toBe(true);
  });

  it('flags bot token change as restart-needed', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const updated = makeConfig();
    updated.platforms.mattermost.bots.copilot.token = 'new-token';
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.restartNeeded.some(r => r.includes('token changed'))).toBe(true);
  });

  it('flags new bot as restart-needed', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const updated = makeConfig();
    updated.platforms.mattermost.bots.alice = { token: 'alice-token' };
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.restartNeeded.some(r => r.includes('alice') && r.includes('added'))).toBe(true);
  });

  it('flags new platform as restart-needed', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const updated = makeConfig();
    updated.platforms.discord = { url: 'http://discord', bots: { bot1: { token: 't' } } };
    // Need a channel for the new platform to pass validation
    updated.channels.push({
      id: 'dch1', platform: 'discord', bot: 'bot1',
      name: 'disc', workingDirectory: os.tmpdir(),
      triggerMode: 'all', threadedReplies: false, verbose: false,
    });
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.restartNeeded.some(r => r.includes('discord') && r.includes('added'))).toBe(true);
  });

  // --- Dynamic channel preservation (Risk #1) ---

  it('preserves dynamic channels across reload', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    // Register a dynamic DM channel
    registerDynamicChannel({
      id: 'dm-123', platform: 'mattermost', bot: 'copilot',
      name: 'DM', workingDirectory: os.tmpdir(),
      triggerMode: 'all', threadedReplies: false, verbose: false, isDM: true,
    });

    // Reload — dynamic channel should survive
    const result = reloadConfig();
    expect(result.success).toBe(true);
    const channels = getConfig().channels;
    expect(channels.some(c => c.id === 'dm-123')).toBe(true);
  });

  it('preserves DM marking across reload', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    registerDynamicChannel({
      id: 'dm-456', platform: 'mattermost', bot: 'copilot',
      name: 'DM2', workingDirectory: os.tmpdir(),
      triggerMode: 'all', threadedReplies: false, verbose: false,
    });
    markChannelAsDM('dm-456');

    const result = reloadConfig();
    expect(result.success).toBe(true);
    const dm = getConfig().channels.find(c => c.id === 'dm-456');
    expect(dm?.isDM).toBe(true);
  });

  it('static config wins over dynamic channel on collision', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    // Register dynamic channel with same ID as static
    registerDynamicChannel({
      id: 'ch1', platform: 'mattermost', bot: 'copilot',
      name: 'Dynamic Override', workingDirectory: '/tmp/other',
      triggerMode: 'all', threadedReplies: false, verbose: false,
    });

    const result = reloadConfig();
    expect(result.success).toBe(true);
    // Static config's name should win (ch1 was already in static config, registerDynamicChannel was a no-op)
    const ch = getConfig().channels.find(c => c.id === 'ch1');
    expect(ch?.name).toBe('test');
  });

  // --- Channel removal grace (Risk #5) ---

  it('keeps removed channels in-memory after reload', () => {
    const cfg = makeConfig();
    cfg.channels.push({
      id: 'ch-temp', platform: 'mattermost', bot: 'copilot',
      name: 'temp', workingDirectory: os.tmpdir(),
      triggerMode: 'all', threadedReplies: false, verbose: false,
    });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    loadConfig(configFile);

    // Remove ch-temp from config file
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.changes.some(c => c.includes('ch-temp') && c.includes('removed'))).toBe(true);
    // But it's still in memory
    const channels = getConfig().channels;
    expect(channels.some(c => c.id === 'ch-temp')).toBe(true);
  });

  // --- Shared validation (Risk #4) ---

  it('loadConfig and reloadConfig reject the same invalid configs', () => {
    // Write a valid config, load it
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    // Write config with no channels — should now be valid (DMs auto-discovered)
    const noChannels = makeConfig();
    noChannels.channels = [];
    fs.writeFileSync(configFile, JSON.stringify(noChannels));

    // reloadConfig should succeed with empty channels
    const result = reloadConfig();
    expect(result.success).toBe(true);

    // loadConfig should also succeed
    _resetConfigForTest();
    const loaded = loadConfig(configFile);
    expect(loaded.channels).toEqual([]);
  });

  it('loadConfig and reloadConfig produce identical defaults', () => {
    const cfg = makeConfig();
    fs.writeFileSync(configFile, JSON.stringify(cfg));

    const loaded = loadConfig(configFile);
    const loadedDefaults = { ...loaded.defaults };

    // Reload same file
    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(getConfig().defaults).toEqual(loadedDefaults);
  });

  it('returns error if loadConfig was never called', () => {
    const result = reloadConfig();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No config path/);
  });

  it('detects bot config changes (non-token) as hot-reloadable', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);

    const updated = makeConfig();
    updated.platforms.mattermost.bots.copilot.admin = true;
    fs.writeFileSync(configFile, JSON.stringify(updated));

    const result = reloadConfig();
    expect(result.success).toBe(true);
    expect(result.changes.some(c => c.includes('copilot') && c.includes('config updated'))).toBe(true);
    expect(result.restartNeeded).toEqual([]);
  });
});

// --- interAgent config validation ---

describe('interAgent config validation', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    _resetConfigForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-ia-test-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    _resetConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads config with valid interAgent section', () => {
    const cfg = makeConfig({
      interAgent: {
        enabled: true,
        defaultTimeout: 30,
        maxTimeout: 120,
        maxDepth: 2,
        allow: {
          max: { canCall: ['alice'], canBeCalledBy: ['alice'] },
          alice: { canCall: ['max'], canBeCalledBy: ['max'] },
        },
      },
    });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    loadConfig(configFile);
    expect(getConfig().interAgent?.enabled).toBe(true);
    expect(getConfig().interAgent?.maxDepth).toBe(2);
    expect(getConfig().interAgent?.allow?.max?.canCall).toEqual(['alice']);
  });

  it('loads config without interAgent (defaults to undefined)', () => {
    fs.writeFileSync(configFile, JSON.stringify(makeConfig()));
    loadConfig(configFile);
    expect(getConfig().interAgent).toBeUndefined();
  });

  it('rejects non-boolean enabled', () => {
    const cfg = makeConfig({ interAgent: { enabled: 'yes' } });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect(() => loadConfig(configFile)).toThrow('interAgent.enabled must be a boolean');
  });

  it('rejects negative timeout', () => {
    const cfg = makeConfig({ interAgent: { enabled: false, defaultTimeout: -5 } });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect(() => loadConfig(configFile)).toThrow('interAgent.defaultTimeout must be a positive number');
  });

  it('rejects zero maxTimeout', () => {
    const cfg = makeConfig({ interAgent: { enabled: false, maxTimeout: 0 } });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect(() => loadConfig(configFile)).toThrow('interAgent.maxTimeout must be a positive number');
  });

  it('rejects non-integer maxDepth', () => {
    const cfg = makeConfig({ interAgent: { enabled: false, maxDepth: 2.5 } });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect(() => loadConfig(configFile)).toThrow('interAgent.maxDepth must be a positive integer');
  });

  it('rejects maxDepth of 0', () => {
    const cfg = makeConfig({ interAgent: { enabled: false, maxDepth: 0 } });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect(() => loadConfig(configFile)).toThrow('interAgent.maxDepth must be a positive integer');
  });

  it('rejects non-object allow', () => {
    const cfg = makeConfig({ interAgent: { enabled: true, allow: ['max'] } });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect(() => loadConfig(configFile)).toThrow('interAgent.allow must be an object');
  });

  it('rejects non-array canCall', () => {
    const cfg = makeConfig({ interAgent: { enabled: true, allow: { max: { canCall: 'alice' } } } });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect(() => loadConfig(configFile)).toThrow('canCall must be an array');
  });

  it('rejects non-array canBeCalledBy', () => {
    const cfg = makeConfig({ interAgent: { enabled: true, allow: { max: { canBeCalledBy: 'alice' } } } });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    expect(() => loadConfig(configFile)).toThrow('canBeCalledBy must be an array');
  });

  it('accepts wildcard in allowlist', () => {
    const cfg = makeConfig({
      interAgent: {
        enabled: true,
        allow: { summarizer: { canCall: [], canBeCalledBy: ['*'] } },
      },
    });
    fs.writeFileSync(configFile, JSON.stringify(cfg));
    loadConfig(configFile);
    expect(getConfig().interAgent?.allow?.summarizer?.canBeCalledBy).toEqual(['*']);
  });
});
