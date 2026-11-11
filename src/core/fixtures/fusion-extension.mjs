import { joinSession } from '@github/copilot-sdk/extension';

await joinSession({
  tools: [{
    name: 'bridge_fusion_smoke',
    description: 'Return a fixed marker for the isolated bridge integration check.',
    parameters: { type: 'object', properties: {} },
    handler: async () => 'BRIDGE_FUSION_EXTENSION_READY',
  }],
});
