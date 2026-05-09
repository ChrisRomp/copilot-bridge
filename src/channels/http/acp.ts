// ACP v0.2.0 types for copilot-bridge HttpChannelAdapter
// Reference: https://agentcommunicationprotocol.dev

// --- Agent manifest ---
export interface AgentManifest {
  name: string;
  description?: string;
  input_content_types?: string[];
  output_content_types?: string[];
  metadata?: Record<string, unknown>;
}

// --- Message parts ---
export interface TextPart {
  type: 'text';
  text: string;
}

export interface TrajectoryMetadata {
  tool_name: string;
  tool_input: unknown;
  tool_output?: unknown;
  tool_call_id?: string;
  status?: 'in_progress' | 'completed' | 'error';
}

export interface TrajectoryPart {
  type: 'trajectory';
  metadata: TrajectoryMetadata;
}

export interface CitationMetadata {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface CitationPart {
  type: 'citation';
  metadata: CitationMetadata;
}

export type MessagePart = TextPart | TrajectoryPart | CitationPart;

// --- Messages ---
export interface AcpMessage {
  role: 'user' | 'assistant';
  parts: MessagePart[];
}

// --- Run ---
export type AcpRunStatus =
  | 'created'
  | 'in-progress'
  | 'awaiting'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed';

export interface AcpRun {
  id: string;
  agent_name: string;
  session_id: string;
  status: AcpRunStatus;
  input: AcpMessage[];
  output: AcpMessage[];
  error?: AcpError;
  created_at: string;
  finished_at?: string;
}

export interface AcpError {
  code: string;
  message: string;
  details?: unknown;
}

// --- Run creation request ---
export interface CreateRunRequest {
  agent_name: string;
  session_id?: string;
  input: AcpMessage[];
  mode?: 'sync' | 'async' | 'stream';
}

// --- Run resume request ---
export interface ResumeRunRequest {
  await_resume: AcpMessage[];
  mode?: 'sync' | 'async' | 'stream';
}

// --- SSE event types ---
export type AcpEventType =
  | 'message.created'
  | 'message.part'
  | 'message.completed'
  | 'run.in-progress'
  | 'run.awaiting'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

// Card-level extension events (not part of ACP spec)
export type CardEventType = 'card.status' | 'heartbeat';

export type SseEventType = AcpEventType | CardEventType;

export interface SseEvent {
  id?: string;
  event: SseEventType;
  data: unknown;
}

// --- Session ---
export interface AcpSession {
  id: string;
  history: Array<{ run_id: string; status: AcpRunStatus }>;
}
