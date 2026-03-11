// Bot identity configuration
export interface BotConfig {
  token: string;
  appToken?: string;         // app-level token for Slack Socket Mode (xapp-...)
  agent?: string | null;     // default agent for this bot identity
  admin?: boolean;           // admin bots can manage all workspaces
}

// Platform configuration
export interface PlatformConfig {
  url?: string;                     // required for Mattermost; not needed for Slack (Socket Mode)
  botToken?: string;                // single-bot shorthand (backward compatible)
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
  fallbackModels?: string[];
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
    fallbackModels?: string[];
  };
  permissions?: PermissionsConfig;
  interAgent?: InterAgentConfig;
}

// Inter-agent communication config
export interface InterAgentConfig {
  enabled: boolean;
  defaultTimeout?: number;   // seconds (default: 60)
  maxTimeout?: number;       // seconds (default: 300)
  maxDepth?: number;         // max call chain depth (default: 3)
  allow?: Record<string, InterAgentPermission>;
}

export interface InterAgentPermission {
  canCall?: string[];       // bot names this bot can call ("*" for any)
  canBeCalledBy?: string[]; // bot names that can call this bot ("*" for any)
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
  id: string;
  url: string;
  name: string;
  mimeType?: string;
  size?: number;
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

// Admin operations for channel/team management (optional — not all platforms support these)
export interface CreateChannelOpts {
  name: string;
  displayName: string;
  private: boolean;
  teamId: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  displayName: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  displayName: string;
  type: string;
  teamId: string;
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
  /** Download a file attachment to a local path. Returns the written path. */
  downloadFile(fileId: string, destPath: string): Promise<string>;
  /** Upload a local file and send it as a message in a channel. Returns the post ID. */
  sendFile(channelId: string, filePath: string, message?: string, opts?: SendOpts): Promise<string>;
  /** Add an emoji reaction to a message. Best-effort — implementations should not throw. */
  addReaction?(postId: string, emoji: string): Promise<void>;
  // Optional admin operations — adapters that don't support these omit them
  createChannel?(opts: CreateChannelOpts): Promise<string>;
  addUserToChannel?(channelId: string, userId: string): Promise<void>;
  getTeams?(): Promise<TeamInfo[]>;
  getChannelByName?(teamId: string, name: string): Promise<ChannelInfo | null>;
  /** Discover DM channels for this bot (optional — platform-specific). */
  discoverDMChannels?(): Promise<{ channelId: string; otherUserId: string }[]>;
}

/** Factory function type for constructing a ChannelAdapter instance for a given platform. */
export type AdapterFactory = (platformName: string, url: string, token: string) => ChannelAdapter;

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
