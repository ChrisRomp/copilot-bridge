import type { FastifyInstance } from 'fastify';
import type { PermissionHandler, SessionEvent } from '@github/copilot-sdk';
import type { AuthConfig } from './auth.js';
import type { BotConfig, HttpPlatformConfig } from '../../types.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerRunEventsRoutes } from './routes/runs-events.js';
import { registerRunStreamRoutes } from './routes/runs-stream.js';
import { registerRunResumeRoutes } from './routes/runs-resume.js';
import { RunRegistry } from './run-registry.js';
import { PermissionStore } from './permission-store.js';
import { PendingPermissionStore } from './pending-permission-store.js';
import type { HttpChannelAdapter } from './index.js';

export type HttpRouteBotConfig = Pick<BotConfig, 'agent' | 'token'> & {
  model?: string;
};

export interface HttpAcpRouteDeps {
  adapter: HttpChannelAdapter;
  bots: Record<string, HttpRouteBotConfig>;
  registerChannel: (channelId: string, bot: string) => Promise<void>;
  createSessionWithPermissions: (
    channelId: string,
    bot: string,
    onPermissionRequest: PermissionHandler,
  ) => Promise<{ sessionId: string }>;
  getSession: (sessionId: string) => { getMessages(): Promise<SessionEvent[]> } | undefined;
  abortSession: (sessionId: string) => Promise<void>;
  subscribeToSessionEvents: (
    channelId: string,
    handler: (sessionId: string, channelId: string, event: unknown) => void,
  ) => () => void;
  addPermissionRule: (channelId: string, toolName: string, cmd: string, action: 'allow' | 'deny') => Promise<void>;
  checkPermission: (channelId: string, toolName: string, command: string) => Promise<'allow' | 'deny' | null>;
}

export interface HttpAcpRouteStores {
  runRegistry: RunRegistry;
  permissionStore: PermissionStore;
  pendingPermissionStore: PendingPermissionStore;
}

export function buildHttpAuthConfig(
  httpConfig: HttpPlatformConfig,
  getSecret: (keyName: string) => string | undefined,
): AuthConfig {
  const keys = new Map<string, { secret: string; allowedAgents: string[]; allowedOps: string[] }>();

  for (const [keyName, apiKey] of Object.entries(httpConfig.apiKeys)) {
    const secret = getSecret(keyName);
    if (!secret) {
      throw new Error(`Platform "http" apiKey "${keyName}" secret was not resolved at startup`);
    }

    keys.set(keyName, {
      secret,
      allowedAgents: [...apiKey.allowedAgents],
      allowedOps: [...apiKey.allowedOps],
    });
  }

  return { keys };
}

export function buildHttpRouteBots(httpConfig: HttpPlatformConfig): Record<string, HttpRouteBotConfig> {
  return Object.fromEntries(
    Object.entries(httpConfig.bots ?? {}).map(([botName, bot]) => [
      botName,
      {
        token: bot.token,
        agent: bot.agent,
      },
    ]),
  );
}

export function registerHttpAcpRoutes(app: FastifyInstance, deps: HttpAcpRouteDeps): HttpAcpRouteStores {
  const runRegistry = new RunRegistry();
  const permissionStore = new PermissionStore();
  const pendingPermissionStore = new PendingPermissionStore();

  registerAgentRoutes(app, { bots: deps.bots });
  registerRunRoutes(app, {
    adapter: deps.adapter,
    runRegistry,
    permissionStore,
    pendingPermissionStore,
    checkPermission: deps.checkPermission,
    createSessionWithPermissions: async (channelId, bot, onPermissionRequest) => {
      await deps.registerChannel(channelId, bot);
      return deps.createSessionWithPermissions(channelId, bot, onPermissionRequest);
    },
    getSession: deps.getSession,
    abortSession: deps.abortSession,
  });
  registerRunEventsRoutes(app, { runRegistry, getSession: deps.getSession });
  registerRunStreamRoutes(app, {
    runRegistry,
    subscribeToSessionEvents: deps.subscribeToSessionEvents,
    getSession: deps.getSession,
  });
  registerRunResumeRoutes(app, {
    runRegistry,
    permissionStore,
    pendingPermissionStore,
    addPermissionRule: deps.addPermissionRule,
  });

  return { runRegistry, permissionStore, pendingPermissionStore };
}
