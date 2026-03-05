// Bot identity configuration
export interface BotConfig {
  token: string;
  agent?: string | null; // default agent for this bot identity
  admin?: boolean;       // admin bots can manage all workspaces
}

// Platform configuration
export interface PlatformConfig {
  url: string;
  botToken?: string;          // single-bot shorthand (backward compatible)
  bots?: Record<string, BotConfig>; // multi-bot: name → config
}

// Channel configuration
export interface ChannelConfig {
  id: string;
  platform: string;
  name: string;
  workingDirectory: string;
  bot?: string;               // which bot identity to use (key into platform.bots)
  agent?: string | null;
  model?: string;
  triggerMode: 'mention' | 'all';
  threadedReplies: boolean;
  verbose: boolean;
  isDM?: boolean;
}

// Permission rules config (CLI-compatible syntax)
// e.g., "shell(ls)", "shell(git status)", "shell", "write", "read", "MCP_SERVER(tool)", "MCP_SERVER"
export interface PermissionsConfig {
  allow?: string[];   // e.g., ["read", "shell(ls)", "shell(cat)", "shell(head)", "shell(find)", "shell(grep)"]
  deny?: string[];    // e.g., ["shell(rm)", "shell(git push)"]
  allowPaths?: string[];  // extra allowed paths beyond workingDirectory
  allowUrls?: string[];   // pre-approved URL domains
}

// Full app config
export interface AppConfig {
  platforms: Record<string, PlatformConfig>;
  channels: ChannelConfig[];
  defaults: {
    model: string;
    agent: string | null;
    triggerMode: 'mention' | 'all';
    threadedReplies: boolean;
    verbose: boolean;
    permissionMode: 'interactive' | 'autopilot';
  };
  permissions?: PermissionsConfig;
}

// Inbound message from any platform
export interface InboundMessage {
  platform: string;
  channelId: string;
  userId: string;
  username: string;
  text: string;
  postId: string;
  threadRootId?: string;
  mentionsBot: boolean;
  isDM: boolean;
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  type: 'image' | 'file' | 'video' | 'audio';
  url: string;
  name?: string;
  mimeType?: string;
}

// Inbound reaction from any platform
export interface InboundReaction {
  platform: string;
  channelId: string;
  userId: string;
  postId: string;
  emoji: string;
  action: 'added' | 'removed';
}

// Send options
export interface SendOpts {
  threadRootId?: string;
}

// Channel adapter interface
export interface ChannelAdapter {
  readonly platform: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  onReaction(handler: (reaction: InboundReaction) => void): void;
  sendMessage(channelId: string, content: string, opts?: SendOpts): Promise<string>;
  updateMessage(channelId: string, messageId: string, content: string): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  setTyping(channelId: string): Promise<void>;
  replyInThread(channelId: string, rootId: string, content: string): Promise<string>;
  getBotUserId(): string;
}

// Session state tracked per channel
export interface ChannelSessionState {
  channelId: string;
  sessionId: string;
  model: string;
  agent: string | null;
  verbose: boolean;
  triggerMode: 'mention' | 'all';
  threadedReplies: boolean;
  permissionMode: 'interactive' | 'autopilot';
  createdAt: string;
}

// Permission rule stored in SQLite
export interface PermissionRule {
  id?: number;
  scope: string; // channel ID or 'global'
  tool: string; // tool name, e.g., 'bash', 'edit', 'view'
  commandPattern: string; // specific command, e.g., 'ls', 'grep', '*' for all
  action: 'allow' | 'deny';
  createdAt: string;
}

// Pending permission request surfaced to chat
export interface PendingPermission {
  sessionId: string;
  channelId: string;
  messageId?: string; // chat message ID for the permission prompt
  toolName: string;
  serverName?: string; // MCP server name (for server-level /remember)
  toolInput: unknown;
  commands: string[]; // extracted individual commands
  resolve: (result: { kind: 'approved' | 'denied-by-rules' | 'denied-interactively-by-user' | 'denied-no-approval-rule-and-could-not-request-from-user' }) => void;
  createdAt: number;
}

// Pending user input request
export interface PendingUserInput {
  sessionId: string;
  channelId: string;
  messageId?: string;
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  resolve: (answer: { answer: string; wasFreeform: boolean }) => void;
  createdAt: number;
}

// Copilot session event types we care about
export type CopilotEventType =
  | 'assistant.message'
  | 'assistant.message_delta'
  | 'assistant.turn_start'
  | 'assistant.turn_end'
  | 'assistant.reasoning'
  | 'assistant.reasoning_delta'
  | 'tool.execution_start'
  | 'tool.execution_complete'
  | 'session.idle'
  | 'session.error';

// Formatted output for chat
export interface FormattedEvent {
  type: 'content' | 'tool_start' | 'tool_complete' | 'error' | 'status';
  content: string;
  verbose: boolean; // whether this should only show in verbose mode
}
