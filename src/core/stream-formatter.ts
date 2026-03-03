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

    case 'tool.execution_start': {
      const toolName = event.data?.toolName ?? event.data?.name ?? 'unknown';
      const desc = event.data?.arguments?.description ?? event.data?.intention ?? '';
      const summary = desc ? `**${toolName}**: ${desc}` : `**${toolName}**`;
      return {
        type: 'tool_start',
        content: `🔧 ${summary}`,
        verbose: true,
      };
    }

    case 'tool.execution_complete': {
      const toolName = event.data?.toolName ?? event.data?.name ?? 'unknown';
      return {
        type: 'tool_complete',
        content: `✅ **${toolName}** completed`,
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

    default:
      return null;
  }
}

/**
 * Format a permission request for display in chat.
 */
export function formatPermissionRequest(toolName: string, input: unknown, commands: string[]): string {
  const lines = ['🔐 **Permission Required**', ''];
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

  lines.push('');
  lines.push('Reply `/approve` or `/deny` (add `/remember` to persist)');
  lines.push('React with 👍 to approve or 👎 to deny');

  return lines.join('\n');
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
