#!/usr/bin/env npx tsx
/**
 * copilot-bridge install-service — Install the bridge as a system service.
 *
 * macOS: installs a launchd plist (user-level, no sudo needed)
 * Linux: installs a systemd unit (system-level, requires sudo)
 *
 * Usage: npm run install-service
 *        npx tsx scripts/install-service.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { heading, success, fail, info, dim, blank } from './lib/output.js';
import {
  detectPlatform,
  generateLaunchdPlist, installLaunchd, getLaunchdInstallPath,
  generateSystemdUnit, getSystemdInstallPath,
} from './lib/service.js';
import { execSync } from 'node:child_process';

function main() {
  const isCli = process.env.COPILOT_BRIDGE_CLI === '1';
  const osPlatform = detectPlatform();
  const bridgePath = process.cwd();
  const homePath = os.homedir();
  const user = os.userInfo().username;

  heading('📦 copilot-bridge service installer');
  blank();

  if (osPlatform === 'macos') {
    info('macOS detected — installing launchd service.');
    dim('The service auto-starts at login and restarts on crash.\n');

    const distPath = path.join(bridgePath, 'dist', 'index.js');
    if (!fs.existsSync(distPath)) {
      fail(isCli
        ? 'dist/index.js not found. Package may be corrupted — try reinstalling.'
        : 'dist/index.js not found. Run "npm run build" first.');
      process.exit(1);
    }

    const plist = generateLaunchdPlist({
      label: 'com.copilot-bridge',
      bridgePath,
      homePath,
    });

    const installPath = getLaunchdInstallPath();
    if (fs.existsSync(installPath)) {
      info(`Overwriting existing service at ${installPath}`);
    }

    const result = installLaunchd(plist);
    if (result.installed) {
      success(`Service installed at ${result.path}`);
      blank();
      dim('Management:');
      dim('  launchctl list com.copilot-bridge                     # status');
      dim('  launchctl kickstart -k gui/$(id -u)/com.copilot-bridge  # restart');
      dim('  tail -f /tmp/copilot-bridge.log                        # logs');
    } else {
      fail(`Install failed: ${result.error}`);
      process.exit(1);
    }

  } else if (osPlatform === 'linux') {
    info('Linux detected — installing systemd service (system-scoped).');
    dim('The service starts at boot and restarts on crash.\n');

    const distPath = path.join(bridgePath, 'dist', 'index.js');
    if (!fs.existsSync(distPath)) {
      fail(isCli
        ? 'dist/index.js not found. Package may be corrupted — try reinstalling.'
        : 'dist/index.js not found. Run "npm run build" first.');
      process.exit(1);
    }

    const unit = generateSystemdUnit({ bridgePath, homePath, user });
    const installPath = getSystemdInstallPath();
    const tmpPath = path.join(os.tmpdir(), 'copilot-bridge.service');

    // Write to temp, then sudo copy
    fs.writeFileSync(tmpPath, unit, 'utf-8');

    const isRoot = process.getuid?.() === 0;
    if (!isRoot) {
      info('This requires sudo to install to /etc/systemd/system/.');
      blank();
    }

    try {
      execSync(`sudo cp "${tmpPath}" "${installPath}"`, { stdio: 'inherit' });
      fs.unlinkSync(tmpPath);
      execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
      execSync('sudo systemctl enable copilot-bridge', { stdio: 'inherit' });
      execSync('sudo systemctl start copilot-bridge', { stdio: 'inherit' });
      blank();
      success(`Service installed and started at ${installPath}`);
      blank();
      dim('Management:');
      dim('  sudo systemctl status copilot-bridge    # status');
      dim('  sudo systemctl restart copilot-bridge   # restart');
      dim('  sudo journalctl -u copilot-bridge -f    # logs');
    } catch {
      // sudo was denied or failed — leave temp file and show manual steps
      blank();
      fail('Automatic install failed (sudo may have been denied).');
      blank();
      info(`Service file written to: ${tmpPath}`);
      info('To install manually:');
      dim(`  sudo cp ${tmpPath} ${installPath}`);
      dim('  sudo systemctl daemon-reload');
      dim('  sudo systemctl enable --now copilot-bridge');
      process.exit(1);
    }

  } else {
    fail('Unsupported platform for automatic service install.');
    info(isCli
      ? 'Run the bridge manually: copilot-bridge start'
      : 'Run the bridge manually: npm run dev (development) or npm start (production)');
    process.exit(1);
  }
}

main();
