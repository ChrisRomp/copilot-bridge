import { setChannelPrefs, getChannelPrefs } from '../state/store.js';

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const TRUTHY = new Set(['on', 'true', 'yes', '1', 'enable', 'enabled']);
const FALSY = new Set(['off', 'false', 'no', '0', 'disable', 'disabled']);

/** Parse a loose boolean string. Returns fallback if unrecognized. */
function parseBool(input: string, fallback: boolean): boolean {
  const v = input.toLowerCase().trim();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return fallback;
}

export interface ModelInfo {
  id: string;
  name: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface CommandResult {
  handled: boolean;
  response?: string;
  action?: 'new_session' | 'reload_session' | 'resume_session' | 'list_sessions' | 'switch_model' | 'switch_agent' | 'toggle_verbose' |
           'approve' | 'deny' | 'toggle_autopilot' | 'remember' | 'set_reasoning';
  payload?: any;
}

/**
 * Fuzzy-match user input to a model from the available list.
 * Always tries to pick the best match. Returns:
 * - { model, alternatives } on success (alternatives may be empty)
 * - { error } only when truly no match is found
 */
export function resolveModel(input: string, models: ModelInfo[]): { model: ModelInfo; alternatives: ModelInfo[] } | { error: string } {
  const lower = input.toLowerCase().trim();
  if (!lower) return { error: '⚠️ Please specify a model name.' };

  // Exact match on id or name
  const exact = models.find(m => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower);
  if (exact) return { model: exact, alternatives: [] };

  // Substring match: input appears in id or name
  const substringMatches = models.filter(m =>
    m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower)
  );
  if (substringMatches.length === 1) return { model: substringMatches[0], alternatives: [] };

  // Token match: all words in input appear in id or name
  const tokens = lower.split(/[\s\-_.]+/).filter(Boolean);
  const tokenMatches = models.filter(m => {
    const haystack = `${m.id} ${m.name}`.toLowerCase();
    return tokens.every(t => haystack.includes(t));
  });
  if (tokenMatches.length === 1) return { model: tokenMatches[0], alternatives: [] };

  // Multiple matches — pick the best one
  const candidates = (substringMatches.length > 0 ? substringMatches : tokenMatches).slice(0, 8);
  if (candidates.length > 1) {
    const best = pickBestMatch(lower, candidates);
    const alternatives = candidates.filter(m => m.id !== best.id);
    return { model: best, alternatives };
  }

  return { error: `⚠️ Unknown model "${input}". Use \`/models\` to see available models.` };
}

/** Pick the best model from ambiguous candidates. Prefers shorter IDs and closer matches. */
function pickBestMatch(input: string, candidates: ModelInfo[]): ModelInfo {
  return candidates.sort((a, b) => {
    // Prefer exact id prefix match (e.g., "opus" matching "claude-opus-4.6" not "claude-opus-4.6-1m")
    const aStartsId = a.id.toLowerCase().endsWith(input) ? 1 : 0;
    const bStartsId = b.id.toLowerCase().endsWith(input) ? 1 : 0;
    if (aStartsId !== bStartsId) return bStartsId - aStartsId;

    // Prefer shorter ID (base model vs specialized variant)
    if (a.id.length !== b.id.length) return a.id.length - b.id.length;

    // Prefer shorter name
    return a.name.length - b.name.length;
  })[0];
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

export interface McpServerInfo {
  name: string;
  source: 'global' | 'workspace' | 'workspace (override)';
}

export function handleCommand(channelId: string, text: string, sessionInfo?: { sessionId: string; model: string; agent: string | null }, effectivePrefs?: { verbose: boolean; permissionMode: string; reasoningEffort?: string | null }, channelMeta?: { workingDirectory?: string; bot?: string }, models?: ModelInfo[], mcpInfo?: McpServerInfo[]): CommandResult {
  const parsed = parseCommand(text);
  if (!parsed) return { handled: false };

  // Resolve current model's info from models list
  const currentModelInfo = models && sessionInfo
    ? models.find(m => m.id === sessionInfo.model) ?? null
    : null;

  switch (parsed.command) {
    case 'new':
      return { handled: true, action: 'new_session', response: '🔄 Creating new session...' };

    case 'reload':
      return { handled: true, action: 'reload_session', response: '🔄 Reloading session...' };

    case 'resume': {
      if (!parsed.args) {
        // No args = list available sessions for this channel's working directory
        return { handled: true, action: 'list_sessions', response: '📋 Fetching sessions...' };
      }
      return { handled: true, action: 'resume_session', payload: parsed.args.trim(), response: '🔄 Resuming session...' };
    }

    case 'model': {
      if (!parsed.args) {
        return { handled: true, response: '⚠️ Usage: `/model <model-name>`\nExample: `/model claude-sonnet-4.6`' };
      }
      if (!models || models.length === 0) {
        // No model list available — pass through raw (best effort)
        return { handled: true, action: 'switch_model', payload: parsed.args, response: `🔄 Switching model to **${parsed.args}**...` };
      }
      const result = resolveModel(parsed.args, models);
      if ('error' in result) {
        return { handled: true, response: result.error };
      }
      let response = `✅ Switched to **${result.model.name}** (\`${result.model.id}\`)`;
      if (result.alternatives.length > 0) {
        const altList = result.alternatives.map(m => `\`${m.id}\` (${m.name})`).join(', ');
        response += `\n↳ Also matched: ${altList}`;
      }
      return { handled: true, action: 'switch_model', payload: result.model.id, response };
    }

    case 'models': {
      if (!models || models.length === 0) {
        return { handled: true, response: '⚠️ Model list not available.' };
      }
      const lines = ['**Available Models**', ''];
      for (const m of models) {
        const current = sessionInfo?.model === m.id ? ' ← current' : '';
        const reasoning = m.supportedReasoningEfforts?.length ? ` 🧠` : '';
        lines.push(`• \`${m.id}\` — ${m.name}${reasoning}${current}`);
      }
      return { handled: true, response: lines.join('\n') };
    }

    case 'agent': {
      const agent = parsed.args || null;
      return {
        handled: true,
        action: 'switch_agent',
        payload: agent,
        response: agent ? `✅ Switched to agent **${agent}**` : '✅ Agent deselected (using default Copilot)',
      };
    }

    case 'verbose': {
      const prefs = getChannelPrefs(channelId);
      const current = effectivePrefs?.verbose ?? prefs?.verbose ?? false;
      const newVerbose = parsed.args ? parseBool(parsed.args, !current) : !current;
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
      if (currentModelInfo && currentModelInfo.supportedReasoningEfforts && !currentModelInfo.supportedReasoningEfforts.includes(level)) {
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
      if (currentModelInfo?.supportedReasoningEfforts && currentModelInfo.supportedReasoningEfforts.length > 0) {
        const current = effectivePrefs?.reasoningEffort ?? currentModelInfo.defaultReasoningEffort ?? 'default';
        lines.push(`• Reasoning effort: 🧠 **${current}** (supports: ${currentModelInfo.supportedReasoningEfforts.join(', ')})`);
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

    case 'mcp': {
      if (!mcpInfo || mcpInfo.length === 0) {
        return { handled: true, response: '🔌 No MCP servers configured.' };
      }
      const globalServers = mcpInfo.filter(s => s.source === 'global');
      const workspaceServers = mcpInfo.filter(s => s.source === 'workspace');
      const overrideServers = mcpInfo.filter(s => s.source === 'workspace (override)');
      const lines = ['🔌 **MCP Servers**', ''];
      if (globalServers.length > 0) {
        lines.push('**Global** (plugin + user config)');
        for (const s of globalServers) lines.push(`• \`${s.name}\``);
        lines.push('');
      }
      if (workspaceServers.length > 0) {
        lines.push('**Workspace**');
        for (const s of workspaceServers) lines.push(`• \`${s.name}\``);
        lines.push('');
      }
      if (overrideServers.length > 0) {
        lines.push('**Workspace (overriding global)**');
        for (const s of overrideServers) lines.push(`• \`${s.name}\``);
        lines.push('');
      }
      lines.push(`Total: ${mcpInfo.length} server(s)`);
      return { handled: true, response: lines.join('\n') };
    }

    case 'help':
      return {
        handled: true,
        response: [
          '**Available Commands**',
          '`/new` — Start a new session',
          '`/reload` — Reload current session (re-reads AGENTS.md, config)',
          '`/resume [id]` — Resume current session (or a past one by ID)',
          '`/model <name>` — Switch AI model (fuzzy match supported)',
          '`/models` — List available models',
          '`/agent <name>` — Switch custom agent (empty to deselect)',
          '`/reasoning <level>` — Set reasoning effort (low/medium/high/xhigh)',
          '`/verbose` — Toggle tool call visibility',
          '`/status` — Show session info',
          '`/approve` — Approve pending permission',
          '`/deny` — Deny pending permission',
          '`/autopilot` — Toggle auto-approve mode',
          '`/mcp` — Show MCP servers and their source',
          '`/help` — Show this help',
        ].join('\n'),
      };

    default:
      return { handled: false };
  }
}
