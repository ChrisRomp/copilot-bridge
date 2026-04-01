/**
 * Integration test: Mattermost admin API + dynamic channel persistence.
 *
 * Tests: getTeams, createChannel, addUserToChannel, getChannelByName,
 *        and SQLite dynamic channel CRUD.
 *
 * Run: npx tsx scripts/test-admin-api.ts
 */
import { loadConfig, getConfig } from '../src/config.js';
import { MattermostAdapter } from '../src/channels/mattermost/adapter.js';
import { addDynamicChannel, getDynamicChannel, getDynamicChannels, removeDynamicChannel } from '../src/state/store.js';

const TEST_CHANNEL_NAME = `test-admin-api-${Date.now()}`;

async function main() {
  console.log('=== Admin API Integration Test ===\n');

  // Load config and find admin bot
  loadConfig();
  const config = getConfig();
  const platformName = Object.keys(config.platforms)[0];
  const platform = config.platforms[platformName];
  if (!platform.bots) throw new Error('No multi-bot config found');

  const adminEntry = Object.entries(platform.bots).find(([, b]) => (b as any).admin);
  if (!adminEntry) throw new Error('No admin bot found');
  const [adminBotName, adminBot] = adminEntry;
  console.log(`Using admin bot: ${adminBotName} on ${platform.url}\n`);

  // Create adapter and connect (just REST, no WS needed)
  const adapter = new MattermostAdapter(platformName, platform.url, adminBot.token);
  // Minimal connect — we need bot identity
  await adapter.connect();

  // --- Test 1: getTeams ---
  console.log('1. getTeams()');
  const teams = await adapter.getTeams!();
  console.log(`   Found ${teams.length} team(s): ${teams.map(t => t.name).join(', ')}`);
  if (teams.length === 0) throw new Error('No teams found');
  const teamId = teams[0].id;
  console.log(`   Using team: ${teams[0].name} (${teamId})\n`);

  // --- Test 2: createChannel ---
  console.log(`2. createChannel("${TEST_CHANNEL_NAME}", private)`);
  const channelId = await adapter.createChannel!({
    name: TEST_CHANNEL_NAME,
    displayName: `Test Admin API ${Date.now()}`,
    private: true,
    teamId,
  });
  console.log(`   Created channel: ${channelId}\n`);

  // --- Test 3: getChannelByName ---
  console.log(`3. getChannelByName("${TEST_CHANNEL_NAME}")`);
  const found = await adapter.getChannelByName!(teamId, TEST_CHANNEL_NAME);
  if (!found) throw new Error('Channel not found after creation');
  console.log(`   Found: ${found.name} (${found.id}), type=${found.type}\n`);

  // --- Test 4: addUserToChannel (add another bot) ---
  const otherBotEntry = Object.entries(platform.bots).find(([name]) => name !== adminBotName);
  if (otherBotEntry) {
    const [otherBotName, otherBot] = otherBotEntry;
    console.log(`4. addUserToChannel (adding ${otherBotName})`);
    // Need the other bot's user ID — create a temp adapter
    const otherAdapter = new MattermostAdapter(platformName, platform.url, otherBot.token);
    await otherAdapter.connect();
    const otherBotUserId = otherAdapter.getBotUserId();
    await adapter.addUserToChannel!(channelId, otherBotUserId);
    console.log(`   Added ${otherBotName} (${otherBotUserId}) to channel\n`);
    await otherAdapter.disconnect();
  } else {
    console.log('4. addUserToChannel — skipped (only one bot configured)\n');
  }

  // --- Test 5: Post a message ---
  console.log('5. sendMessage (verify bot can post)');
  const postId = await adapter.sendMessage(channelId, '🧪 Admin API integration test — this channel will be deleted shortly.');
  console.log(`   Posted: ${postId}\n`);

  // --- Test 6: Dynamic channel SQLite CRUD ---
  console.log('6. Dynamic channel persistence');
  await addDynamicChannel({
    channelId,
    platform: platformName,
    name: TEST_CHANNEL_NAME,
    bot: adminBotName,
    workingDirectory: '/tmp/test-workspace',
    isDM: false,
  });
  const stored = await getDynamicChannel(channelId);
  if (!stored) throw new Error('Dynamic channel not found in SQLite');
  console.log(`   Stored: ${stored.channelId} → ${stored.workingDirectory}`);
  const all = await getDynamicChannels();
  console.log(`   Total dynamic channels: ${all.length}`);
  await removeDynamicChannel(channelId);
  const afterRemove = await getDynamicChannel(channelId);
  if (afterRemove) throw new Error('Dynamic channel still exists after removal');
  console.log(`   Removed: confirmed\n`);

  // --- Cleanup: delete the test channel ---
  console.log('7. Cleanup: deleting test channel');
  try {
    const baseUrl = (adapter as any).client.getBaseRoute();
    const token = (adapter as any).token;
    const resp = await fetch(`${baseUrl}/channels/${channelId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (resp.ok) {
      console.log(`   Deleted channel ${channelId}\n`);
    } else {
      console.log(`   Warning: could not delete channel (${resp.status}) — clean up manually\n`);
    }
  } catch (err) {
    console.log(`   Warning: cleanup error — ${err}\n`);
  }

  await adapter.disconnect();

  console.log('=== All tests passed ✅ ===');
}

main().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
