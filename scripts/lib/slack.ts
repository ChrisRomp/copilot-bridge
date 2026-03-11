/**
 * Slack setup helpers for the init wizard.
 * Generates app manifests and validates tokens.
 */

/**
 * Generate a Slack App Manifest for copilot-bridge.
 * This pre-configures all required scopes, events, and Socket Mode.
 */
export function generateManifest(botName: string): object {
  return {
    display_information: {
      name: botName,
      description: 'GitHub Copilot bridge for Slack',
      background_color: '#1a1a2e',
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: botName,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'chat:write',
          'chat:write.public',
          'channels:history',
          'channels:read',
          'groups:read',
          'groups:history',
          'im:history',
          'im:read',
          'im:write',
          'files:read',
          'files:write',
          'reactions:read',
          'reactions:write',
          'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          'message.channels',
          'message.groups',
          'message.im',
          'reaction_added',
          'reaction_removed',
        ],
      },
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Generate a URL that opens Slack's "Create App" page with the manifest pre-filled.
 */
export function generateManifestUrl(botName: string): string {
  const manifest = generateManifest(botName);
  const encoded = encodeURIComponent(JSON.stringify(manifest));
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encoded}`;
}

/**
 * Validate a Slack bot token by calling auth.test.
 * Returns bot info on success or null on failure.
 */
export async function validateSlackToken(token: string): Promise<{
  ok: boolean;
  userId?: string;
  botName?: string;
  teamName?: string;
  error?: string;
}> {
  try {
    const resp = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };

    const data = await resp.json() as any;
    if (!data.ok) return { ok: false, error: data.error };

    return {
      ok: true,
      userId: data.user_id,
      botName: data.user,
      teamName: data.team,
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Validate a Slack app-level token by attempting a connections.open.
 * This confirms Socket Mode will work.
 */
export async function validateAppToken(appToken: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const resp = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };

    const data = await resp.json() as any;
    if (!data.ok) return { ok: false, error: data.error };

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Resolve a Slack username/handle to a user ID.
 * Uses the users.list API with pagination to find a matching user.
 * Handle is case-insensitive with leading @ stripped.
 */
export async function resolveSlackUser(botToken: string, handle: string): Promise<{
  userId: string | null;
  displayName?: string;
  error?: string;
}> {
  const normalized = handle.replace(/^@/, '').toLowerCase();
  let cursor: string | undefined;

  try {
    do {
      const params = new URLSearchParams({ limit: '200' });
      if (cursor) params.set('cursor', cursor);

      const resp = await fetch(`https://slack.com/api/users.list?${params}`, {
        headers: { 'Authorization': `Bearer ${botToken}` },
      });
      if (!resp.ok) return { userId: null, error: `HTTP ${resp.status}` };

      const data = await resp.json() as any;
      if (!data.ok) return { userId: null, error: data.error };

      for (const member of data.members ?? []) {
        if (member.deleted || member.is_bot) continue;
        const name = (member.name ?? '').toLowerCase();
        // Prefer unique handle (member.name) over display/real name for security
        if (name === normalized) {
          return { userId: member.id, displayName: member.profile?.display_name || member.real_name || member.name };
        }
      }

      // Second pass: try display_name and real_name (less reliable, not unique)
      for (const member of data.members ?? []) {
        if (member.deleted || member.is_bot) continue;
        const displayName = member.profile?.display_name_normalized?.toLowerCase() ?? '';
        const realName = member.profile?.real_name_normalized?.toLowerCase() ?? '';
        if (displayName === normalized || realName === normalized) {
          return { userId: member.id, displayName: member.profile?.display_name || member.real_name || member.name };
        }
      }

      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return { userId: null, error: `User "${handle}" not found` };
  } catch (err: any) {
    return { userId: null, error: err.message };
  }
}
