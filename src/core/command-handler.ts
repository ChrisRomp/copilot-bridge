import { setChannelPrefs, getChannelPrefs, getGlobalSetting, setGlobalSetting } from '../state/store.js';
import { discoverAgentDefinitions, discoverAgentNames } from './inter-agent.js';
import { isBotAdminAny } from '../config.js';
import type { BridgeProviderConfig } from '../types.js';

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

/** Check if a model should be hidden in streamer mode. */
function isHiddenModel(model: ModelInfo): boolean {
  return /\((preview|internal\b)[^)]*\)/i.test(model.name);
}

/** Get the redacted display name for a hidden model. */
function redactedModelLabel(index: number): string {
  return `Hidden Model ${index}`;
}

/** Check if streamer mode is currently enabled. */
function isStreamerMode(): boolean {
  return getGlobalSetting('streamer_mode') === '1';
}

export interface ModelInfo {
  id: string;
  name: string;
  billing?: { multiplier: number };
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface CommandResult {
  handled: boolean;
  response?: string;
  action?: 'new_session' | 'reload_session' | 'reload_config' | 'resume_session' | 'list_sessions' | 'switch_model' | 'switch_agent' | 'toggle_verbose' |
           'approve' | 'deny' | 'toggle_autopilot' | 'remember' | 'remember_deny' | 'remember_list' | 'remember_clear' | 'set_reasoning' | 'stop_session' | 'schedule' | 'skills' | 'skill_toggle' | 'mcp' | 'plan' | 'implement' | 'provider_test';
  payload?: any;
}

/**
 * Parse user input that may contain a provider prefix (e.g., "ollama-local:qwen3:8b").
 * Splits on the first colon, checks if the prefix is a known provider name.
 * Returns { provider, bareModel } if a provider prefix was found, or null if not.
 */
export function parseProviderModel(input: string, providerNames: string[]): { provider: string; bareModel: string } | null {
  const colonIdx = input.indexOf(':');
  if (colonIdx <= 0) return null;
  const prefix = input.slice(0, colonIdx);
  const canonical = providerNames.find(p => p.toLowerCase() === prefix.toLowerCase());
  if (canonical) {
    return { provider: canonical, bareModel: input.slice(colonIdx + 1) };
  }
  return null;
}

/**
 * Fuzzy-match user input to a model from the available list.
 * Supports provider:model syntax (e.g., "ollama-local:qwen3:8b") and bare model
 * names that resolve against Copilot models first, then BYOK providers.
 * Returns:
 * - { model, alternatives } on success (alternatives may be empty)
 * - { error } only when truly no match is found
 */
export function resolveModel(input: string, models: ModelInfo[], providerNames?: string[]): { model: ModelInfo; alternatives: ModelInfo[] } | { error: string } {
  const lower = input.toLowerCase().trim();
  if (!lower) return { error: '⚠️ Please specify a model name.' };

  const providers = providerNames ?? [];

  // Check for provider:model syntax — if prefix is a known provider, scope to that provider's models
  const parsed = parseProviderModel(lower, providers);
  if (parsed) {
    if (!parsed.bareModel) return { error: '⚠️ Please specify a model name after the provider prefix.' };
    const prefixed = `${parsed.provider}:${parsed.bareModel}`;
    const scoped = models.filter(m => m.id.toLowerCase().startsWith(`${parsed.provider.toLowerCase()}:`));
    // Exact match on full prefixed ID
    const exact = scoped.find(m => m.id.toLowerCase() === prefixed);
    if (exact) return { model: exact, alternatives: [] };
    // Fuzzy within provider scope
    return fuzzyMatch(parsed.bareModel, scoped, `provider "${parsed.provider}"`);
  }

  // Exact match on id or name (works for both Copilot and full BYOK IDs)
  const exact = models.find(m => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower);
  if (exact) return { model: exact, alternatives: [] };

  // For bare model input, try Copilot models first, then BYOK
  if (providers.length > 0) {
    const copilotModels = models.filter(m => !providers.some(p => m.id.toLowerCase().startsWith(`${p.toLowerCase()}:`)));
    const copilotResult = fuzzyMatch(lower, copilotModels);
    if ('model' in copilotResult) return copilotResult;

    // Try each BYOK provider in config order
    for (const prov of providers) {
      const provModels = models.filter(m => m.id.toLowerCase().startsWith(`${prov.toLowerCase()}:`));
      // Match against the bare part of the ID (after provider prefix)
      const bareExact = provModels.find(m => {
        const bare = m.id.slice(prov.length + 1);
        return bare.toLowerCase() === lower;
      });
      if (bareExact) return { model: bareExact, alternatives: [] };
    }

    // Fall through to global fuzzy match
  }

  return fuzzyMatch(lower, models);
}

/** Pick the best model from ambiguous candidates. Prefers shorter IDs and closer matches. */
function pickBestMatch(input: string, candidates: ModelInfo[]): ModelInfo {
  return candidates.sort((a, b) => {
    // Prefer exact id prefix match (e.g., "opus" matching base model over extended variants)
    const aStartsId = a.id.toLowerCase().endsWith(input) ? 1 : 0;
    const bStartsId = b.id.toLowerCase().endsWith(input) ? 1 : 0;
    if (aStartsId !== bStartsId) return bStartsId - aStartsId;

    // Prefer shorter ID (base model vs specialized variant)
    if (a.id.length !== b.id.length) return a.id.length - b.id.length;

    // Prefer shorter name
    return a.name.length - b.name.length;
  })[0];
}

/** Fuzzy-match input against a set of models. */
function fuzzyMatch(input: string, models: ModelInfo[], scope?: string): { model: ModelInfo; alternatives: ModelInfo[] } | { error: string } {
  if (models.length === 0) {
    return { error: scope
      ? `⚠️ No models found for ${scope}.`
      : `⚠️ Unknown model "${input}". Use \`/model\` to see available models.` };
  }

  // Substring match
  const substringMatches = models.filter(m =>
    m.id.toLowerCase().includes(input) || m.name.toLowerCase().includes(input)
  );
  if (substringMatches.length === 1) return { model: substringMatches[0], alternatives: [] };

  // Token match
  const tokens = input.split(/[\s\-_.]+/).filter(Boolean);
  const tokenMatches = models.filter(m => {
    const haystack = `${m.id} ${m.name}`.toLowerCase();
    return tokens.every(t => haystack.includes(t));
  });
  if (tokenMatches.length === 1) return { model: tokenMatches[0], alternatives: [] };

  // Multiple matches — pick best
  const candidates = (substringMatches.length > 0 ? substringMatches : tokenMatches).slice(0, 8);
  if (candidates.length > 1) {
    const best = pickBestMatch(input, candidates);
    const alternatives = candidates.filter(m => m.id !== best.id);
    return { model: best, alternatives };
  }

  return { error: scope
    ? `⚠️ Unknown model "${input}" in ${scope}. Use \`/model\` to see available models.`
    : `⚠️ Unknown model "${input}". Use \`/model\` to see available models.` };
}

/** Build the formatted model listing, optionally grouped by provider. */
function formatModelListing(models: ModelInfo[], providerNames: string[], currentModel: string | null, currentProvider: string | null, filterProvider?: string): string {
  const streamer = isStreamerMode();
  let hiddenIndex = 0;

  // Determine if the current model matches a given model entry
  const isCurrent = (m: ModelInfo): boolean => {
    if (!currentModel) return false;
    if (currentProvider) {
      // BYOK active: only match the prefixed BYOK entry, not the Copilot model with the same bare name
      return m.id === `${currentProvider}:${currentModel}`;
    }
    return m.id === currentModel;
  };

  const formatRow = (m: ModelInfo, showBilling: boolean): string => {
    const current = isCurrent(m) ? ' ← current' : '';
    const reasoning = m.supportedReasoningEfforts?.length ? ' 🧠' : '';
    const hidden = streamer && isHiddenModel(m);
    const displayName = hidden ? redactedModelLabel(++hiddenIndex) : `\`${m.id}\``;
    if (showBilling) {
      const billing = m.billing ? `${m.billing.multiplier}x` : '—';
      return `| ${displayName} | ${billing} |${reasoning}${current} |`;
    }
    return `| ${displayName} |${reasoning}${current} |`;
  };

  const copilotHeader = '| Model | Billing | |\n|:------|--------:|:--|';
  const byokHeader = '| Model | |\n|:------|:--|';

  const title = filterProvider ? `**Models: ${filterProvider}**` : '**Available Models**';
  const lines: string[] = [title, ''];

  if (providerNames.length > 0 && !filterProvider) {
    // Group by provider: Copilot first, then each BYOK provider
    const copilotModels = models.filter(m => !providerNames.some(p => m.id.startsWith(`${p}:`)));
    if (copilotModels.length > 0) {
      lines.push('**GitHub Copilot**', '', copilotHeader);
      for (const m of copilotModels) lines.push(formatRow(m, true));
      lines.push('');
    }
    for (const prov of providerNames) {
      const provModels = models.filter(m => m.id.startsWith(`${prov}:`));
      if (provModels.length > 0) {
        lines.push(`**${prov}**`, '', byokHeader);
        for (const m of provModels) lines.push(formatRow(m, false));
        lines.push('');
      }
    }
  } else if (filterProvider) {
    // Filtered to single BYOK provider — no billing column
    lines.push(byokHeader);
    for (const m of models) lines.push(formatRow(m, false));
    lines.push('');
  } else {
    // Flat listing (no providers configured)
    lines.push(copilotHeader);
    for (const m of models) lines.push(formatRow(m, true));
    lines.push('');
  }

  const hasCopilotModels = !filterProvider && models.some(m => !providerNames.some(p => m.id.startsWith(`${p}:`)));
  const legend = hasCopilotModels
    ? '🧠 = supports reasoning effort · Billing = premium request multiplier'
    : '🧠 = supports reasoning effort';
  lines.push(legend);
  lines.push('↳ Use `/model <name>` to switch');
  if (providerNames.length > 0 && !filterProvider) {
    const shown = providerNames.slice(0, 3).join(', ');
    const suffix = providerNames.length > 3 ? ', …' : '';
    lines.push(`↳ Use \`/model <provider>\` to filter (${shown}${suffix})`);
  }
  return lines.join('\n');
}

/** Format a token count as a human-readable string (e.g., 109000 → "109k"). */
function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Format context usage as a one-line summary. */
function formatContextUsage(usage: { currentTokens: number; tokenLimit: number; contextWindowTokens?: number }): string {
  const limit = usage.contextWindowTokens ?? usage.tokenLimit;
  if (limit <= 0) {
    return `${formatTokens(usage.currentTokens)}/? tokens`;
  }
  const pct = Math.round((usage.currentTokens / limit) * 100);
  return `${formatTokens(usage.currentTokens)}/${formatTokens(limit)} tokens (${pct}%)`;
}

/** Extract a short description from agent markdown content (frontmatter or first body line). */
function extractAgentDescription(content: string): string {
  const lines = content.split('\n');
  const hasFrontmatter = lines[0]?.trim() === '---';
  // Check for YAML frontmatter (description: field)
  if (hasFrontmatter) {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') break; // end of frontmatter
      const match = lines[i].match(/^description:\s*(.+)/i);
      if (match) {
        const value = match[1].trim();
        // YAML block scalars (>-, |-, >, |): collect indented continuation lines
        if (value === '>' || value === '>-' || value === '|' || value === '|-') {
          const parts: string[] = [];
          for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (line.trim() === '---') break; // end of frontmatter
            if (line.match(/^\S/) && line.trim() !== '') break; // new YAML key
            if (line.trim() === '') break; // blank line ends first paragraph
            parts.push(line.trim());
          }
          if (parts.length > 0) return ` — ${parts.join(' ').slice(0, 120)}`;
          return '';
        }
        // Inline or quoted value
        return ` — ${value.replace(/^["']|["']$/g, '').slice(0, 120)}`;
      }
    }
  }
  // Fallback: first non-heading, non-empty, non-frontmatter line
  let inFrontmatter = hasFrontmatter;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inFrontmatter) {
      if (trimmed === '---' && i > 0) inFrontmatter = false;
      continue;
    }
    if (trimmed && !trimmed.startsWith('#')) return ` — ${trimmed.slice(0, 120)}`;
  }
  return '';
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
  source: 'user' | 'workspace' | 'workspace (override)';
  /** True if this server was added after the current session was created — not yet active. */
  pending?: boolean;
}

export function handleCommand(channelId: string, text: string, sessionInfo?: { sessionId: string; model: string; agent: string | null }, effectivePrefs?: { verbose: boolean; permissionMode: string; reasoningEffort?: string | null }, channelMeta?: { workingDirectory?: string; bot?: string }, models?: ModelInfo[], mcpInfo?: McpServerInfo[], contextUsage?: { currentTokens: number; tokenLimit: number; contextWindowTokens?: number } | null, providers?: Record<string, BridgeProviderConfig>): CommandResult {
  const parsed = parseCommand(text);
  if (!parsed) return { handled: false };

  // Resolve current model's info from models list
  const currentModelInfo = models && sessionInfo
    ? models.find(m => m.id === sessionInfo.model) ?? null
    : null;

  switch (parsed.command) {
    case 'new':
      return { handled: true, action: 'new_session', response: '🔄 Creating new session...' };

    case 'stop':
    case 'cancel':
      return { handled: true, action: 'stop_session', response: '🛑 Stopping current task...' };

    case 'reload':
      if (parsed.args?.trim().toLowerCase() === 'config') {
        return { handled: true, action: 'reload_config', response: '🔄 Reloading config...' };
      }
      return { handled: true, action: 'reload_session', response: '🔄 Reloading session...' };

    case 'resume': {
      if (!parsed.args) {
        // No args = list available sessions for this channel's working directory
        return { handled: true, action: 'list_sessions', response: '📋 Fetching sessions...' };
      }
      return { handled: true, action: 'resume_session', payload: parsed.args.trim(), response: '🔄 Resuming session...' };
    }

    case 'model':
    case 'models': {
      const providerNames = providers ? Object.keys(providers) : [];
      const currentProvider = getChannelPrefs(channelId)?.provider ?? null;

      if (!parsed.args) {
        // No args: show model table grouped by provider
        if (!models || models.length === 0) {
          return { handled: true, response: '⚠️ Model list not available.' };
        }
        return { handled: true, response: formatModelListing(models, providerNames, sessionInfo?.model ?? null, currentProvider) };
      }

      // Check if arg is a provider name → show just that provider's models
      if (providerNames.some(p => p.toLowerCase() === parsed.args!.toLowerCase().trim())) {
        if (!models || models.length === 0) {
          return { handled: true, response: '⚠️ Model list not available.' };
        }
        const provName = providerNames.find(p => p.toLowerCase() === parsed.args!.toLowerCase().trim())!;
        const provModels = models.filter(m => m.id.toLowerCase().startsWith(`${provName.toLowerCase()}:`));
        if (provModels.length === 0) {
          return { handled: true, response: `⚠️ No models found for provider "${provName}".` };
        }
        return { handled: true, response: formatModelListing(provModels, providerNames, sessionInfo?.model ?? null, currentProvider, provName) };
      }

      if (!models || models.length === 0) {
        // Best-effort provider parsing when model list is unavailable
        const parsedInput = parseProviderModel(parsed.args, providerNames);
        const fallbackProvider = parsedInput?.provider ?? null;
        const fallbackModelId = parsedInput?.bareModel ?? parsed.args;
        return { handled: true, action: 'switch_model', payload: { modelId: fallbackModelId, provider: fallbackProvider }, response: `🔄 Switching model to **${parsed.args}**...` };
      }
      const result = resolveModel(parsed.args, models, providerNames);
      if ('error' in result) {
        return { handled: true, response: result.error };
      }

      // Determine provider from the resolved model ID
      const resolvedProvider = providerNames.find(p => result.model.id.toLowerCase().startsWith(`${p.toLowerCase()}:`)) ?? null;
      const bareModelId = resolvedProvider ? result.model.id.slice(resolvedProvider.length + 1) : result.model.id;

      const streamerSwitch = isStreamerMode();
      const switchName = (streamerSwitch && isHiddenModel(result.model))
        ? 'a hidden model'
        : `**${result.model.name}** (\`${result.model.id}\`)`;
      let response = `✅ Switched to ${switchName}`;
      if (result.alternatives.length > 0) {
        const altList = result.alternatives
          .filter(m => !(streamerSwitch && isHiddenModel(m)))
          .map(m => `\`${m.id}\` (${m.name})`).join(', ');
        if (altList) response += `\n↳ Also matched: ${altList}`;
      }
      return { handled: true, action: 'switch_model', payload: { modelId: bareModelId, provider: resolvedProvider }, response };
    }

    case 'provider':
    case 'providers': {
      const providerMap = providers ?? {};
      const provNames = Object.keys(providerMap);
      const args = parsed.args?.trim();

      if (!args) {
        // List all providers
        if (provNames.length === 0) {
          return { handled: true, response: 'No BYOK providers configured.\n↳ Add providers in `config.json` under the `"providers"` key, then `/reload config`.' };
        }
        const lines = ['**Configured Providers**', ''];
        for (const name of provNames) {
          const p = providerMap[name];
          const modelCount = p.models?.length ?? 0;
          const authMethod = p.apiKeyEnv ? `apiKeyEnv: ${p.apiKeyEnv}` : p.bearerTokenEnv ? `bearerTokenEnv: ${p.bearerTokenEnv}` : p.apiKey ? 'apiKey (inline)' : 'none';
          lines.push(`**${name}**`);
          lines.push(`  URL: \`${p.baseUrl}\``);
          lines.push(`  Type: ${p.type ?? 'openai'} · Auth: ${authMethod} · Models: ${modelCount}`);
          lines.push(`  Models: ${p.models.map(m => `\`${m.id}\``).join(', ')}`);
          lines.push('');
        }
        lines.push('↳ Use `/provider test <name>` to test connectivity');
        lines.push('↳ Use `/model <provider>:<model>` to switch to a provider model');
        return { handled: true, response: lines.join('\n') };
      }

      // /provider test <name>
      const testMatch = args.match(/^test\s+(.+)$/i);
      if (testMatch) {
        const target = testMatch[1].trim();
        const canonical = provNames.find(p => p.toLowerCase() === target.toLowerCase());
        if (!canonical) {
          return { handled: true, response: `⚠️ Unknown provider "${target}". Configured: ${provNames.join(', ')}` };
        }
        return { handled: true, action: 'provider_test', payload: canonical, response: `🔄 Testing provider "${canonical}"...` };
      }

      // /provider add|remove — guide to config file (admin can help)
      if (/^(add|remove|delete)\b/i.test(args)) {
        const botName = channelMeta?.bot;
        const isAdmin = botName ? isBotAdminAny(botName) : false;
        if (isAdmin) {
          return { handled: true, response: `Sure — I can help with that. Tell me the provider details (name, base URL, auth, models) and I'll update \`config.json\` for you.` };
        }
        return { handled: true, response: 'Providers are managed in `config.json` under the `"providers"` key.\n↳ Ask the **admin** bot to add/remove providers, or edit the file directly, then `/reload config`.' };
      }

      return { handled: true, response: '⚠️ Unknown subcommand. Usage:\n  `/provider` — list providers\n  `/provider test <name>` — test connectivity\n  `/model <provider>:<model>` — switch model' };
    }

    case 'agent': {
      const agent = parsed.args || null;
      if (!agent) {
        return {
          handled: true,
          action: 'switch_agent',
          payload: null,
          response: '✅ Agent deselected (using default Copilot)',
        };
      }
      // Validate agent exists (lightweight — reads filenames only)
      const agentWorkDir = channelMeta?.workingDirectory;
      if (agentWorkDir) {
        const available = discoverAgentNames(agentWorkDir);
        if (!available.has(agent)) {
          const names = [...available];
          const list = names.length > 0
            ? `Available agents: ${names.map(n => `**${n}**`).join(', ')}`
            : 'No agent definitions found.';
          return {
            handled: true,
            response: `⚠️ Agent **${agent}** not found.\n${list}`,
          };
        }
      }
      return {
        handled: true,
        action: 'switch_agent',
        payload: agent,
        response: `✅ Switched to agent **${agent}**`,
      };
    }

    case 'agents': {
      const agentsWorkDir = channelMeta?.workingDirectory;
      if (!agentsWorkDir) {
        return { handled: true, response: '⚠️ No workspace configured for this channel.' };
      }
      const agents = discoverAgentDefinitions(agentsWorkDir);
      if (agents.size === 0) {
        return { handled: true, response: 'No agent definitions found.\nPlace `*.agent.md` files in `<workspace>/agents/`, `<workspace>/.github/agents/`, `~/.copilot/agents/`, or install a plugin with agents.' };
      }
      const currentAgent = sessionInfo?.agent ?? null;
      const lines = ['**Available Agents**', ''];
      for (const [name, def] of agents) {
        const current = name === currentAgent ? ' ← current' : '';
        const desc = extractAgentDescription(def.content);
        lines.push(`• **${name}** (${def.source})${desc}${current}`);
      }
      if (currentAgent && !agents.has(currentAgent)) {
        lines.push('', `⚠️ Current agent **${currentAgent}** has no definition file.`);
      }
      return { handled: true, response: lines.join('\n') };
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
        const reasoningModelName = (isStreamerMode() && isHiddenModel(currentModelInfo))
          ? 'the current model'
          : `**${sessionInfo?.model ?? 'unknown'}**`;
        return { handled: true, response: `⚠️ Model ${reasoningModelName} does not support reasoning effort.\nSupported models include Opus and other reasoning-capable models.` };
      }
      setChannelPrefs(channelId, { reasoningEffort: level });
      return {
        handled: true,
        action: 'set_reasoning',
        payload: level,
      };
    }

    case 'status': {
      if (!sessionInfo) {
        return { handled: true, response: '📊 No active session for this channel.' };
      }
      const prefs = getChannelPrefs(channelId);
      const streamerStatus = isStreamerMode();
      const modelDisplay = (streamerStatus && currentModelInfo && isHiddenModel(currentModelInfo))
        ? 'Hidden Model'
        : sessionInfo.model;
      const modeLabels: Record<string, string> = {
        'plan': '📋 Plan',
        'autopilot': '🤖 Autopilot',
      };
      const sessionMode = prefs?.sessionMode ?? 'interactive';
      const modeDisplay = modeLabels[sessionMode] ?? '🛡️ Interactive';
      const providerDisplay = prefs?.provider ? `${prefs.provider}:` : '';
      const lines = [
        '📊 **Session Status**',
        `• Session: \`${sessionInfo.sessionId.slice(0, 8)}...\``,
        `• Model: **${providerDisplay}${modelDisplay}**`,
        `• Agent: ${sessionInfo.agent ? `**${sessionInfo.agent}**` : 'Default (Copilot)'}`,
        `• Mode: ${modeDisplay}`,
        `• Yolo: ${(effectivePrefs?.permissionMode ?? prefs?.permissionMode) === 'autopilot' ? '🤠 On' : '🛡️ Off'}`,
        `• Workspace: \`${channelMeta?.workingDirectory ?? 'unknown'}\``,
        `• Bot: ${channelMeta?.bot ? `@${channelMeta.bot}` : 'default'}`,
        `• Verbose: ${(effectivePrefs?.verbose ?? prefs?.verbose) ? '🔊 On' : '🔇 Off'}`,
      ];
      // Only show reasoning effort for models that support it
      if (currentModelInfo?.supportedReasoningEfforts && currentModelInfo.supportedReasoningEfforts.length > 0) {
        const current = effectivePrefs?.reasoningEffort ?? currentModelInfo.defaultReasoningEffort ?? 'default';
        lines.push(`• Reasoning effort: 🧠 **${current}** (supports: ${currentModelInfo.supportedReasoningEfforts.join(', ')})`);
      }
      if (contextUsage) {
        lines.push(`• Context: ${formatContextUsage(contextUsage)}`);
      }
      return { handled: true, response: lines.join('\n') };
    }

    case 'context': {
      if (!contextUsage) {
        return { handled: true, response: '📊 Context usage not available yet. Send a message first.' };
      }
      return { handled: true, response: `📊 **Context:** ${formatContextUsage(contextUsage)}` };
    }

    case 'approve':
      return { handled: true, action: 'approve', response: '✅ Approved.' };

    case 'deny':
      return { handled: true, action: 'deny', response: '❌ Denied.' };

    case 'auto':
    case 'autopilot':
      return { handled: true, action: 'toggle_autopilot' };

    case 'yolo': {
      const prefs = getChannelPrefs(channelId);
      const current = effectivePrefs?.permissionMode ?? prefs?.permissionMode ?? 'interactive';
      const newMode = current === 'autopilot' ? 'interactive' : 'autopilot';
      setChannelPrefs(channelId, { permissionMode: newMode });
      return {
        handled: true,
        response: newMode === 'autopilot'
          ? '🤠 **Yolo enabled** — all permissions auto-approved.'
          : '🛡️ **Yolo disabled** — permissions will require approval.',
      };
    }

    case 'always': {
      const sub = parsed.args.trim().toLowerCase();
      if (sub === 'approve') {
        return { handled: true, action: 'remember' };
      }
      if (sub === 'deny') {
        return { handled: true, action: 'remember_deny' };
      }
      return { handled: true, response: '⚠️ Usage: `/always approve` or `/always deny`' };
    }

    case 'remember':
    case 'rule':
    case 'rules': {
      const sub = parsed.args.trim().toLowerCase();
      if (sub === 'list' || (parsed.command !== 'remember' && !sub)) {
        return { handled: true, action: 'remember_list' };
      }
      if (sub === 'clear' || sub.startsWith('clear ')) {
        const spec = parsed.args.trim().slice(5).trim(); // everything after "clear"
        return { handled: true, action: 'remember_clear', payload: spec || undefined };
      }
      return { handled: true, action: 'remember' };
    }

    case 'mcp':
      return { handled: true, action: 'mcp' };

    case 'plan':
      return { handled: true, action: 'plan', payload: parsed.args?.trim() || undefined };

    case 'implement':
      return { handled: true, action: 'implement', payload: parsed.args?.trim() || undefined };

    case 'streamer-mode':
    case 'on-air': {
      const current = isStreamerMode();
      const newValue = parsed.args ? parseBool(parsed.args, !current) : !current;
      setGlobalSetting('streamer_mode', newValue ? '1' : '0');
      return {
        handled: true,
        response: newValue
          ? '📺 **Streamer mode enabled** — preview and internal models are hidden.'
          : '📺 **Streamer mode disabled** — all models visible.',
      };
    }

    case 'schedule':
    case 'schedules':
    case 'tasks':
      return { handled: true, action: 'schedule', payload: parsed.args?.trim() };

    case 'skills':
    case 'tools': {
      const args = parsed.args?.trim();
      if (args) {
        const match = args.match(/^(enable|disable)\s+(.+)$/i);
        if (match) {
          const action = match[1].toLowerCase() as 'enable' | 'disable';
          const targets = match[2].trim().split(/\s+/);
          return { handled: true, action: 'skill_toggle', payload: { action, targets } };
        }
      }
      return { handled: true, action: 'skills' };
    }

    case 'help': {
      const showAll = parsed.args?.trim().toLowerCase() === 'all';
      const common = [
        '**Commands**',
        '`/new` — Start a new session',
        '`/stop` — Stop the current task',
        '`/model [name]` — List or switch models',
        '`/status` — Show session info',
        '`/context` — Show context window usage',
        '`/verbose` — Toggle tool call visibility',
        '`/autopilot` — Toggle autopilot mode',
        '`/yolo` — Toggle auto-approve permissions',
        '`/schedule list` — List scheduled tasks',
        '`/skills` — Show available skills and MCP tools',
        '`/plan` — Toggle plan mode',
        '`/implement` — Start implementing the current plan',
        '`/help all` — Show all commands',
      ];
      if (!showAll) return { handled: true, response: common.join('\n') };
      return {
        handled: true,
        response: [
          '**All Commands**',
          '',
          '**Session**',
          '`/new` — Start a new session',
          '`/stop` — Stop the current task (alias: `/cancel`)',
          '`/reload` — Reload session (re-reads AGENTS.md, workspace config)',
          '`/reload config` — Hot-reload config.json',
          '`/resume [id]` — Resume current session (or a past one by ID)',
          '`/model [name]` — List models or switch model (fuzzy match)',
          '`/agent <name>` — Switch custom agent (empty to deselect)',
          '`/agents` — List available agent definitions',
          '`/reasoning <level>` — Set reasoning effort (low/medium/high/xhigh)',
          '`/context` — Show context window usage',
          '`/verbose` — Toggle tool call visibility',
          '`/status` — Show session info',
          '',
          '**Permissions**',
          '`/approve` / `/deny` — Handle pending permission',
          '`/always approve` / `/always deny` — Approve or deny + save rule',
          '`/rules` — Show all permission rules',
          '`/rules clear [spec]` — Clear rules (all or specific)',
          '`/yolo` — Toggle auto-approve permissions (no SDK mode change)',
          '`/autopilot` — Toggle autopilot mode (autonomous agentic loop)',
          '',
          '**Scheduling**',
          '`/schedule list` — List scheduled tasks (aliases: `/schedules`, `/tasks`)',
          '`/schedule cancel <id>` — Cancel a scheduled task',
          '`/schedule pause|resume <id>` — Pause or resume a task',
          '`/schedule history [n]` — Show recent task execution history',
          '',
          '**Tools & Info**',
          '`/skills` — Show available skills and MCP tools',
          '`/skills enable <name...>` — Enable skills for this channel',
          '`/skills disable <name...>` — Disable skills for this channel',
          '`/skills enable|disable all` — Enable or disable all skills',
          '`/mcp` — Show MCP servers and their source',
          '`/provider` — List configured BYOK providers',
          '`/provider test <name>` — Test provider connectivity',
          '`/plan` — Toggle plan mode (on/off)',
          '`/plan show` — Show current plan',
          '`/plan summary` — Show plan summary',
          '`/plan clear` — Delete the plan',
          '`/implement [yolo|interactive]` — Start implementing the plan',
          '`/streamer-mode [on|off]` — Toggle streamer mode',
          '`/help` — Show common commands',
        ].join('\n'),
      };
    }

    default:
      return { handled: false };
  }
}
