import {
  CopilotClient,
  CopilotSession,
  approveAll,
  type SessionConfig,
  type ResumeSessionConfig,
  type SessionMetadata,
  type ModelInfo,
  type GetAuthStatusResponse,
  type SessionListFilter,
  type PermissionHandler,
  type CustomAgentConfig,
  type MCPServerConfig,
  type SystemMessageConfig,
  type SessionLifecycleHandler,
  type Tool,
} from '@github/copilot-sdk';

// SDK types not re-exported from package root
type UserInputHandler = (
  request: { question: string; choices?: string[]; allowFreeform?: boolean },
  invocation: { sessionId: string },
) => Promise<{ answer: string; wasFreeform: boolean }> | { answer: string; wasFreeform: boolean };

export class CopilotBridge {
  private client: CopilotClient;
  private sessions = new Map<string, CopilotSession>();
  private started = false;
  private lifecycleUnsubscribe?: () => void;

  onLifecycleEvent?: SessionLifecycleHandler;

  constructor() {
    this.client = new CopilotClient({
      autoStart: true,
      autoRestart: true,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.client.start();
    this.started = true;
    this.lifecycleUnsubscribe = this.client.on((event) => {
      this.onLifecycleEvent?.(event);
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    for (const [, session] of this.sessions) {
      try { await session.disconnect(); } catch { /* best-effort */ }
    }
    this.sessions.clear();
    this.lifecycleUnsubscribe?.();
    this.lifecycleUnsubscribe = undefined;
    await this.client.stop();
    this.started = false;
  }

  async createSession(opts: {
    model?: string;
    workingDirectory?: string;
    configDir?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    mcpServers?: Record<string, MCPServerConfig>;
    skillDirectories?: string[];
    onPermissionRequest: PermissionHandler;
    onUserInputRequest?: UserInputHandler;
    systemMessage?: SystemMessageConfig;
    customAgents?: CustomAgentConfig[];
    tools?: Tool[];
  }): Promise<CopilotSession> {
    await this.start();
    const session = await this.client.createSession({
      clientName: 'copilot-bridge',
      model: opts.model,
      workingDirectory: opts.workingDirectory,
      configDir: opts.configDir,
      reasoningEffort: opts.reasoningEffort,
      mcpServers: opts.mcpServers,
      skillDirectories: opts.skillDirectories,
      onPermissionRequest: opts.onPermissionRequest,
      onUserInputRequest: opts.onUserInputRequest,
      streaming: true,
      systemMessage: opts.systemMessage,
      customAgents: opts.customAgents,
      tools: opts.tools,
    });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async resumeSession(
    sessionId: string,
    opts?: {
      onPermissionRequest: PermissionHandler;
      onUserInputRequest?: UserInputHandler;
      systemMessage?: SystemMessageConfig;
      customAgents?: CustomAgentConfig[];
      configDir?: string;
      workingDirectory?: string;
      reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
      mcpServers?: Record<string, MCPServerConfig>;
      skillDirectories?: string[];
      tools?: Tool[];
    },
  ): Promise<CopilotSession> {
    await this.start();
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const session = await this.client.resumeSession(sessionId, {
      clientName: 'copilot-bridge',
      onPermissionRequest: opts?.onPermissionRequest ?? approveAll,
      onUserInputRequest: opts?.onUserInputRequest,
      streaming: true,
      systemMessage: opts?.systemMessage,
      customAgents: opts?.customAgents,
      configDir: opts?.configDir,
      workingDirectory: opts?.workingDirectory,
      reasoningEffort: opts?.reasoningEffort,
      mcpServers: opts?.mcpServers,
      skillDirectories: opts?.skillDirectories,
      tools: opts?.tools,
    });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]> {
    await this.start();
    return this.client.listSessions(filter);
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.start();
    return this.client.listModels();
  }

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    await this.start();
    return this.client.getAuthStatus();
  }

  getSession(id: string): CopilotSession | undefined {
    return this.sessions.get(id);
  }

  releaseSession(id: string): void {
    this.sessions.delete(id);
  }

  async destroySession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      try {
        await session.disconnect();
      } finally {
        this.sessions.delete(id);
      }
    }
  }

  async abortSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      await session.abort();
    }
  }

  async deleteSession(id: string): Promise<void> {
    await this.destroySession(id);
    await this.client.deleteSession(id);
  }

  isStarted(): boolean {
    return this.started;
  }

  // Session RPC proxies (accessed via private API)
  async getSessionMode(id: string): Promise<{ mode: string }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return (session as any).rpc.mode.get();
  }

  async setSessionMode(id: string, mode: string): Promise<{ mode: string }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return (session as any).rpc.mode.set({ mode });
  }

  async getSessionModel(id: string): Promise<{ modelId: string }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return (session as any).rpc.model.getCurrent();
  }

  async switchSessionModel(id: string, modelId: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    await session.setModel(modelId);
  }

  async listAgents(id: string): Promise<any[]> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return (session as any).rpc.agent.list();
  }

  async selectAgent(id: string, agentName: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return (session as any).rpc.agent.select({ name: agentName });
  }

  async deselectAgent(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return (session as any).rpc.agent.deselect();
  }
}
