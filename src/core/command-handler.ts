import { setChannelPrefs, getChannelPrefs } from '../state/store.js';

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

export interface CommandResult {
  handled: boolean;
  response?: string;
  action?: 'new_session' | 'switch_model' | 'switch_agent' | 'toggle_verbose' |
           'approve' | 'deny' | 'toggle_autopilot' | 'remember' | 'set_reasoning';
  payload?: any;
}

export function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return { command: trimmed.slice(1).toLowerCase(), args: '' };
  return {
    command: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export function handleCommand(channelId: string, text: string, sessionInfo?: { sessionId: string; model: string; agent: string | null }, effectivePrefs?: { verbose: boolean; permissionMode: string; reasoningEffort?: string | null }, channelMeta?: { workingDirectory?: string; bot?: string }, modelInfo?: { supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string } | null): CommandResult {
  const parsed = parseCommand(text);
  if (!parsed) return { handled: false };

  switch (parsed.command) {
    case 'new':
      return { handled: true, action: 'new_session', response: '🔄 Creating new session...' };

    case 'model': {
      if (!parsed.args) {
        return { handled: true, response: '⚠️ Usage: `/model <model-name>`\nExample: `/model claude-sonnet-4.6`' };
      }
      return { handled: true, action: 'switch_model', payload: parsed.args, response: `🔄 Switching model to **${parsed.args}**...` };
    }

    case 'agent': {
      const agent = parsed.args || null;
      return {
        handled: true,
        action: 'switch_agent',
        payload: agent,
        response: agent ? `🤖 Switching to agent **${agent}**...` : '🤖 Deselecting agent (using default Copilot)...',
      };
    }

    case 'verbose': {
      const prefs = getChannelPrefs(channelId);
      const newVerbose = !(effectivePrefs?.verbose ?? prefs?.verbose ?? false);
      setChannelPrefs(channelId, { verbose: newVerbose });
      return {
        handled: true,
        action: 'toggle_verbose',
        response: newVerbose ? '🔊 Verbose mode **enabled** — tool calls will be shown.' : '🔇 Verbose mode **disabled** — only final responses shown.',
      };
    }

    case 'reasoning': {
      const level = parsed.args.toLowerCase();
      if (!level) {
        const current = effectivePrefs?.reasoningEffort ?? 'default';
        return { handled: true, response: `🧠 Current reasoning effort: **${current}**\nUsage: \`/reasoning <low|medium|high|xhigh>\`` };
      }
      if (!VALID_REASONING_EFFORTS.has(level)) {
        return { handled: true, response: `⚠️ Invalid reasoning effort. Valid values: \`low\`, \`medium\`, \`high\`, \`xhigh\`` };
      }
      if (modelInfo && modelInfo.supportedReasoningEfforts && !modelInfo.supportedReasoningEfforts.includes(level)) {
        return { handled: true, response: `⚠️ Model **${sessionInfo?.model ?? 'unknown'}** does not support reasoning effort.\nSupported models include Opus and other reasoning-capable models.` };
      }
      setChannelPrefs(channelId, { reasoningEffort: level });
      return {
        handled: true,
        action: 'set_reasoning',
        payload: level,
        response: `🧠 Reasoning effort set to **${level}**. Takes effect on next session (\`/new\`).`,
      };
    }

    case 'status': {
      if (!sessionInfo) {
        return { handled: true, response: '📊 No active session for this channel.' };
      }
      const prefs = getChannelPrefs(channelId);
      const lines = [
        '📊 **Session Status**',
        `• Session: \`${sessionInfo.sessionId.slice(0, 8)}...\``,
        `• Model: **${sessionInfo.model}**`,
        `• Agent: ${sessionInfo.agent ? `**${sessionInfo.agent}**` : 'Default (Copilot)'}`,
        `• Workspace: \`${channelMeta?.workingDirectory ?? 'unknown'}\``,
        `• Bot: ${channelMeta?.bot ? `@${channelMeta.bot}` : 'default'}`,
        `• Verbose: ${(effectivePrefs?.verbose ?? prefs?.verbose) ? '🔊 On' : '🔇 Off'}`,
        `• Permission mode: ${(effectivePrefs?.permissionMode ?? prefs?.permissionMode) === 'autopilot' ? '🤖 Autopilot' : '🛡️ Interactive'}`,
      ];
      // Only show reasoning effort for models that support it
      if (modelInfo?.supportedReasoningEfforts && modelInfo.supportedReasoningEfforts.length > 0) {
        const current = effectivePrefs?.reasoningEffort ?? modelInfo.defaultReasoningEffort ?? 'default';
        lines.push(`• Reasoning effort: 🧠 **${current}** (supports: ${modelInfo.supportedReasoningEfforts.join(', ')})`);
      }
      return { handled: true, response: lines.join('\n') };
    }

    case 'approve':
      return { handled: true, action: 'approve', response: '✅ Approved.' };

    case 'deny':
      return { handled: true, action: 'deny', response: '❌ Denied.' };

    case 'autopilot': {
      const prefs = getChannelPrefs(channelId);
      const current = effectivePrefs?.permissionMode ?? prefs?.permissionMode ?? 'interactive';
      const newMode = current === 'autopilot' ? 'interactive' : 'autopilot';
      setChannelPrefs(channelId, { permissionMode: newMode });
      return {
        handled: true,
        action: 'toggle_autopilot',
        response: newMode === 'autopilot'
          ? '🤖 **Autopilot enabled** — all permissions auto-approved.'
          : '🛡️ **Interactive mode** — permissions will require approval.',
      };
    }

    case 'remember':
      return { handled: true, action: 'remember', response: '💾 Permission rule saved.' };

    case 'help':
      return {
        handled: true,
        response: [
          '**Available Commands**',
          '`/new` — Start a new session',
          '`/model <name>` — Switch AI model',
          '`/agent <name>` — Switch custom agent (empty to deselect)',
          '`/reasoning <level>` — Set reasoning effort (low/medium/high/xhigh)',
          '`/verbose` — Toggle tool call visibility',
          '`/status` — Show session info',
          '`/approve` — Approve pending permission',
          '`/deny` — Deny pending permission',
          '`/autopilot` — Toggle auto-approve mode',
          '`/help` — Show this help',
        ].join('\n'),
      };

    default:
      return { handled: false };
  }
}
