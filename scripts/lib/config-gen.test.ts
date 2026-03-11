import { describe, it, expect } from 'vitest';
import {
  buildConfig,
  getConfigDir,
  getConfigPath,
  type BotEntry,
  type ChannelEntry,
} from './config-gen.js';
import * as os from 'node:os';
import * as path from 'node:path';

describe('config-gen', () => {
  describe('buildConfig', () => {
    it('generates single-bot config with named bots object', () => {
      const bots: BotEntry[] = [{ name: 'copilot', token: 'tok123', admin: true }];
      const channels: ChannelEntry[] = [{
        id: 'ch1',
        name: 'general',
        platform: 'mattermost',
        bot: 'copilot',
        workingDirectory: '/tmp/project',
      }];

      const config = buildConfig({
        mmUrl: 'https://chat.example.com',
        bots,
        channels,
      });

      expect(config.platforms.mattermost.bots).toBeDefined();
      expect(config.platforms.mattermost.bots!['copilot'].token).toBe('tok123');
      expect(config.platforms.mattermost.bots!['copilot'].admin).toBe(true);
      expect(config.channels).toHaveLength(1);
      expect(config.channels[0].id).toBe('ch1');
      expect(config.channels[0].bot).toBe('copilot');
      expect(config.channels[0].workingDirectory).toBe('/tmp/project');
    });

    it('generates multi-bot config with bots object', () => {
      const bots: BotEntry[] = [
        { name: 'copilot', token: 'tok1', admin: true },
        { name: 'alice', token: 'tok2', admin: false, agent: 'alice-agent' },
      ];
      const channels: ChannelEntry[] = [{
        id: 'ch1',
        platform: 'mattermost',
        bot: 'copilot',
        workingDirectory: '/tmp/project',
      }];

      const config = buildConfig({ mmUrl: 'https://mm.test', bots, channels });

      expect(config.platforms.mattermost.bots).toBeDefined();
      expect(config.platforms.mattermost.bots!['copilot'].token).toBe('tok1');
      expect(config.platforms.mattermost.bots!['copilot'].admin).toBe(true);
      expect(config.platforms.mattermost.bots!['alice'].agent).toBe('alice-agent');
      // Multi-bot — bot field present on channel
      expect(config.channels[0].bot).toBe('copilot');
    });

    it('includes defaults when provided', () => {
      const config = buildConfig({
        mmUrl: 'https://mm.test',
        bots: [{ name: 'bot', token: 'tok', admin: false }],
        channels: [],
        defaults: { model: 'claude-opus-4.6', triggerMode: 'all', verbose: true },
      });

      expect(config.defaults?.model).toBe('claude-opus-4.6');
      expect(config.defaults?.triggerMode).toBe('all');
      expect(config.defaults?.verbose).toBe(true);
    });

    it('omits empty defaults', () => {
      const config = buildConfig({
        mmUrl: 'https://mm.test',
        bots: [{ name: 'bot', token: 'tok', admin: false }],
        channels: [],
        defaults: {},
      });

      // Empty defaults should have no keys
      expect(Object.keys(config.defaults || {})).toHaveLength(0);
    });

    it('stores URL as-is from input', () => {
      // URL cleaning happens at the init wizard level; buildConfig stores as provided
      const config = buildConfig({
        mmUrl: 'https://mm.test',
        bots: [{ name: 'bot', token: 'tok', admin: false }],
        channels: [],
      });
      expect(config.platforms.mattermost.url).toBe('https://mm.test');
    });

    it('includes access config for Mattermost bots', () => {
      const config = buildConfig({
        mmUrl: 'https://mm.test',
        bots: [{ name: 'bot', token: 'tok', admin: false, access: { mode: 'allowlist', users: ['chris'] } }],
        channels: [],
      });
      expect(config.platforms.mattermost!.bots!.bot.access).toEqual({ mode: 'allowlist', users: ['chris'] });
    });

    it('includes access config for Slack bots', () => {
      const config = buildConfig({
        bots: [],
        channels: [],
        slackBots: [{ name: 'bot', token: 'xoxb-tok', appToken: 'xapp-tok', admin: false, access: { mode: 'allowlist', users: ['U123'] } }],
      });
      expect(config.platforms.slack!.bots!.bot.access).toEqual({ mode: 'allowlist', users: ['U123'] });
    });

    it('omits access when not provided', () => {
      const config = buildConfig({
        mmUrl: 'https://mm.test',
        bots: [{ name: 'bot', token: 'tok', admin: false }],
        channels: [],
      });
      expect(config.platforms.mattermost!.bots!.bot.access).toBeUndefined();
    });
  });

  describe('paths', () => {
    it('returns config dir under home', () => {
      expect(getConfigDir()).toBe(path.join(os.homedir(), '.copilot-bridge'));
    });

    it('returns config path as config.json', () => {
      expect(getConfigPath()).toBe(path.join(os.homedir(), '.copilot-bridge', 'config.json'));
    });
  });
});
