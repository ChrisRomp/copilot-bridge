import { describe, expect, it } from 'vitest';
import * as acpModule from './acp.js';
import type {
  AcpError,
  AcpEventType,
  AcpMessage,
  AcpRun,
  AcpRunStatus,
  AcpSession,
  AgentManifest,
  CardEventType,
  CitationMetadata,
  CitationPart,
  CreateRunRequest,
  MessagePart,
  ResumeRunRequest,
  SseEvent,
  SseEventType,
  TextPart,
  TrajectoryMetadata,
  TrajectoryPart,
} from './acp.js';

const timestamp = '2026-05-08T00:00:00Z';

describe('http ACP wire types', () => {
  it('has no runtime exports', () => {
    expect(Object.keys(acpModule)).toEqual([]);
  });

  it('exports importable, structurally correct types', () => {
    const manifest: AgentManifest = {
      name: 'bob',
      description: 'HttpChannelAdapter agent',
      input_content_types: ['application/json'],
      output_content_types: ['text/plain'],
      metadata: { protocol: 'acp', version: '0.2.0' },
    };

    const textPart: TextPart = {
      type: 'text',
      text: 'Hello from ACP',
    };

    const trajectoryMetadata: TrajectoryMetadata = {
      tool_name: 'bash',
      tool_input: { command: 'echo hello' },
      tool_output: { stdout: 'hello' },
      tool_call_id: 'tool-1',
      status: 'completed',
    };

    const trajectoryPart: TrajectoryPart = {
      type: 'trajectory',
      metadata: trajectoryMetadata,
    };

    const citationMetadata: CitationMetadata = {
      title: 'ACP v0.2.0',
      url: 'https://agentcommunicationprotocol.dev',
      snippet: 'Protocol reference',
    };

    const citationPart: CitationPart = {
      type: 'citation',
      metadata: citationMetadata,
    };

    const messageParts: MessagePart[] = [textPart, trajectoryPart, citationPart];

    const message: AcpMessage = {
      role: 'assistant',
      parts: messageParts,
    };

    const error: AcpError = {
      code: 'run_failed',
      message: 'Tool execution failed',
      details: { exit_code: 1 },
    };

    const runStatus: AcpRunStatus = 'completed';

    const run: AcpRun = {
      id: 'run-1',
      agent_name: manifest.name,
      session_id: 'session-1',
      status: runStatus,
      input: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      output: [message],
      error,
      created_at: timestamp,
      finished_at: timestamp,
    };

    const createRunRequest: CreateRunRequest = {
      agent_name: manifest.name,
      session_id: run.session_id,
      input: run.input,
      mode: 'stream',
    };

    const resumeRunRequest: ResumeRunRequest = {
      await_resume: [{ role: 'user', parts: [textPart] }],
      mode: 'async',
    };

    const acpEventType: AcpEventType = 'run.completed';
    const cardEventType: CardEventType = 'card.status';
    const sseEventType: SseEventType = acpEventType;

    const event: SseEvent = {
      id: 'evt-1',
      event: sseEventType,
      data: {
        run_id: run.id,
        status: cardEventType,
      },
    };

    const session: AcpSession = {
      id: run.session_id,
      history: [{ run_id: run.id, status: run.status }],
    };

    expect(Object.keys(manifest)).toContain('name');
    expect(message.parts).toHaveLength(3);
    expect(run.error).toMatchObject({ code: error.code });
    expect(createRunRequest.mode).toBe('stream');
    expect(resumeRunRequest.await_resume[0]?.parts[0]).toMatchObject({ type: 'text' });
    expect(event.event).toBe('run.completed');
    expect(session.history).toEqual([{ run_id: 'run-1', status: 'completed' }]);
  });
});
