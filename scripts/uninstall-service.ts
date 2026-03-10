#!/usr/bin/env npx tsx
/**
 * copilot-bridge uninstall-service — Remove the bridge system service.
 *
 * macOS: unloads and removes the launchd plist
 * Linux: stops, disables, and removes the systemd unit (requires sudo)
 *
 * Usage: npm run uninstall-service
 *        npx tsx scripts/uninstall-service.ts
 */

import * as fs from 'node:fs';
import { heading, success, fail, info, dim, blank } from './lib/output.js';
import { detectPlatform, getLaunchdInstallPath, getSystemdInstallPath } from './lib/service.js';
import { execSync } from 'node:child_process';

function main() {
  const osPlatform = detectPlatform();

  heading('🗑️  copilot-bridge service uninstaller');
  blank();

  if (osPlatform === 'macos') {
    const plistPath = getLaunchdInstallPath();

    if (!fs.existsSync(plistPath)) {
      info('No launchd service found — nothing to uninstall.');
      return;
    }

    info(`Unloading and removing ${plistPath}`);

    try {
      // bootout is the modern replacement for unload
      execSync(`launchctl bootout gui/$(id -u) "${plistPath}" 2>/dev/null || launchctl unload "${plistPath}" 2>/dev/null`, {
        stdio: 'inherit',
      });
    } catch {
      // Service may not be loaded — that's fine
    }

    try {
      fs.unlinkSync(plistPath);
      blank();
      success('Service uninstalled.');
    } catch (err) {
      fail(`Failed to remove plist: ${err}`);
      process.exit(1);
    }

  } else if (osPlatform === 'linux') {
    const unitPath = getSystemdInstallPath();

    if (!fs.existsSync(unitPath)) {
      info('No systemd service found — nothing to uninstall.');
      return;
    }

    const isRoot = process.getuid?.() === 0;
    if (!isRoot) {
      info('This requires sudo to remove from /etc/systemd/system/.');
      blank();
    }

    try {
      execSync('sudo systemctl stop copilot-bridge 2>/dev/null || true', { stdio: 'inherit' });
      execSync('sudo systemctl disable copilot-bridge 2>/dev/null || true', { stdio: 'inherit' });
      execSync(`sudo rm "${unitPath}"`, { stdio: 'inherit' });
      execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
      blank();
      success('Service uninstalled.');
    } catch {
      blank();
      fail('Automatic uninstall failed (sudo may have been denied).');
      blank();
      info('To uninstall manually:');
      dim('  sudo systemctl stop copilot-bridge');
      dim('  sudo systemctl disable copilot-bridge');
      dim(`  sudo rm ${unitPath}`);
      dim('  sudo systemctl daemon-reload');
      process.exit(1);
    }

  } else {
    fail('Unsupported platform — no service to uninstall.');
    process.exit(1);
  }
}

main();
