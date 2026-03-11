/**
 * Prerequisite checks shared between init and check commands.
 * Validates Node.js version, GitHub Copilot CLI, and auth status.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CheckResult } from './output.js';

export function checkNodeVersion(): CheckResult {
  const version = process.version; // e.g., "v22.0.0"
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major >= 20) {
    return { status: 'pass', label: `Node.js ${version}` };
  }
  return { status: 'fail', label: `Node.js ${version}`, detail: 'requires v20 or higher' };
}

function tryCommand(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function checkCopilotCLI(): CheckResult {
  // Try gh copilot first (GitHub CLI extension), then standalone copilot
  const ghVersion = tryCommand('gh copilot --version 2>&1');
  if (ghVersion) {
    const ver = ghVersion.split('\n')[0];
    return { status: 'pass', label: 'GitHub Copilot CLI', detail: ver };
  }

  const standaloneVersion = tryCommand('copilot --version 2>&1');
  if (standaloneVersion) {
    const ver = standaloneVersion.split('\n')[0];
    return { status: 'pass', label: 'Copilot CLI (standalone)', detail: ver };
  }

  return {
    status: 'fail',
    label: 'GitHub Copilot CLI',
    detail: 'not found — install via: gh extension install github/gh-copilot',
  };
}

export function checkGitHubAuth(): CheckResult {
  // Check for Copilot-specific env token first (highest priority)
  if (process.env.COPILOT_GITHUB_TOKEN) {
    return { status: 'pass', label: 'GitHub authenticated', detail: 'via COPILOT_GITHUB_TOKEN' };
  }

  // Check for general GitHub tokens
  if (process.env.GH_TOKEN) {
    return { status: 'pass', label: 'GitHub authenticated', detail: 'via GH_TOKEN' };
  }
  if (process.env.GITHUB_TOKEN) {
    return { status: 'pass', label: 'GitHub authenticated', detail: 'via GITHUB_TOKEN' };
  }

  // Check if gh CLI is authenticated
  const authStatus = tryCommand('gh auth status 2>&1');
  if (authStatus && authStatus.includes('Logged in')) {
    return { status: 'pass', label: 'GitHub authenticated', detail: 'via gh CLI' };
  }

  // Check if Copilot CLI has stored credentials (~/.copilot/config.json)
  try {
    const copilotConfig = join(homedir(), '.copilot', 'config.json');
    if (existsSync(copilotConfig)) {
      const data = JSON.parse(readFileSync(copilotConfig, 'utf-8'));
      const users = data.logged_in_users;
      if (Array.isArray(users) && users.length > 0) {
        const login = users[0].login ?? 'unknown';
        return { status: 'pass', label: 'GitHub authenticated', detail: `via Copilot CLI (${login})` };
      }
    }
  } catch {
    // Fall through
  }

  return {
    status: 'warn',
    label: 'GitHub authentication',
    detail: 'no token found — set COPILOT_GITHUB_TOKEN, run gh auth login, or run copilot login',
  };
}

export function runAllPrereqs(): CheckResult[] {
  return [
    checkNodeVersion(),
    checkCopilotCLI(),
    checkGitHubAuth(),
  ];
}
