#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const commands = {
  start: join(root, 'dist', 'index.js'),
  init: join(root, 'scripts', 'init.ts'),
  check: join(root, 'scripts', 'check.ts'),
  'install-service': join(root, 'scripts', 'install-service.ts'),
  'uninstall-service': join(root, 'scripts', 'uninstall-service.ts'),
};

const command = process.argv[2];

if (!command || command === '--help' || command === '-h') {
  console.log(`copilot-bridge — Mattermost ↔ GitHub Copilot bridge

Usage: copilot-bridge <command>

Commands:
  init               Interactive setup wizard
  check              Validate configuration
  start              Start the bridge
  install-service    Install as system service
  uninstall-service  Remove system service

Options:
  --help, -h         Show this help
  --version, -v      Show version`);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const script = commands[command];
if (!script) {
  console.error(`Unknown command: ${command}\nRun 'copilot-bridge --help' for usage.`);
  process.exit(1);
}

// Use --import tsx/esm for TypeScript and ESM compatibility
const child = spawn(process.execPath, ['--import', 'tsx/esm', script, ...process.argv.slice(3)], {
  stdio: 'inherit',
  cwd: root,
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error(`Failed to run command: ${err.message}`);
  process.exit(1);
});
