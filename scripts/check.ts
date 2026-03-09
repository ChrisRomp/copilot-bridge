#!/usr/bin/env npx tsx
/**
 * copilot-bridge check — Validate an existing installation.
 *
 * Usage: npm run check
 *        npx tsx scripts/check.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { heading, printCheck, printSummary, info, blank, dim, type CheckResult } from './lib/output.js';
import { runAllPrereqs } from './lib/prerequisites.js';
import { pingServer, validateBotToken, checkChannelAccess } from './lib/mattermost.js';
import { getConfigPath, getConfigDir, readExistingConfig } from './lib/config-gen.js';
import { detectPlatform, getServiceStatus } from './lib/service.js';

async function main() {
  console.log();
  heading('🔍 copilot-bridge check');
  dim('Validating your installation...\n');

  const results: CheckResult[] = [];

  // --- Prerequisites ---
  heading('Prerequisites');
  const prereqs = runAllPrereqs();
  for (const check of prereqs) {
    printCheck(check);
    results.push(check);
  }

  // --- Config file ---
  heading('Configuration');
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    const result: CheckResult = { status: 'fail', label: 'Config file', detail: `not found at ${configPath}` };
    printCheck(result);
    results.push(result);
    info('Run "npm run init" to create a config file.');
    printSummary(results);
    process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
  }

  // Parse config
  let config: any;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
    const result: CheckResult = { status: 'pass', label: `Config: ${configPath}` };
    printCheck(result);
    results.push(result);
  } catch (err: any) {
    const result: CheckResult = { status: 'fail', label: 'Config file', detail: `invalid JSON: ${err.message}` };
    printCheck(result);
    results.push(result);
    printSummary(results);
    process.exit(1);
  }

  // Validate required fields
  if (!config.platforms?.mattermost) {
    const result: CheckResult = { status: 'fail', label: 'Config structure', detail: 'missing platforms.mattermost' };
    printCheck(result);
    results.push(result);
  } else {
    const result: CheckResult = { status: 'pass', label: 'Config structure', detail: 'platforms.mattermost present' };
    printCheck(result);
    results.push(result);
  }

  if (!config.channels || !Array.isArray(config.channels) || config.channels.length === 0) {
    const result: CheckResult = { status: 'warn', label: 'Channels', detail: 'none configured — DMs will still work' };
    printCheck(result);
    results.push(result);
  }

  // --- Mattermost connectivity ---
  const mmConfig = config.platforms?.mattermost;
  if (mmConfig?.url) {
    heading('Mattermost');
    const pingResult = await pingServer(mmConfig.url);
    printCheck(pingResult);
    results.push(pingResult);

    // Validate bot tokens
    const bots: Array<{ name: string; token: string }> = [];

    if (mmConfig.botToken) {
      bots.push({ name: 'default', token: mmConfig.botToken });
    }
    if (mmConfig.bots && typeof mmConfig.bots === 'object') {
      for (const [name, botConfig] of Object.entries(mmConfig.bots)) {
        if ((botConfig as any)?.token) {
          bots.push({ name, token: (botConfig as any).token });
        }
      }
    }

    if (bots.length === 0) {
      const result: CheckResult = { status: 'fail', label: 'Bot tokens', detail: 'no botToken or bots configured' };
      printCheck(result);
      results.push(result);
    }

    for (const bot of bots) {
      const validation = await validateBotToken(mmConfig.url, bot.token);
      printCheck(validation.result);
      results.push(validation.result);
    }

    // Validate channel access
    if (config.channels?.length > 0) {
      heading('Channels (from config)');
      const primaryToken = bots[0]?.token;
      if (primaryToken) {
        for (const ch of config.channels) {
          const channelBot = bots.find(b => b.name === ch.bot) || bots[0];
          const access = await checkChannelAccess(mmConfig.url, channelBot.token, ch.id, ch.name);
          printCheck(access);
          results.push(access);
        }
      }
    }
  }

  // --- Working directories ---
  if (config.channels?.length > 0) {
    heading('Working Directories');
    for (const ch of config.channels) {
      if (!ch.workingDirectory) {
        const result: CheckResult = { status: 'warn', label: `Channel ${ch.id}`, detail: 'no workingDirectory set' };
        printCheck(result);
        results.push(result);
        continue;
      }
      if (fs.existsSync(ch.workingDirectory)) {
        const result: CheckResult = { status: 'pass', label: ch.workingDirectory };
        printCheck(result);
        results.push(result);
      } else {
        const result: CheckResult = { status: 'fail', label: ch.workingDirectory, detail: 'directory does not exist' };
        printCheck(result);
        results.push(result);
      }
    }
  }

  // --- Database ---
  heading('Database');
  const dbPath = path.join(getConfigDir(), 'state.db');
  let dbExists = false;
  if (fs.existsSync(dbPath)) {
    dbExists = true;
    const stats = fs.statSync(dbPath);
    const sizeKb = Math.round(stats.size / 1024);
    const result: CheckResult = { status: 'pass', label: `Database: ${dbPath}`, detail: `${sizeKb} KB` };
    printCheck(result);
    results.push(result);
  } else {
    const result: CheckResult = { status: 'warn', label: 'Database', detail: `not yet created at ${dbPath} — will be created on first run` };
    printCheck(result);
    results.push(result);
  }

  // --- Dynamic channels (from database) ---
  if (dbExists) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath, { readonly: true });
      const dynamicChannels = db.prepare(
        'SELECT channel_id, platform, bot, is_dm FROM dynamic_channels'
      ).all() as Array<{ channel_id: string; platform: string; bot: string; is_dm: number }>;
      db.close();

      if (dynamicChannels.length > 0) {
        heading('Dynamic Channels (from database)');
        dim('  Auto-discovered channels not in config.json (DMs, etc.)');
        const dmCount = dynamicChannels.filter(c => c.is_dm).length;
        const groupCount = dynamicChannels.length - dmCount;
        const parts: string[] = [];
        if (dmCount > 0) parts.push(`${dmCount} DM(s)`);
        if (groupCount > 0) parts.push(`${groupCount} group channel(s)`);
        const result: CheckResult = {
          status: 'pass',
          label: `${dynamicChannels.length} dynamic channel(s)`,
          detail: parts.join(', '),
        };
        printCheck(result);
        results.push(result);
      }
    } catch {
      // DB might not have dynamic_channels table yet — not an error
    }
  }

  // --- Workspaces ---
  heading('Workspaces');
  const workspacesDir = path.join(getConfigDir(), 'workspaces');
  if (fs.existsSync(workspacesDir)) {
    const botDirs = fs.readdirSync(workspacesDir).filter(f =>
      fs.statSync(path.join(workspacesDir, f)).isDirectory()
    );
    if (botDirs.length > 0) {
      const result: CheckResult = { status: 'pass', label: `Workspaces: ${botDirs.length} bot(s)`, detail: botDirs.join(', ') };
      printCheck(result);
      results.push(result);
    } else {
      const result: CheckResult = { status: 'warn', label: 'Workspaces', detail: 'directory exists but no bots initialized yet' };
      printCheck(result);
      results.push(result);
    }
  } else {
    const result: CheckResult = { status: 'warn', label: 'Workspaces', detail: 'not yet created — will be initialized on first run' };
    printCheck(result);
    results.push(result);
  }

  // --- Service status ---
  heading('Service');
  const serviceStatus = getServiceStatus();
  if (serviceStatus.running) {
    const result: CheckResult = { status: 'pass', label: 'Service running', detail: serviceStatus.detail };
    printCheck(result);
    results.push(result);
  } else {
    const platform = detectPlatform();
    const serviceHint = platform === 'macos'
      ? 'install with: npm run init (or manually via launchd)'
      : platform === 'linux'
        ? 'install with: npm run init (or manually via systemd)'
        : 'start with: npm run dev (or npm start)';
    const result: CheckResult = { status: 'warn', label: 'Service not running', detail: serviceHint };
    printCheck(result);
    results.push(result);
  }

  // --- MCP servers (optional) ---
  const mcpConfigPath = path.join(os.homedir(), '.copilot', 'mcp-config.json');
  if (fs.existsSync(mcpConfigPath)) {
    heading('MCP Servers (user-level)');
    dim(`  ${mcpConfigPath}`);
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      const servers = Object.keys(mcpConfig.mcpServers || {});
      if (servers.length > 0) {
        const result: CheckResult = { status: 'pass', label: `MCP: ${servers.length} server(s)`, detail: servers.join(', ') };
        printCheck(result);
        results.push(result);
      }
    } catch {
      const result: CheckResult = { status: 'warn', label: 'MCP config', detail: 'exists but could not parse' };
      printCheck(result);
      results.push(result);
    }
  }

  // --- Summary ---
  printSummary(results);
  process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
}

main().catch((err) => {
  console.error('\nCheck failed:', err.message || err);
  process.exit(1);
});
