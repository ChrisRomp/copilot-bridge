import type { FormattedEvent } from '../types.js';

/**
 * Format a Copilot SDK session event for chat display.
 */
export function formatEvent(event: any): FormattedEvent | null {
  switch (event.type) {
    case 'assistant.message_delta':
      return {
        type: 'content',
        content: event.data?.deltaContent ?? event.deltaContent ?? '',
        verbose: false,
      };

    // streaming_delta is a duplicate of message_delta — ignore it
    case 'assistant.streaming_delta':
      return null;

    case 'assistant.message':
      return {
        type: 'content',
        content: event.data?.content ?? event.content ?? '',
        verbose: false,
      };

    // Suppress thinking/reasoning events — they cause message churn if
    // streamed into the main content and then removed.
    case 'assistant.reasoning':
    case 'assistant.reasoning_delta':
      return null;

    case 'tool.execution_start': {
      const toolName = event.data?.toolName ?? event.data?.name ?? 'unknown';
      const args = event.data?.arguments ?? {};
      const summary = formatToolSummary(toolName, args);
      return {
        type: 'tool_start',
        content: summary,
        verbose: true,
      };
    }

    case 'tool.execution_complete': {
      const toolName = event.data?.toolName ?? event.data?.name ?? 'unknown';
      const success = event.data?.success ?? true;
      return {
        type: 'tool_complete',
        content: success ? `✅ ${toolName}` : `❌ ${toolName}`,
        verbose: true,
      };
    }

    case 'session.error':
      return {
        type: 'error',
        content: `❌ Error: ${event.data?.message ?? 'Unknown error'}`,
        verbose: false,
      };

    case 'assistant.turn_start':
      return {
        type: 'status',
        content: '',
        verbose: false,
      };

    case 'assistant.turn_end':
    case 'session.idle':
      return {
        type: 'status',
        content: '',
        verbose: false, // must always process — triggers stream finalization
      };

    case 'subagent.started': {
      const name = event.data?.agentDisplayName ?? event.data?.agentName ?? 'sub-agent';
      return {
        type: 'status',
        content: `🚀 Delegated to **${name}**`,
        verbose: false,
      };
    }

    case 'subagent.completed': {
      const name = event.data?.agentDisplayName ?? event.data?.agentName ?? 'sub-agent';
      return {
        type: 'status',
        content: `✅ **${name}** finished`,
        verbose: false,
      };
    }

    case 'subagent.failed': {
      const name = event.data?.agentDisplayName ?? event.data?.agentName ?? 'sub-agent';
      const err = event.data?.error ?? 'unknown error';
      return {
        type: 'error',
        content: `❌ **${name}** failed: ${err}`,
        verbose: false,
      };
    }

    default:
      return null;
  }
}

/**
 * Format a permission request for display in chat.
 */
export function formatPermissionRequest(toolName: string, input: unknown, commands: string[], serverName?: string, hookReason?: string, fromHook?: boolean, assistedReason?: string): string {
  const lines = ['🔐 **Permission Required**', ''];
  if (hookReason) {
    lines.push(hookReason);
    lines.push('');
  }
  lines.push(`Tool: **${toolName}**`);

  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;

    // Show intention if available
    if (obj.intention && typeof obj.intention === 'string') {
      lines.push(`Intent: ${obj.intention}`);
    }

    // Show the full command for shell tools
    const cmdText = (obj.fullCommandText ?? obj.command) as string | undefined;
    if (cmdText && typeof cmdText === 'string') {
      const cmd = cmdText.length > 500 ? cmdText.slice(0, 500) + '...' : cmdText;
      lines.push(`\`\`\`\n${cmd}\n\`\`\``);
    }

    // Show path for read/write tools
    if (obj.path && typeof obj.path === 'string') {
      lines.push(`Path: \`${obj.path}\``);
    }

    // Show URL for url tools
    if (obj.url && typeof obj.url === 'string') {
      lines.push(`URL: ${obj.url}`);
    }

    // Show description if available
    if (obj.description && typeof obj.description === 'string') {
      lines.push(`Description: ${obj.description}`);
    }

    // Show MCP server name if applicable
    if (obj.serverName && typeof obj.serverName === 'string') {
      lines.push(`MCP Server: **${obj.serverName}**`);
    }
    if (obj.toolName && typeof obj.toolName === 'string' && obj.toolName !== toolName) {
      lines.push(`MCP Tool: **${obj.toolName}**`);
    }
  }

  const safeAssistedReason = assistedReason ? safePermissionText(assistedReason, 500) : '';
  if (!fromHook && safeAssistedReason) {
    lines.push('', `🛡️ Safety review: ${safeAssistedReason}`);
  }
  lines.push('');
  if (fromHook) {
    lines.push('Reply `/approve` or `/deny`');
    lines.push('React: 👍 approve · 👎 deny');
  } else if (serverName) {
    lines.push(`Reply \`/approve\` or \`/deny\` (\`/always approve\` or \`/always deny\` to persist for all **${serverName}** tools)`);
    lines.push('React: 👍 approve · 👎 deny · 💾 always approve · 🚫 always deny');
  } else {
    lines.push('Reply `/approve` or `/deny` (`/always approve` or `/always deny` to persist)');
    lines.push('React: 👍 approve · 👎 deny · 💾 always approve · 🚫 always deny');
  }

  return lines.join('\n');
}

/** A notice, not a permission prompt or a stream-finalization event. */
export function formatPermissionNotice(
  event:
    | { type: 'bridge.permission_auto_decision'; data: { approved: boolean; summary: string; reason?: string } }
    | { type: 'bridge.permission_policy_notice'; data: { content: string } },
  verbose: boolean,
  quiet: boolean,
): string | null {
  if (quiet) return null;
  if (event.type === 'bridge.permission_policy_notice') return event.data.content;
  return verbose ? formatPermissionAutoDecision(event.data.approved, event.data.summary, event.data.reason) : null;
}

export function formatPermissionAutoDecision(approved: boolean, summary: string, reason?: string): string {
  const label = approved ? 'Auto-approved' : 'Denied';
  const subject = safePermissionText(summary, 180) || 'Permission request';
  const safeReason = (reason ? safePermissionText(reason, 360) : '') ||
    'Human approval is unavailable in unattended mode.';
  const rationale = !approved
    ? ` — ${safeReason}`
    : '';
  return `🛡️ ${label}: ${subject}${rationale}`;
}

/** Keep chat concise; SessionManager logs the individual policy gaps. */
export function formatPermissionPolicyWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return 'Some bridge permission rules could not be translated for assisted mode. This may cause extra prompts, or leave those rules unenforced during unattended autopilot.';
}

/** Keep model/tool-authored notice text bounded and inert in chat Markdown. */
function safePermissionText(value: string, limit: number): string {
  const plain = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // Limit after escaping, without splitting an escape or an HTML entity.
  let escaped = '';
  for (const char of plain) {
    const token = char === '@' ? '@\u200b'
      : char === '&' ? '&amp;'
      : char === '<' ? '&lt;'
      : char === '>' ? '&gt;'
      : /[\\`*_{}\[\]()#+.!|~-]/.test(char) ? `\\${char}`
      : char;
    if (escaped.length + token.length > limit - 1) return `${escaped}…`;
    escaped += token;
  }
  return escaped;
}

/**
 * Format a user input request for display in chat.
 */
export function formatUserInputRequest(question: string, choices?: string[]): string {
  const lines = ['❓ **Copilot needs your input:**', '', question];

  if (choices && choices.length > 0) {
    lines.push('');
    choices.forEach((choice, i) => {
      lines.push(`${i + 1}. ${choice}`);
    });
    lines.push('');
    lines.push('Reply with a number or type your answer.');
  } else {
    lines.push('');
    lines.push('Reply with your answer.');
  }

  return lines.join('\n');
}

/**
 * Produce a compact one-line summary of a tool call for the activity feed.
 * Prioritizes the `description` field (agent intent) when available.
 */
function formatToolSummary(toolName: string, args: Record<string, unknown>): string {
  const desc = (args.description ?? args.intention) as string | undefined;

  // If there's a description, use it as the primary text (like the CLI does)
  if (desc && typeof desc === 'string') {
    const short = desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
    return `🔧 **${toolName}**: ${short}`;
  }

  // Fallback: derive summary from arguments
  const cmd = (args.fullCommandText ?? args.command) as string | undefined;
  if (cmd && typeof cmd === 'string') {
    const short = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    return `🔧 **${toolName}** \`${short}\``;
  }

  if (args.path && typeof args.path === 'string') {
    const p = shortenPath(args.path as string);
    const range = args.view_range ? ` (L${(args.view_range as number[])[0]}-${(args.view_range as number[])[1]})` : '';
    return `🔧 **${toolName}** \`${p}${range}\``;
  }

  if (args.pattern && typeof args.pattern === 'string') {
    const pat = (args.pattern as string).length > 40 ? (args.pattern as string).slice(0, 37) + '...' : args.pattern;
    const scope = args.glob ? ` in ${args.glob}` : '';
    return `🔧 **${toolName}** \`${pat}\`${scope}`;
  }

  if (args.url && typeof args.url === 'string') {
    return `🔧 **${toolName}** ${args.url}`;
  }

  if (args.query && typeof args.query === 'string') {
    const q = (args.query as string).length > 60 ? (args.query as string).slice(0, 57) + '...' : args.query;
    return `🔧 **${toolName}** \`${q}\``;
  }

  return `🔧 **${toolName}**`;
}

/** Shorten a file path for display — keep last 2-3 segments. */
function shortenPath(p: string): string {
  const segments = p.split('/');
  if (segments.length <= 3) return p;
  return '.../' + segments.slice(-3).join('/');
}
