#!/usr/bin/env npx tsx
/**
 * copilot-bridge init — Interactive setup wizard.
 *
 * Usage: npm run init
 *        npx tsx scripts/init.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { heading, success, warn, fail, info, dim, blank, printCheck } from './lib/output.js';
import { askRequired, askSecret, confirm, choose, closePrompts } from './lib/prompts.js';
import { runAllPrereqs, checkNodeVersion } from './lib/prerequisites.js';
import { pingServer, validateBotToken, checkChannelAccess, getChannelInfo } from './lib/mattermost.js';
import { buildConfig, writeConfig, configExists, getConfigPath, getConfigDir, type BotEntry, type ChannelEntry, type ConfigDefaults } from './lib/config-gen.js';
import { detectPlatform } from './lib/service.js';

async function main() {
  const isCli = process.env.COPILOT_BRIDGE_CLI === '1';
  console.log();
  heading('🚀 copilot-bridge setup');
  dim('Interactive wizard to configure copilot-bridge.\n');

  // --- Step 1: Prerequisites ---
  heading('Step 1: Prerequisites');

  const nodeCheck = checkNodeVersion();
  printCheck(nodeCheck);
  if (nodeCheck.status === 'fail') {
    fail('Node.js 20+ is required. Please upgrade and re-run.');
    process.exit(1);
  }

  const prereqs = runAllPrereqs();
  // Skip node (already printed); print Copilot CLI and auth
  for (const check of prereqs.slice(1)) {
    printCheck(check);
  }

  const hasFail = prereqs.some(c => c.status === 'fail');
  if (hasFail) {
    blank();
    warn('Some prerequisites failed. You can continue setup, but the bridge may not work until they are resolved.');
    if (!await confirm('Continue anyway?', false)) {
      process.exit(1);
    }
  }

  // --- Check for existing config ---
  if (configExists()) {
    blank();
    warn(`Existing config found at ${getConfigPath()}`);
    if (!await confirm('Overwrite with a new config?', false)) {
      info(isCli
        ? 'Run "copilot-bridge check" to validate your existing config.'
        : 'Run "npm run check" to validate your existing config.');
      closePrompts();
      process.exit(0);
    }
  }

  // --- Step 2: Mattermost connection ---
  heading('Step 2: Mattermost Connection');
  info('Connect to your Mattermost instance. You\'ll need the URL and a bot token.');
  dim('Create bot accounts in Mattermost: System Console → Integrations → Bot Accounts\n');

  let mmUrl = '';
  while (true) {
    mmUrl = await askRequired('Mattermost URL (e.g., https://chat.example.com)');
    mmUrl = mmUrl.replace(/\/+$/, '');
    if (!mmUrl.startsWith('http')) mmUrl = `https://${mmUrl}`;

    const ping = await pingServer(mmUrl);
    printCheck(ping);
    if (ping.status === 'pass' || ping.status === 'warn') break;
    if (!await confirm('Try a different URL?')) {
      warn('Continuing with unverified URL.');
      break;
    }
  }

  // --- Step 3: Bot configuration ---
  heading('Step 3: Bot Configuration');

  const bots: BotEntry[] = [];
  let addMore = true;

  while (addMore) {
    if (bots.length === 0) {
      info('Enter the bot token from your Mattermost bot account.');
      dim('You can add more bots later if you want multiple identities.\n');
    }

    const token = await askSecret(`Bot token${bots.length > 0 ? ' (for next bot)' : ''}`);
    const validation = await validateBotToken(mmUrl, token);
    printCheck(validation.result);

    if (validation.result.status === 'pass' && validation.bot) {
      const isAdmin = validation.bot.roles?.includes('system_admin')
        || await confirm(`Is "${validation.bot.username}" an admin bot?`, false);

      bots.push({
        name: validation.bot.username,
        token,
        admin: !!isAdmin,
      });
      success(`Added bot "${validation.bot.username}"${isAdmin ? ' (admin)' : ''}`);
    } else {
      warn(isCli
        ? 'Token validation failed. The token was still added — verify it later with "copilot-bridge check".'
        : 'Token validation failed. The token was still added — verify it later with "npm run check".');
      let name = await askRequired('Bot username (for config)');
      name = name.replace(/^@/, '');
      bots.push({ name, token, admin: false });
    }

    if (bots.length >= 1) {
      addMore = await confirm('Add another bot?', false);
    }
  }

  // --- Step 4: Channel configuration ---
  heading('Step 4: Channel Configuration');
  info('Direct messages work automatically — no config needed.');
  info('Group channels need their channel ID and a working directory.\n');

  const channels: ChannelEntry[] = [];
  let addChannels = await confirm('Configure group channels now?', false);

  while (addChannels) {
    const channelId = await askRequired('Channel ID (from Mattermost channel settings → View Info)');

    // Validate channel access
    const primaryBot = bots[0];
    const access = await checkChannelAccess(mmUrl, primaryBot.token, channelId);
    printCheck(access);

    let channelName: string | undefined;
    if (access.status === 'pass') {
      const chInfo = await getChannelInfo(mmUrl, primaryBot.token, channelId);
      channelName = chInfo?.displayName || chInfo?.name;
    }

    const workDir = await askRequired('Working directory (absolute path for this channel\'s workspace)');

    // Create working directory if it doesn't exist
    if (!fs.existsSync(workDir)) {
      if (await confirm(`Directory "${workDir}" doesn't exist. Create it?`)) {
        fs.mkdirSync(workDir, { recursive: true });
        success(`Created ${workDir}`);
      }
    }

    // If multiple bots, ask which one
    let botName = bots[0].name;
    if (bots.length > 1) {
      const idx = await choose('Which bot for this channel?', bots.map(b => b.name));
      botName = bots[idx].name;
    }

    channels.push({
      id: channelId,
      name: channelName,
      platform: 'mattermost',
      bot: botName,
      workingDirectory: workDir,
    });
    success(`Added channel${channelName ? ` "${channelName}"` : ''}`);

    addChannels = await confirm('Add another channel?', false);
  }

  if (channels.length === 0) {
    info('No group channels configured. DMs will still work automatically.');
  }

  // --- Step 5: Defaults ---
  heading('Step 5: Defaults');
  dim('These can be changed later in config.json or via chat commands.\n');

  const defaults: ConfigDefaults = {};

  const modelChoice = await choose('Default model?', [
    'claude-sonnet-4.6 (recommended)',
    'claude-opus-4.6 (premium)',
    'claude-haiku-4.5 (fast/cheap)',
    'Other (enter manually)',
  ]);
  if (modelChoice === 3) {
    defaults.model = await askRequired('Model name');
  } else {
    defaults.model = ['claude-sonnet-4.6', 'claude-opus-4.6', 'claude-haiku-4.5'][modelChoice];
  }

  const triggerChoice = await choose('Default trigger mode (for group channels — DMs always respond)?', [
    'mention — bot responds only when @mentioned (recommended)',
    'all — bot responds to every message in the channel',
  ]);
  defaults.triggerMode = triggerChoice === 0 ? 'mention' : 'all';
  defaults.threadedReplies = await confirm('Reply in threads by default?', true);
  defaults.verbose = await confirm('Verbose mode (show tool calls)?', false);

  // --- Step 6: Generate config ---
  heading('Step 6: Generate Config');

  const config = buildConfig({ mmUrl, bots, channels, defaults });
  const configPath = writeConfig(config);
  success(`Config written to ${configPath}`);

  // Ensure workspaces dir exists
  const workspacesDir = path.join(getConfigDir(), 'workspaces');
  if (!fs.existsSync(workspacesDir)) {
    fs.mkdirSync(workspacesDir, { recursive: true });
  }

  // --- Step 7: Service setup ---
  heading('Step 7: Service Setup (Optional)');

  const osPlatform = detectPlatform();
  if (osPlatform === 'macos') {
    info('To run as a launchd service (auto-start at login):');
    dim(isCli ? '  copilot-bridge install-service\n' : '  npm run install-service\n');
  } else if (osPlatform === 'linux') {
    info('To run as a systemd service (auto-start at boot):');
    dim(isCli ? '  copilot-bridge install-service' : '  npm run install-service');
    dim('  (requires sudo — installs to /etc/systemd/system/)\n');
    if (!isCli) dim('  Note: build first with npm run build\n');
  } else {
    info(isCli
      ? 'Run the bridge manually: copilot-bridge start'
      : 'Run the bridge manually: npm run dev (development) or npm start (production)');
  }

  // --- Done ---
  heading('✅ Setup Complete');
  blank();
  info(`Config: ${configPath}`);
  info(`Bots: ${bots.map(b => b.name).join(', ')}`);
  if (channels.length > 0) info(`Channels: ${channels.length} configured`);
  info('DMs: enabled automatically');
  blank();

  dim('Next steps:');
  if (isCli) {
    dim('  copilot-bridge check            Validate your setup');
    dim('  copilot-bridge start            Start the bridge');
    dim('  copilot-bridge install-service  Install as a system service');
  } else {
    dim('  npm run dev              Start in development mode (watch)');
    dim('  npm run check            Validate your setup');
    dim('  npm run install-service  Install as a system service');
    dim('  npm run build            Build for production');
    dim('  npm start                Start production server');
  }
  blank();

  closePrompts();
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message || err);
  closePrompts();
  process.exit(1);
});
