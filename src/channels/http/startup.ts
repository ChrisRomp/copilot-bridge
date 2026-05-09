import type { AuthConfig } from './auth.js';
import type { BotConfig, HttpPlatformConfig } from '../../types.js';

export type HttpRouteBotConfig = Pick<BotConfig, 'agent' | 'token'> & {
  model?: string;
};

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
