/**
 * Mattermost API validation helpers.
 * Uses native fetch (Node 18+) — no @mattermost/client dependency.
 */

import type { CheckResult } from './output.js';

export interface MattermostBotInfo {
  id: string;
  username: string;
  email?: string;
  roles?: string;
  isBot?: boolean;
}

async function mmFetch(baseUrl: string, endpoint: string, token?: string): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v4${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, data: { message: err.message || String(err) } };
  }
}

export async function pingServer(baseUrl: string): Promise<CheckResult> {
  const { ok, status, data } = await mmFetch(baseUrl, '/system/ping');
  if (ok && data?.status === 'OK') {
    return { status: 'pass', label: `Mattermost: ${baseUrl}`, detail: 'reachable' };
  }
  if (status === 0) {
    return { status: 'fail', label: `Mattermost: ${baseUrl}`, detail: 'connection failed — check URL' };
  }
  return { status: 'fail', label: `Mattermost: ${baseUrl}`, detail: `HTTP ${status}` };
}

export async function validateBotToken(baseUrl: string, token: string): Promise<{ result: CheckResult; bot?: MattermostBotInfo }> {
  const { ok, status, data } = await mmFetch(baseUrl, '/users/me', token);
  if (ok && data?.id) {
    const bot: MattermostBotInfo = {
      id: data.id,
      username: data.username,
      email: data.email,
      roles: data.roles,
      isBot: data.is_bot,
    };
    const roleNote = data.roles?.includes('system_admin') ? ', admin' : '';
    return {
      result: { status: 'pass', label: `Bot "${data.username}"`, detail: `token valid${roleNote}` },
      bot,
    };
  }
  if (status === 401) {
    return { result: { status: 'fail', label: 'Bot token', detail: 'invalid or expired token' } };
  }
  return { result: { status: 'fail', label: 'Bot token', detail: `HTTP ${status}: ${data?.message || 'unknown error'}` } };
}

export async function checkChannelAccess(baseUrl: string, token: string, channelId: string, configName?: string): Promise<CheckResult> {
  const { ok, status, data } = await mmFetch(baseUrl, `/channels/${channelId}`, token);
  if (ok && data?.id) {
    const isDM = data.type === 'D' || data.type === 'G';
    const name = configName
      || data.display_name
      || (isDM ? 'DM channel' : null)
      || data.name
      || channelId;
    return { status: 'pass', label: `Channel "${name}"`, detail: isDM ? 'DM, accessible' : 'accessible' };
  }
  if (status === 403) {
    const label = configName || channelId;
    return { status: 'warn', label: `Channel "${label}"`, detail: 'bot not a member — add manually in Mattermost' };
  }
  if (status === 404) {
    const label = configName || channelId;
    return { status: 'fail', label: `Channel "${label}"`, detail: 'not found — check the channel ID' };
  }
  return { status: 'fail', label: `Channel ${channelId}`, detail: `HTTP ${status}: ${data?.message || 'unknown'}` };
}

export async function getChannelInfo(baseUrl: string, token: string, channelId: string): Promise<{ name?: string; displayName?: string; teamId?: string } | null> {
  const { ok, data } = await mmFetch(baseUrl, `/channels/${channelId}`, token);
  if (ok && data?.id) {
    return { name: data.name, displayName: data.display_name, teamId: data.team_id };
  }
  return null;
}

export async function getBotTeams(baseUrl: string, token: string): Promise<Array<{ id: string; name: string; displayName: string }>> {
  const { ok, data } = await mmFetch(baseUrl, '/users/me/teams', token);
  if (ok && Array.isArray(data)) {
    return data.map((t: any) => ({ id: t.id, name: t.name, displayName: t.display_name }));
  }
  return [];
}
