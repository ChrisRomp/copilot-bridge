import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { CopilotBridge } from './bridge.js';
import { FusionManager } from './fusion-manager.js';
import { initStore, closeDb, getChannelPrefs, setChannelPrefs } from '../state/store.js';

// Explicit opt-in: startup requires local Copilot authentication, and inference
// checks use the operator's quota. Never load the bridge's real state/config.
describe.skipIf(process.env.COPILOT_BRIDGE_FUSION_LIVE !== '1')('live Fusion runtime', () => {
  let directory: string;
  let home: string;
  let workspace: string;
  let bridge: CopilotBridge;
  let session: CopilotSession;
  let env: NodeJS.ProcessEnv;
  const options = () => ({
    model: 'auto',
    workingDirectory: workspace,
    configDir: home,
    enableConfigDiscovery: true,
    mcpServers: {},
    skillDirectories: [],
    onPermissionRequest: () => ({ kind: 'approve-once' as const }),
    hooks: {
      onPreToolUse: (input: { toolName: string }) => input.toolName === 'bridge_fusion_smoke'
        ? undefined : { permissionDecision: 'deny', permissionDecisionReason: 'Only the fixed smoke-test tool is permitted.' },
    },
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'copilot-bridge-fusion-'));
    home = join(directory, 'config');
    workspace = join(directory, 'work');
    const extension = join(home, 'extensions', 'fusion-smoke');
    await mkdir(extension, { recursive: true });
    await mkdir(workspace);
    await initStore(undefined, join(directory, 'state.db'));
    await setChannelPrefs('fusion-smoke', { model: 'auto', provider: null, fusionTier: 'default' });
    await copyFile(fileURLToPath(new URL('./fixtures/fusion-extension.mjs', import.meta.url)), join(extension, 'extension.mjs'));
    env = { ...process.env, COPILOT_HOME: home, COPILOT_CACHE_HOME: join(home, 'cache') };
    delete env.COPILOT_CLI_PATH;
    bridge = new CopilotBridge({ env });
    expect((await bridge.getFusionMetadata())?.defaultTier).toBeTruthy();
    session = await bridge.createSession(options());
  }, 60_000);

  afterAll(async () => {
    try { if (bridge) await bridge.stop(); }
    finally {
      await closeDb();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('creates and cold-resumes the real full CLI host with an extension', async () => {
    const checkExtension = async () => {
      await expect.poll(async () => (await session.rpc.extensions.list()).extensions
        .find(extension => extension.name === 'fusion-smoke')?.status, { timeout: 15_000 }).toBe('running');
      const result = await session.rpc.tools.execute({ name: 'bridge_fusion_smoke', arguments: {}, toolCallId: randomUUID() });
      expect(JSON.stringify(result)).toContain('BRIDGE_FUSION_EXTENSION_READY');
    };
    await checkExtension();
    await session.log('Fusion integration startup check');
    const id = session.sessionId;
    await bridge.stop();
    bridge = new CopilotBridge({ env });
    session = await bridge.resumeSession(id, options());
    await checkExtension();
    expect((await session.rpc.model.getCurrent()).modelId).toBe('auto');
  }, 60_000);

  it('discovers policy-aware tiers and probes pending/default/effort behavior', async () => {
    const catalog = await session.rpc.model.list({ skipCache: true });
    expect(catalog.list.length).toBeGreaterThan(0);
    expect(catalog.auto?.defaultTier).toBeTruthy();
    console.log('Fusion catalog', JSON.stringify(catalog.auto?.tiers.map(tier => ({
      id: tier.id, fusionTier: tier.fusionTier, type: tier.type, status: tier.status,
    }))));
    const tier = catalog.auto?.tiers.find(tier => tier.fusionTier === 'high' && tier.status.enabled)
      ?? catalog.auto?.tiers.find(tier => tier.fusionTier === 'standard' && tier.status.enabled);
    expect(tier).toBeDefined();
    const result = await session.setAutoTier(tier!.id);
    console.log('Tier accepted', JSON.stringify(result));
    console.log('Before model-only switch', JSON.stringify(await session.rpc.model.getCurrent()));
    if (tier!.type === 'fusion') {
      await expect(session.setModel('auto', { reasoningEffort: 'high' })).rejects.toThrow('do not support reasoning effort');
    }
    await session.setModel('auto');
    console.log('After model-only switch', JSON.stringify(await session.rpc.model.getCurrent()));
    const id = session.sessionId;
    await bridge.stop();
    bridge = new CopilotBridge({ env });
    session = await bridge.resumeSession(id, options());
    await session.rpc.model.list();
    console.log('After cold resume', JSON.stringify(await session.rpc.model.getCurrent()));
    console.log('Reset result', JSON.stringify(await session.setAutoTier(null)));
    await expect(session.setAutoTier('bridge-nonexistent-fusion-tier')).rejects.toThrow();
    console.log('After rejected tier', JSON.stringify(await session.rpc.model.getCurrent()));
  }, 60_000);

  it('switches from a fixed model with effort/context preferences without forwarding them into Fusion', async () => {
    const models = await bridge.listModels();
    const fixed = models.find(model => model.id !== 'auto' && model.supportedReasoningEfforts?.includes('high'));
    expect(fixed).toBeDefined();
    await bridge.switchSessionModel(session.sessionId, fixed!.id, { reasoningEffort: 'high' });
    await setChannelPrefs('fusion-smoke', { model: fixed!.id, reasoningEffort: 'high', contextTier: 'long_context', fusionTier: 'default' });
    const controller = new FusionManager(bridge, async () => (await getChannelPrefs('fusion-smoke'))!, () => {});
    controller.attach('fusion-smoke', session);
    const metadata = await bridge.getFusionMetadata(session.sessionId, true);
    const preferred = metadata?.tiers.find(tier => tier.fusionTier === 'high' && tier.status.enabled) ? 'high' : 'standard';
    await controller.select('fusion-smoke', preferred);
    expect((await bridge.getSessionModel(session.sessionId)).modelId).toBe('auto');
    expect(await getChannelPrefs('fusion-smoke')).toMatchObject({ reasoningEffort: 'high', contextTier: 'long_context' });
  }, 30_000);

  it.skipIf(process.env.COPILOT_BRIDGE_FUSION_INFERENCE !== '1').each(['standard', 'high', 'max'] as const)(
    'reports real %s routing, output attribution and committed tier state', async name => {
      const catalog = await session.rpc.model.list({ skipCache: true });
      const tier = catalog.auto?.tiers.find(tier => tier.fusionTier === name);
      if (!tier?.status.enabled) {
        console.log(`Tier ${name} unavailable: ${tier?.status.message ?? tier?.status.reason ?? 'not advertised'}`);
        return;
      }
      const events: SessionEvent[] = [];
      const visibleMessages: Array<Extract<SessionEvent, { type: 'assistant.message' }>> = [];
      const controller = new FusionManager(bridge, async () => (await getChannelPrefs('fusion-smoke'))!, (_sid, _channel, content) => {
        console.log('Bridge notice', content);
      });
      controller.attach('fusion-smoke', session);
      const unsubscribe = session.on(event => {
        events.push(event);
        const routed = controller.process('fusion-smoke', session, event);
        if (routed.notice) console.log('Actual model notice', JSON.stringify(routed.notice));
        if (!routed.suppress && event.type === 'assistant.message' && event.data.content) visibleMessages.push(event);
      });
      try {
        const selection = await controller.select('fusion-smoke', name);
        expect(['pending', 'applied', 'unchanged']).toContain(selection.status);
        await controller.prepare('fusion-smoke', true);
        const reply = await session.sendAndWait({
          prompt: 'Without tools, explain in at most 100 words how to prevent stale asynchronous permission checks from approving work after a mode change. Include one concrete race and a correction.',
        }, 150_000);
        expect(reply?.data.content).toBeTruthy();
        const current = await session.rpc.model.getCurrent();
        expect(current.autoTier).toBe(tier.id);
        await expect.poll(async () => (await getChannelPrefs('fusion-smoke'))?.fusionTransition).toBeNull();
        expect((await getChannelPrefs('fusion-smoke'))?.fusionTier).toBe(name);
        expect(visibleMessages.length).toBeGreaterThan(0);
        expect(visibleMessages.every(event => !event.data.fusion || (event.data.fusion.commitId && event.data.fusion.conversationScope !== 'review'))).toBe(true);
        console.log('Committed', name, JSON.stringify(current));
        for (const event of events) {
          if (event.agentId) continue;
          if (event.type === 'assistant.message') {
            const data = event.data;
            console.log('Output', JSON.stringify({
              type: event.type, messageId: data.messageId,
              ...('fusion' in data ? { fusion: data.fusion } : {}),
              ...('content' in data ? { contentLength: data.content.length } : {}),
            }));
          } else if (event.type === 'assistant.fusion_phase_started'
              || event.type === 'session.model_change' || event.type === 'session.auto_tier_switch_failed'
              || event.type === 'session.idle') {
            console.log('Routing', event.type, JSON.stringify(event.data));
          }
        }
      } finally {
        unsubscribe();
      }
    }, 180_000,
  );
});
