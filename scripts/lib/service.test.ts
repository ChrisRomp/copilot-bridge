import { describe, it, expect } from 'vitest';
import {
  detectPlatform,
  getNodePath,
  generateLaunchdPlist,
  generateSystemdUnit,
  getLaunchdInstallPath,
  getSystemdInstallPath,
  getLogPath,
} from './service.js';
import * as os from 'node:os';
import * as path from 'node:path';

describe('service', () => {
  describe('detectPlatform', () => {
    it('returns macos or linux based on current OS', () => {
      const platform = detectPlatform();
      if (process.platform === 'darwin') {
        expect(platform).toBe('macos');
      } else if (process.platform === 'linux') {
        expect(platform).toBe('linux');
      } else {
        expect(platform).toBe('unsupported');
      }
    });
  });

  describe('getNodePath', () => {
    it('returns a path to node', () => {
      const nodePath = getNodePath();
      expect(nodePath).toMatch(/node/);
    });
  });

  describe('generateLaunchdPlist', () => {
    it('generates valid plist XML', () => {
      const plist = generateLaunchdPlist({
        label: 'com.copilot-bridge',
        bridgePath: '/Users/test/copilot-bridge',
        homePath: '/Users/test',
      });

      expect(plist).toContain('<?xml version="1.0"');
      expect(plist).toContain('<string>com.copilot-bridge</string>');
      expect(plist).toContain('/Users/test/copilot-bridge');
      expect(plist).toContain('/Users/test</string>');
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<key>KeepAlive</key>');
      expect(plist).toContain('tsx');
      expect(plist).toContain('dist/index.js');
    });

    it('does not include StandardOutPath/StandardErrorPath (self-managed logging)', () => {
      const plist = generateLaunchdPlist({
        label: 'com.copilot-bridge',
        bridgePath: '/Users/test/copilot-bridge',
        homePath: '/Users/test',
      });

      expect(plist).not.toContain('StandardOutPath');
      expect(plist).not.toContain('StandardErrorPath');
    });

    it('includes Umask key', () => {
      const plist = generateLaunchdPlist({
        label: 'com.copilot-bridge',
        bridgePath: '/Users/test/copilot-bridge',
        homePath: '/Users/test',
      });

      expect(plist).toContain('<key>Umask</key>');
      expect(plist).toContain('<integer>63</integer>');
    });
  });

  describe('generateSystemdUnit', () => {
    it('generates valid systemd unit', () => {
      const unit = generateSystemdUnit({
        bridgePath: '/home/test/copilot-bridge',
        homePath: '/home/test',
        user: 'test',
      });

      expect(unit).toContain('[Unit]');
      expect(unit).toContain('[Service]');
      expect(unit).toContain('[Install]');
      expect(unit).toContain('Copilot Bridge');
      expect(unit).toContain('/home/test/copilot-bridge');
      expect(unit).toContain('tsx');
      expect(unit).toContain('dist/index.js');
      expect(unit).toContain('Restart=always');
      expect(unit).toContain('WantedBy=multi-user.target');
    });

    it('includes UMask directive', () => {
      const unit = generateSystemdUnit({
        bridgePath: '/home/test/copilot-bridge',
        homePath: '/home/test',
        user: 'test',
      });

      expect(unit).toContain('UMask=0077');
    });

    it('quotes paths in ExecStart for spaces', () => {
      const unit = generateSystemdUnit({
        bridgePath: '/home/test/my project/copilot-bridge',
        homePath: '/home/test',
        user: 'test',
      });

      expect(unit).toMatch(/ExecStart="[^"]*" "[^"]*" "[^"]*"/);
    });
  });

  describe('getLogPath', () => {
    it('returns path under .copilot-bridge', () => {
      expect(getLogPath('/Users/test')).toBe('/Users/test/.copilot-bridge/copilot-bridge.log');
      expect(getLogPath('/home/test')).toBe('/home/test/.copilot-bridge/copilot-bridge.log');
    });
  });

  describe('install paths', () => {
    it('launchd path is under LaunchAgents', () => {
      const p = getLaunchdInstallPath();
      expect(p).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.copilot-bridge.plist'));
    });

    it('systemd path is /etc/systemd/system/', () => {
      const p = getSystemdInstallPath();
      expect(p).toBe('/etc/systemd/system/copilot-bridge.service');
    });
  });
});
