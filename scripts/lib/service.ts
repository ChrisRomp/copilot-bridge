/**
 * OS-specific service file generation and installation.
 * Supports macOS (launchd) and Linux (systemd system-level units).
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
  // Include the directory containing the current node binary (e.g., nvm paths)
  const nodeBinDir = path.dirname(getNodePath());
  const platform = detectPlatform();
  const basePath = platform === 'macos'
    ? '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  // Prepend node's bin dir if not already in the base path
  if (basePath.split(':').includes(nodeBinDir)) return basePath;
  return `${nodeBinDir}:${basePath}`;
}

export function getLogPath(homePath: string): string {
  return path.join(homePath, '.copilot-bridge', 'copilot-bridge.log');
}

// --- launchd (macOS) ---

export interface LaunchdConfig {
  label: string;
  bridgePath: string;
  homePath: string;
}

export function generateLaunchdPlist(config: LaunchdConfig): string {
  const nodePath = getNodePath();
  const tsxPath = path.join(config.bridgePath, 'node_modules', '.bin', 'tsx');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${config.label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${tsxPath}</string>
        <string>dist/index.js</string>
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

    <key>Umask</key>
    <integer>63</integer>
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
    // Unload existing service before overwriting (ignore errors if not loaded)
    try { execSync(`launchctl bootout gui/$(id -u) "${installPath}" 2>/dev/null`, { encoding: 'utf-8' }); } catch { /* not loaded */ }
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
  const tsxPath = path.join(config.bridgePath, 'node_modules', '.bin', 'tsx');
  return `[Unit]
Description=Copilot Bridge
After=network.target

[Service]
Type=simple
User=${config.user}
ExecStart="${nodePath}" "${tsxPath}" "${config.bridgePath}/dist/index.js"
WorkingDirectory=${config.bridgePath}
Environment=HOME=${config.homePath}
Environment=PATH=${getSystemPath()}
Restart=always
RestartSec=10
UMask=0077

[Install]
WantedBy=multi-user.target`;
}

export function getSystemdInstallPath(): string {
  return '/etc/systemd/system/copilot-bridge.service';
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
      // systemctl is-active exits non-zero for inactive/unknown services
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
    } catch (err) {
      // Exit code 3 = inactive/dead (unit exists but not running)
      // Exit code 4 = no such unit file
      const stdout = err instanceof Error && 'stdout' in err ? String((err as { stdout: unknown }).stdout).trim() : '';
      if (stdout === 'inactive' || stdout === 'failed' || stdout === 'activating' || stdout === 'deactivating') {
        return { running: false, detail: `systemd: ${stdout}` };
      }
      return { running: false, detail: 'systemd: not installed' };
    }
  }

  return { running: false, detail: 'unsupported platform' };
}
