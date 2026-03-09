/**
 * OS-specific service file generation and installation.
 * Supports macOS (launchd) and Linux (systemd user units).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

export type Platform = 'macos' | 'linux' | 'unsupported';

export function detectPlatform(): Platform {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'linux': return 'linux';
    default: return 'unsupported';
  }
}

export function getNodePath(): string {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    return '/usr/local/bin/node';
  }
}

export function getSystemPath(): string {
  // Build a reasonable PATH that includes common Node install locations
  const platform = detectPlatform();
  if (platform === 'macos') {
    return '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
}

// --- launchd (macOS) ---

export interface LaunchdConfig {
  label: string;
  bridgePath: string;
  homePath: string;
}

export function generateLaunchdPlist(config: LaunchdConfig): string {
  const npxPath = path.join(path.dirname(getNodePath()), 'npx');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${config.label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${npxPath}</string>
        <string>tsx</string>
        <string>src/index.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${config.bridgePath}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${getSystemPath()}</string>
        <key>HOME</key>
        <string>${config.homePath}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>/tmp/copilot-bridge.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/copilot-bridge.log</string>
</dict>
</plist>`;
}

export function getLaunchdInstallPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.copilot-bridge.plist');
}

export function installLaunchd(plistContent: string): { installed: boolean; path: string; error?: string } {
  const installPath = getLaunchdInstallPath();
  try {
    const dir = path.dirname(installPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(installPath, plistContent, 'utf-8');
    execSync(`launchctl load "${installPath}"`, { encoding: 'utf-8' });
    return { installed: true, path: installPath };
  } catch (err) {
    return { installed: false, path: installPath, error: String(err) };
  }
}

// --- systemd (Linux) ---

export interface SystemdConfig {
  bridgePath: string;
  homePath: string;
  user: string;
}

export function generateSystemdUnit(config: SystemdConfig): string {
  const nodePath = getNodePath();
  return `[Unit]
Description=Copilot Bridge
After=network.target

[Service]
Type=simple
User=${config.user}
ExecStart=${nodePath} ${config.bridgePath}/dist/index.js
WorkingDirectory=${config.bridgePath}
Environment=HOME=${config.homePath}
Environment=PATH=${getSystemPath()}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target`;
}

export function getSystemdInstallPath(): string {
  return '/etc/systemd/system/copilot-bridge.service';
}

export function installSystemd(unitContent: string): { installed: boolean; path: string; error?: string } {
  const installPath = getSystemdInstallPath();
  try {
    fs.writeFileSync(installPath, unitContent, 'utf-8');
    execSync('sudo systemctl daemon-reload', { encoding: 'utf-8' });
    execSync('sudo systemctl enable copilot-bridge', { encoding: 'utf-8' });
    execSync('sudo systemctl start copilot-bridge', { encoding: 'utf-8' });
    return { installed: true, path: installPath };
  } catch (err) {
    return { installed: false, path: installPath, error: String(err) };
  }
}

// --- Service status ---

export function getServiceStatus(): { running: boolean; pid?: number; detail: string } {
  const platform = detectPlatform();

  if (platform === 'macos') {
    try {
      const output = execSync('launchctl list com.copilot-bridge 2>/dev/null', { encoding: 'utf-8' });
      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) {
        return { running: true, pid: parseInt(pidMatch[1], 10), detail: `launchd, PID ${pidMatch[1]}` };
      }
      // launchctl list succeeded but no PID — service loaded but not running
      return { running: false, detail: 'launchd: loaded but not running' };
    } catch {
      return { running: false, detail: 'launchd: not loaded' };
    }
  }

  if (platform === 'linux') {
    try {
      const output = execSync('systemctl is-active copilot-bridge 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (output === 'active') {
        try {
          const pid = execSync('systemctl show copilot-bridge --property=MainPID --value 2>/dev/null', { encoding: 'utf-8' }).trim();
          return { running: true, pid: parseInt(pid, 10), detail: `systemd, PID ${pid}` };
        } catch {
          return { running: true, detail: 'systemd: active' };
        }
      }
      return { running: false, detail: `systemd: ${output}` };
    } catch {
      return { running: false, detail: 'systemd: not installed' };
    }
  }

  return { running: false, detail: 'unsupported platform' };
}
