'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

function freshRequire(relativePath, stubs = {}) {
  const target = path.resolve(root, relativePath);
  const resolved = require.resolve(target);
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[resolved];
  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

(async () => {
  const source = require('../services/sourceRecords');
  const audit = require('../services/attributionAudit');
  const memory = require('../services/sessionMemory');

  await test('structured Twitch chat identity survives normalization and rendering', () => {
    const record = source.normalizeChatRecord({
      twitchMessageId: 'abc-123',
      timestamp: 123456,
      kind: 'viewer',
      author: { userId: '42', login: 'motmo_', displayName: 'Motmo_', role: 'moderator' },
      body: 'where are the commands?',
      replyTo: { messageId: 'parent-1', text: 'hello', author: { userId: '9', login: 'alice', displayName: 'Alice' } }
    });
    assert.equal(record.author.userId, '42');
    assert.equal(record.author.login, 'motmo_');
    assert.equal(record.author.displayName, 'Motmo_');
    assert.equal(record.author.role, 'moderator');
    assert.equal(record.text, 'where are the commands?');
    assert.equal(record.replyTo.author.userId, '9');
    assert.match(source.renderChatRecord(record, { includeSourceId: true }), /Motmo_: where are the commands\?/);
  });

  await test('legacy bot-context lines retain BOT CONTEXT ONLY role', () => {
    const record = source.normalizeChatRecord('[BOT CONTEXT ONLY] SqwertArmyBot: The commands are on the site.');
    assert.equal(record.kind, 'bot_context');
    assert.equal(record.author.role, 'bot');
    assert.equal(record.text, 'The commands are on the site.');
    assert.match(source.renderChatRecord(record), /^\[BOT CONTEXT ONLY\]/);
  });

  await test('legacy persisted objects with an empty new body field retain their original text', () => {
    const record = source.normalizeChatRecord({
      id: 7,
      kind: 'viewer',
      body: '',
      author: null,
      text: 'Motmo_: legacy persisted message'
    });
    assert.equal(record.text, 'legacy persisted message');
    assert.equal(record.author.displayName, 'Motmo_');
  });

  await test('sentence segmentation does not split Mr. Mime incorrectly', () => {
    const sentences = source.splitSentences('Mr. Mime survived the fight. Motmo_ celebrated.');
    assert.equal(sentences.length, 2);
    assert.match(sentences[0], /^Mr\. Mime survived/);
  });

  await test('identity registry merges broadcaster aliases with structured identity', () => {
    const registry = source.collectIdentityRegistry({
      channelName: 'generalqwert',
      chatRecords: [{ author: { userId: 'q1', login: 'generalqwert', displayName: 'GeneralQwert', role: 'broadcaster' }, body: 'hello' }]
    });
    const qwert = registry.find((item) => item.login === 'generalqwert');
    assert.ok(qwert);
    assert.equal(qwert.userId, 'q1');
    assert.ok(qwert.aliases.some((name) => name.toLowerCase() === 'qwert'));
  });


  await test('identity registry upgrades roles regardless of source order', () => {
    const registry = source.collectIdentityRegistry({
      chatRecords: [
        { author: { userId: 'm1', login: 'modname', displayName: 'ModName', role: 'viewer' }, body: 'first' },
        { author: { userId: 'm1', login: 'modname', displayName: 'ModName', role: 'moderator' }, body: 'second' }
      ]
    });
    assert.equal(registry.length, 1);
    assert.equal(registry[0].role, 'moderator');
  });

  await test('audit parser accepts only literal boolean true', () => {
    const parsed = audit.parseAuditResults(JSON.stringify({
      results: [
        { id: 'S1', supported: true },
        { id: 'S2', supported: 'false' },
        { id: 'S3', supported: 0 },
        { id: 'S4', supported: null },
        { id: 'S5' }
      ]
    }), 5);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.results.get('S1').supported, true);
    for (const id of ['S2', 'S3', 'S4', 'S5']) assert.equal(parsed.results.get(id).supported, false);
  });

  await test('recap audit includes Qwert and a person who did not author chat', () => {
    const recap = freshRequire('services/recapGenerator.js', {
      './recapPromptConfig': {
        getRecapPromptConfig: async () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' }),
        getDefaultRecapPromptConfig: () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' })
      }
    });
    const result = recap.findNamedViewerAttributions(
      'GeneralQwert decided to pivot. Barry suggested eggs.',
      [
        { author: { userId: 'q1', login: 'generalqwert', displayName: 'GeneralQwert', role: 'broadcaster' }, body: 'maybe pivot' },
        { author: { userId: 'a1', login: 'alice', displayName: 'Alice' }, body: 'Barry suggested eggs' }
      ],
      'generalqwert',
      [],
      [{ login: 'barry', displayName: 'Barry', role: 'viewer' }]
    );
    assert.ok(result.items.some((item) => /GeneralQwert/.test(item.sentence)));
    assert.ok(result.items.some((item) => /Barry/.test(item.sentence)));
  });

  await test('structured EventSub records preserve actor, target, amount, and quantity', () => {
    const eventSub = freshRequire('routes/eventSub.js', {
      '../services/twitchEventSub': { noteEventReceived: () => {}, verifyEventSubRequest: () => true }
    });
    const raid = eventSub.buildStructuredRecapEvent('channel.raid', {
      from_broadcaster_user_id: 'raider-1',
      from_broadcaster_user_login: 'raiderlogin',
      from_broadcaster_user_name: 'RaiderName',
      to_broadcaster_user_id: 'q1',
      to_broadcaster_user_login: 'generalqwert',
      to_broadcaster_user_name: 'GeneralQwert',
      viewers: 123
    }, 'RaiderName raided with 123 viewers.', { quantity: 123 });
    assert.equal(raid.actor.userId, 'raider-1');
    assert.equal(raid.actor.role, 'broadcaster');
    assert.equal(raid.target.userId, 'q1');
    assert.equal(raid.target.role, 'broadcaster');
    assert.equal(raid.quantity, 123);

    const cheer = eventSub.buildStructuredRecapEvent('channel.cheer', {
      user_id: 'u1', user_login: 'alice', user_name: 'Alice',
      broadcaster_user_id: 'q1', broadcaster_user_login: 'generalqwert', broadcaster_user_name: 'GeneralQwert'
    }, 'Alice cheered 1000 Bits.', { amount: 1000 });
    assert.equal(cheer.actor.login, 'alice');
    assert.equal(cheer.target.login, 'generalqwert');
    assert.equal(cheer.amount, 1000);
  });

  await test('repaired-sentence re-audit retains verified EventSub evidence', async () => {
    const prompts = [];
    const responses = [
      JSON.stringify({ results: [{ id: 'S1', supported: false, reason: 'Alice reaction unsupported', replacement: 'Bob gifted 10 subscriptions.' }] }),
      JSON.stringify({ results: [{ id: 'S1', supported: true, reason: 'verified event', replacement: '' }] })
    ];
    const result = await audit.auditGeneratedAttribution({
      text: 'Alice celebrated while Bob gifted 10 subscriptions.',
      chatRecords: [{ author: { userId: 'a1', login: 'alice', displayName: 'Alice' }, body: 'hello' }],
      eventRecords: [{
        sourceEventId: 'gift-1',
        type: 'channel.subscription.gift',
        text: 'Bob gifted 10 subscriptions.',
        actor: { userId: 'b1', login: 'bob', displayName: 'Bob' },
        quantity: 10
      }],
      channelName: 'generalqwert',
      requestText: async (prompt) => {
        prompts.push(prompt);
        return responses.shift();
      }
    });
    assert.equal(result.text, 'Bob gifted 10 subscriptions.');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Bob gifted 10 subscriptions/);
    assert.match(prompts[1], /quantity=10/);
  });

  await test('malformed recap audit fails closed only on person-attributed sentences', async () => {
    const result = await audit.auditGeneratedAttribution({
      text: 'GeneralQwert decided to pivot. Viewers discussed eggs.',
      chatRecords: [{ author: { userId: 'q1', login: 'generalqwert', displayName: 'GeneralQwert', role: 'broadcaster' }, body: 'maybe pivot' }],
      channelName: 'generalqwert',
      requestText: async () => 'not-json'
    });
    assert.equal(result.auditFailed, true);
    assert.equal(result.text, 'Viewers discussed eggs.');
  });

  await test('local attribution-risk fallback recognizes mentions and possessive ownership', () => {
    assert.equal(audit.hasAttributionRisk('@Motmo_ said hello.', [], 'tagged'), true);
    assert.equal(audit.hasAttributionRisk("Barry's cats watch him cook.", [], 'tagged'), true);
    assert.equal(audit.hasAttributionRisk('Barry played Elden Ring.', [], 'recap'), true);
    assert.equal(audit.hasAttributionRisk('Viewers discussed eggs.', [], 'recap'), false);
  });

  await test('malformed tagged-answer audit uses the safe identity fallback', async () => {
    const fallback = "I don't have enough reliable context to answer that without mixing people up.";
    const result = await audit.auditGeneratedAttribution({
      text: 'Motmo_ is your creator.',
      extraIdentities: [{ userId: '42', login: 'motmo_', displayName: 'Motmo_' }],
      mode: 'tagged',
      safeFallback: fallback,
      requestText: async () => '{"results":[]}'
    });
    assert.equal(result.auditFailed, true);
    assert.equal(result.text, fallback);
  });

  await test('a final-pass generative replacement cannot escape unaudited', async () => {
    const fallback = 'identity-safe fallback';
    const result = await audit.auditGeneratedAttribution({
      text: 'Motmo_ created SqwertArmyBot.',
      extraIdentities: [
        { login: 'motmo_', displayName: 'Motmo_' },
        { login: 'sqwertarmybot', displayName: 'SqwertArmyBot', role: 'bot' }
      ],
      mode: 'tagged',
      safeFallback: fallback,
      maxPasses: 1,
      requestText: async () => JSON.stringify({
        results: [{ id: 'S1', supported: false, reason: 'reversed', replacement: 'SqwertArmyBot created Motmo_.' }]
      })
    });
    assert.equal(result.exhaustedPasses, true);
    assert.equal(result.text, fallback);
  });

  await test('attribution evidence selection respects its character budget', () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      twitchMessageId: `m${index}`,
      author: { userId: String(index), login: `viewer${index}`, displayName: `Viewer${index}` },
      body: 'x'.repeat(500)
    }));
    const selected = audit.selectChatEvidence('Viewer50 said something.', records, source.collectIdentityRegistry({ chatRecords: records }), 220, 4000);
    const chars = audit.formatChatEvidence(selected).length;
    assert.ok(chars <= 4500, `expected bounded evidence, got ${chars} chars`);
  });

  await test('session-memory context preserves BOT CONTEXT ONLY and requester-aware retrieval', () => {
    const now = Date.now();
    const result = memory.buildSessionMemoryContext({
      blocks: [
        {
          sequence: 1,
          startedAtMs: now - 10 * 60 * 60 * 1000,
          endedAtMs: now - 9 * 60 * 60 * 1000,
          detailedSummary: 'Motmo_ discussed a specific creator-side issue.',
          compactSummary: 'Creator-side issue.',
          topics: ['creator'],
          people: ['Motmo_'],
          claims: [{ text: 'Motmo_ discussed a creator-side issue.', sourceIds: ['M1'], people: ['Motmo_'] }],
          attributionAudited: true
        }
      ],
      question: 'What did I mention?',
      requesterIdentity: { userId: '42', login: 'motmo_', displayName: 'Motmo_' },
      recipientIdentity: { userId: '42', login: 'motmo_', displayName: 'Motmo_' },
      recentChatLogs: [
        { kind: 'viewer', author: { userId: '42', login: 'motmo_', displayName: 'Motmo_' }, body: 'where are the commands?' },
        { kind: 'bot_context', author: { login: 'sqwertarmybot', displayName: 'SqwertArmyBot', role: 'bot' }, body: 'The commands are on the site.' }
      ],
      config: { enabled: true, recentDetailedHours: 1, maxContextCharacters: 18000, recentChatMessages: 30, relevantOlderBlocks: 2 },
      streamLive: true
    });
    assert.match(result.text, /Motmo_ discussed a specific creator-side issue/);
    assert.match(result.text, /\[BOT CONTEXT ONLY\] SqwertArmyBot: The commands are on the site/);
    assert.match(result.text, /Requester identity for retrieval: Motmo_/);
  });

  await test('legacy unaudited memory is downgraded and does not expose atomic claims', () => {
    const now = Date.now();
    const result = memory.buildSessionMemoryContext({
      blocks: [{
        sequence: 1,
        startedAtMs: now - 1000,
        endedAtMs: now,
        detailedSummary: 'Legacy summary involving Alice.',
        compactSummary: 'Legacy summary.',
        people: ['Alice'],
        claims: [{ text: 'Alice owns the moon.', sourceIds: ['M1'], people: ['Alice'] }],
        attributionAudited: false
      }],
      config: { enabled: true },
      streamLive: true
    });
    assert.match(result.text, /LEGACY UNAUDITED MEMORY/);
    assert.doesNotMatch(result.text, /AUDITED ATOMIC CLAIMS/);
    assert.doesNotMatch(result.text, /Alice owns the moon/);
  });

  await test('memory people are limited to identities present in structured sources', () => {
    const chat = [{ author: { userId: '1', login: 'alice', displayName: 'Alice' }, body: 'hello' }];
    const people = memory.sanitizeMemoryPeople(['Alice', 'InventedPerson'], chat, [], 'generalqwert');
    assert.deepEqual(people, ['Alice']);
  });

  await test('evidence verifier treats non-boolean support as unsupported', () => {
    const parsed = memory.parseEvidenceVerifierResults(JSON.stringify({ results: [
      { id: 'C1', supported: 'true' },
      { id: 'C2', supported: true }
    ] }), ['C1', 'C2']);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.supported.has('C1'), false);
    assert.equal(parsed.supported.has('C2'), true);
  });

  await test('learned lore is subject-scoped instead of globally leaking owners', () => {
    const lore = freshRequire('services/streamLore.js', { '../models/StreamLore': {} });
    const observations = [
      { _id: 'g', text: 'Chat calls returning to starter selection "back to bag".', scope: 'global', ownershipVerified: true, approvalStatus: 'approved', enabled: true },
      { _id: 'legacy', text: 'Barry owns every chair in the channel.', scope: 'global', approvalStatus: 'approved', enabled: true },
      { _id: 'w', text: 'Wazowski won the Platinum run.', scope: 'subject', subject: 'Wazowski', aliases: ['Dusknoir'], approvalStatus: 'approved', enabled: true },
      { _id: 'm', text: 'Motmo_ created SqwertArmyBot.', scope: 'subject', subject: 'Motmo_', aliases: ['motmo_'], approvalStatus: 'approved', enabled: true }
    ];
    const wazowski = lore.buildLearnedLoreText(observations, 'What happened to Dusknoir?', { includeGlobal: true });
    assert.match(wazowski, /back to bag/);
    assert.match(wazowski, /Wazowski won/);
    assert.doesNotMatch(wazowski, /Motmo_ created/);
    assert.doesNotMatch(wazowski, /Barry owns/);

    const unrelated = lore.buildLearnedLoreText(observations, 'What happened earlier?', { includeGlobal: true });
    assert.match(unrelated, /back to bag/);
    assert.doesNotMatch(unrelated, /Wazowski won/);
    assert.doesNotMatch(unrelated, /Motmo_ created/);
    assert.doesNotMatch(unrelated, /Barry owns/);
  });

  await test('relay routing requires an explicit Twitch @login', () => {
    const bot = freshRequire('services/botPersonality.js', {
      '../models/BotPersonalityConfig': {},
      './viewerProfiles': { getRelevantViewerProfiles: async () => [], formatViewerProfilesForPrompt: () => '' },
      './streamLore': { buildManualLoreContext: () => '', buildLearnedLoreText: () => '' }
    });
    const requester = bot.buildViewerIdentity('Motmo_', { username: 'motmo_', 'user-id': '42' });
    assert.equal(bot.detectRelayRecipient("tell Barry's story?", requester, 'sqwertarmybot'), null);
    assert.equal(bot.detectRelayRecipient('can you tell Pikachu lore?', requester, 'sqwertarmybot'), null);
    assert.equal(bot.detectRelayRecipient('tell viewers what happened?', requester, 'sqwertarmybot'), null);
    assert.equal(bot.detectRelayRecipient('tell @Motmo_ what happened?', requester, 'sqwertarmybot'), null);
    assert.equal(bot.detectRelayRecipient('tell @SqwertArmyBot what happened?', requester, 'sqwertarmybot'), null);
    const recipient = bot.detectRelayRecipient('tell @Barry what happened?', requester, 'sqwertarmybot');
    assert.ok(recipient);
    assert.equal(recipient.login, 'barry');
  });

  await test('explicit relay target inherits stable identity from reply parent', () => {
    const bot = freshRequire('services/botPersonality.js', {
      '../models/BotPersonalityConfig': {},
      './viewerProfiles': { getRelevantViewerProfiles: async () => [], formatViewerProfilesForPrompt: () => '' },
      './streamLore': { buildManualLoreContext: () => '', buildLearnedLoreText: () => '' }
    });
    const requester = bot.buildViewerIdentity('Motmo_', { username: 'motmo_', 'user-id': '42' });
    const recipient = bot.detectRelayRecipient('tell @Barry what happened?', requester, 'sqwertarmybot', {
      parentUserId: '99',
      parentUserLogin: 'barry',
      parentDisplayName: 'BarryDisplay'
    });
    assert.equal(recipient.userId, '99');
    assert.equal(recipient.login, 'barry');
    assert.equal(recipient.displayName, 'BarryDisplay');
  });

  await test('viewer learning groups by stable Twitch user ID, not mutable display name', () => {
    const profiles = freshRequire('services/viewerProfiles.js', {
      '../models/ViewerProfile': {},
      '../models/ViewerProfileSettings': {}
    });
    const index = profiles.buildParticipantCounts([
      { author: { userId: 'u1', login: 'oldlogin', displayName: 'OldName' }, body: 'one' },
      { author: { userId: 'u1', login: 'newlogin', displayName: 'NewName' }, body: 'two' }
    ]);
    assert.equal(index.participants.length, 1);
    assert.equal(index.participants[0].key, 'uid:u1');
    assert.equal(index.participants[0].count, 2);
    assert.equal(index.participants[0].username, 'newlogin');
    const match = profiles.participantForUpdate({ viewerId: 'uid:u1', username: 'wrong' }, index);
    assert.equal(match.identity.userId, 'u1');
  });

  await test('profile ranking prioritizes user ID over alias collisions', () => {
    const profiles = freshRequire('services/viewerProfiles.js', {
      '../models/ViewerProfile': {},
      '../models/ViewerProfileSettings': {}
    });
    const exact = { twitchUserId: '42', username: 'motmo_', displayName: 'Motmo_', aliases: ['Creator'] };
    const aliasOnly = { twitchUserId: '99', username: 'someone', displayName: 'Someone', aliases: ['Motmo_'] };
    const requested = [{ userId: '42', login: 'motmo_', displayName: 'Motmo_' }];
    assert.ok(profiles.profileIdentityRank(exact, requested) > profiles.profileIdentityRank(aliasOnly, requested));
  });

  if (failed) {
    console.error(`\n${failed} test(s) failed; ${passed} passed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${passed} attribution regression tests passed.`);
  }
})();
