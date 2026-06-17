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
  type TelemetryConfig,
  type ProviderConfig,
  type ContextTier,
} from '@github/copilot-sdk';
import type { SessionHooks } from './hooks-loader.js';
import type { BridgeProviderConfig } from '../types.js';

// Re-export SDK ProviderConfig under the old name for backward compat
export type SDKProviderConfig = ProviderConfig;
export type SDKReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type SDKContextTier = ContextTier;
type RuntimeSetModelOptions = {
  reasoningEffort?: SDKReasoningEffort | 'none';
  contextTier?: SDKContextTier;
};

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

  constructor(options?: { telemetry?: TelemetryConfig; env?: NodeJS.ProcessEnv }) {
    this.client = new CopilotClient({
      telemetry: options?.telemetry,
      env: options?.env,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.client.start();
    this.started = true;
    this.lifecycleUnsubscribe = this.client.onLifecycle((event) => {
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
    provider?: SDKProviderConfig;
    workingDirectory?: string;
    configDir?: string;
    reasoningEffort?: SDKReasoningEffort;
    contextTier?: SDKContextTier;
    agent?: string;
    mcpServers?: Record<string, MCPServerConfig>;
    skillDirectories?: string[];
    disabledSkills?: string[];
    excludedTools?: string[];
    onPermissionRequest: PermissionHandler;
    onUserInputRequest?: UserInputHandler;
    systemMessage?: SystemMessageConfig;
    customAgents?: CustomAgentConfig[];
    enableConfigDiscovery?: boolean;
    tools?: Tool[];
    hooks?: SessionHooks;
    infiniteSessions?: boolean;
  }): Promise<CopilotSession> {
    await this.start();
    const session = await this.client.createSession({
      clientName: 'copilot-bridge',
      model: opts.model,
      provider: opts.provider,
      workingDirectory: opts.workingDirectory,
      configDirectory: opts.configDir,
      reasoningEffort: opts.reasoningEffort,
      contextTier: opts.contextTier,
      agent: opts.agent,
      mcpServers: opts.mcpServers,
      skillDirectories: opts.skillDirectories,
      disabledSkills: opts.disabledSkills,
      excludedTools: opts.excludedTools,
      onPermissionRequest: opts.onPermissionRequest,
      onUserInputRequest: opts.onUserInputRequest,
      streaming: true,
      systemMessage: opts.systemMessage,
      customAgents: opts.customAgents,
      enableConfigDiscovery: opts.enableConfigDiscovery,
      tools: opts.tools,
      hooks: opts.hooks,
      ...(opts.infiniteSessions ? { infiniteSessions: { enabled: true } } : { infiniteSessions: { enabled: false } }),
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
      enableConfigDiscovery?: boolean;
      configDir?: string;
      workingDirectory?: string;
      provider?: SDKProviderConfig;
      reasoningEffort?: SDKReasoningEffort;
      contextTier?: SDKContextTier;
      agent?: string;
      mcpServers?: Record<string, MCPServerConfig>;
      skillDirectories?: string[];
      disabledSkills?: string[];
      excludedTools?: string[];
      tools?: Tool[];
      hooks?: SessionHooks;
      infiniteSessions?: boolean;
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
      enableConfigDiscovery: opts?.enableConfigDiscovery,
      configDirectory: opts?.configDir,
      workingDirectory: opts?.workingDirectory,
      provider: opts?.provider,
      reasoningEffort: opts?.reasoningEffort,
      contextTier: opts?.contextTier,
      agent: opts?.agent,
      mcpServers: opts?.mcpServers,
      skillDirectories: opts?.skillDirectories,
      disabledSkills: opts?.disabledSkills,
      excludedTools: opts?.excludedTools,
      tools: opts?.tools,
      hooks: opts?.hooks,
      ...(opts?.infiniteSessions ? { infiniteSessions: { enabled: true } } : { infiniteSessions: { enabled: false } }),
    });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]> {
    await this.start();
    return this.client.listSessions(filter);
  }

  async listModels(providers?: Record<string, BridgeProviderConfig>): Promise<ModelInfo[]> {
    await this.start();
    const copilotModels = await this.client.listModels();

    if (!providers || Object.keys(providers).length === 0) {
      return copilotModels;
    }

    // Append BYOK provider models with prefixed IDs
    const byokModels: ModelInfo[] = [];
    for (const [provName, prov] of Object.entries(providers)) {
      for (const m of prov.models) {
        byokModels.push({
          id: `${provName}:${m.id}`,
          name: m.name ?? m.id,
          capabilities: {
            supports: { vision: false, reasoningEffort: false },
            limits: { max_context_window_tokens: m.contextWindow ?? 0 },
          },
        } as ModelInfo);
      }
    }

    return [...copilotModels, ...byokModels];
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
  async getSessionMode(id: string): Promise<'interactive' | 'plan' | 'autopilot'> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return session.rpc.mode.get();
  }

  async setSessionMode(id: string, mode: 'interactive' | 'plan' | 'autopilot'): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    await session.rpc.mode.set({ mode });
  }

  async readPlan(id: string): Promise<{ exists: boolean; content: string | null; path: string | null }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return session.rpc.plan.read();
  }

  async updatePlan(id: string, content: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    await session.rpc.plan.update({ content });
  }

  async deletePlan(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    await session.rpc.plan.delete();
  }

  async getSessionModel(id: string): Promise<{ modelId?: string }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return session.rpc.model.getCurrent();
  }

  async switchSessionModel(id: string, modelId: string, options?: { reasoningEffort?: string | null; contextTier?: string | null }): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    const opts: RuntimeSetModelOptions = {};
    if (options) {
      if (options.reasoningEffort === null) opts.reasoningEffort = 'none';
      else if (options.reasoningEffort) opts.reasoningEffort = options.reasoningEffort as SDKReasoningEffort;
      if (options.contextTier) opts.contextTier = options.contextTier as SDKContextTier;
    }
    const sdkOpts = Object.keys(opts).length > 0 ? opts : undefined;
    // SDK typings lag the runtime: setModel accepts contextTier and "none" to clear reasoning.
    await session.setModel(modelId, sdkOpts as Parameters<CopilotSession['setModel']>[1]);
  }

  async listAgents(id: string): Promise<any> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return session.rpc.agent.list();
  }

  async selectAgent(id: string, agentName: string): Promise<any> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return session.rpc.agent.select({ name: agentName });
  }

  async deselectAgent(id: string): Promise<any> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not active`);
    return session.rpc.agent.deselect();
  }

  async listTools(model?: string): Promise<{ name: string; namespacedName?: string; description: string }[]> {
    await this.start();
    const result = await this.client.rpc.tools.list({ model });
    return result.tools;
  }
}
