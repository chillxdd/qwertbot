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


  await test('recap length plans count viewer/mod messages, not bot-context lines', () => {
    const recap = freshRequire('services/recapGenerator.js', {
      './geminiClient': { requestGeminiDataWithRetry: async () => ({ text: '' }) },
      './recapPromptConfig': {
        getRecapPromptConfig: async () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' }),
        getDefaultRecapPromptConfig: () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' })
      }
    });
    const viewerRecords = Array.from({ length: 20 }, (_, index) => ({
      author: { userId: `u${index % 4}`, login: `viewer${index % 4}`, displayName: `Viewer${index % 4}` },
      body: `viewer message ${index}`
    }));
    const botRecords = Array.from({ length: 30 }, (_, index) => ({
      kind: 'bot_context',
      author: { login: 'sqwertarmybot', displayName: 'SqwertArmyBot', role: 'bot' },
      body: `bot context ${index}`
    }));

    const normal = recap.getRecapLengthPlan([...viewerRecords, ...botRecords], []);
    assert.equal(normal.viewerMessageCount, 20);
    assert.equal(normal.uniqueViewerCount, 4);
    assert.equal(normal.eligible, true);
    assert.equal(normal.targetMin, 400);
    assert.equal(normal.acceptableMin, 380);

    const light = recap.getRecapLengthPlan(viewerRecords.slice(0, 10), []);
    assert.equal(light.eligible, true);
    assert.equal(light.targetMin, 330);
    assert.equal(light.acceptableMin, 300);
    assert.equal(light.finalRecoveryAttempts, 1);

    const quiet = recap.getRecapLengthPlan([...viewerRecords.slice(0, 9), ...botRecords], []);
    assert.equal(quiet.viewerMessageCount, 9);
    assert.equal(quiet.eligible, false);
  });

  await test('final attribution shrink triggers a source-grounded length recovery', async () => {
    const makeSummary = (lead, targetLength) => {
      let value = `${lead} `;
      const filler = 'Chat also compared specific snack ideas, game mechanics, recurring jokes, and unusual stream suggestions. ';
      while (value.length + filler.length + 1 < targetLength) value += filler;
      if (value.length < targetLength - 1) value += 'x'.repeat(targetLength - value.length - 1);
      return `${value.trimEnd()}.`;
    };
    const primary = makeSummary('Chat discussed several supported topics.', 390);
    const auditedShort = makeSummary('Chat discussed two supported topics.', 210);
    const recovered = makeSummary('Chat discussed several specific supported topics.', 410);
    const requestLabels = [];

    const recap = freshRequire('services/recapGenerator.js', {
      './geminiClient': {
        requestGeminiDataWithRetry: async (_prompt, options = {}) => {
          requestLabels.push(options.label);
          if (options.label === 'hourly-recap-primary') return { text: primary };
          if (options.label === 'hourly-recap-final-recovery-1') return { text: recovered };
          throw new Error(`Unexpected Gemini label: ${options.label}`);
        }
      },
      './recapPromptConfig': {
        getRecapPromptConfig: async () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' }),
        getDefaultRecapPromptConfig: () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' })
      },
      './attributionAudit': {
        auditGeneratedAttribution: async ({ text, label }) => {
          const next = label === 'hourly-recap-attribution-final-post-bot' ? auditedShort : text;
          return {
            text: next,
            changed: next !== text,
            audited: 0,
            unsupported: [],
            auditFailed: false,
            error: ''
          };
        }
      }
    });

    const records = Array.from({ length: 25 }, (_, index) => ({
      twitchMessageId: `m${index}`,
      author: { userId: `u${index % 5}`, login: `viewer${index % 5}`, displayName: `Viewer${index % 5}` },
      body: `specific source discussion ${index}`
    }));
    const result = await recap.generateRecap(records, [], [], [], '', {}, 'generalqwert', 'SqwertArmyBot');

    assert.ok(requestLabels.includes('hourly-recap-final-recovery-1'));
    assert.ok(result.summary.length >= 380, `expected recovered recap >= 380 chars, got ${result.summary.length}`);
    assert.equal(result.summary, recovered);
  });

  await test('quiet recap windows are not padded merely to hit a length target', async () => {
    const requestLabels = [];
    const shortSummary = 'Chat briefly compared two snack ideas and a game mechanic.';
    const recap = freshRequire('services/recapGenerator.js', {
      './geminiClient': {
        requestGeminiDataWithRetry: async (_prompt, options = {}) => {
          requestLabels.push(options.label);
          if (options.label === 'hourly-recap-primary') return { text: shortSummary };
          throw new Error(`Unexpected Gemini label: ${options.label}`);
        }
      },
      './recapPromptConfig': {
        getRecapPromptConfig: async () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' }),
        getDefaultRecapPromptConfig: () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' })
      },
      './attributionAudit': {
        auditGeneratedAttribution: async ({ text }) => ({
          text,
          changed: false,
          audited: 0,
          unsupported: [],
          auditFailed: false,
          error: ''
        })
      }
    });
    const records = Array.from({ length: 9 }, (_, index) => ({
      twitchMessageId: `quiet-${index}`,
      author: { userId: `u${index % 2}`, login: `viewer${index % 2}`, displayName: `Viewer${index % 2}` },
      body: `quiet source ${index}`
    }));
    const result = await recap.generateRecap(records, [], [], [], '', {}, 'generalqwert', 'SqwertArmyBot');
    assert.equal(result.summary, shortSummary);
    assert.deepEqual(requestLabels, ['hourly-recap-primary']);
  });


  await test('Shared Chat provenance uses source room and canonical source message IDs', () => {
    const ownRoomTags = {
      'room-id': '100',
      'source-room-id': '100',
      'source-id': 'original-1',
      id: 'destination-copy-1',
      badges: { moderator: '1' }
    };
    const ownOrigin = source.sharedChatOriginFromTwitchTags(ownRoomTags);
    assert.equal(ownOrigin.type, 'shared_local');
    assert.equal(ownOrigin.persistentLearningEligible, true);
    assert.equal(source.roleFromTwitchTags(ownRoomTags), 'moderator');
    assert.equal(source.canonicalChatMessageId({
      twitchMessageId: ownRoomTags.id,
      body: 'hello',
      author: { login: 'alice', displayName: 'Alice' },
      sharedChat: ownOrigin
    }), 'original-1');

    const guestTags = {
      'room-id': '100',
      'source-room-id': '200',
      'source-id': 'original-2',
      id: 'destination-copy-2',
      badges: {},
      'source-badges': 'broadcaster/1,subscriber/12',
      mod: '1',
      subscriber: '1'
    };
    const guestOrigin = source.sharedChatOriginFromTwitchTags(guestTags);
    assert.equal(guestOrigin.type, 'shared_guest');
    assert.equal(guestOrigin.persistentLearningEligible, false);
    assert.equal(guestOrigin.sourceRole, 'broadcaster');
    assert.equal(source.roleFromTwitchTags(guestTags), 'viewer');
    assert.equal(source.canonicalChatMessageId({
      twitchMessageId: guestTags.id,
      body: 'hello',
      author: { login: 'guest', displayName: 'Guest' },
      sharedChat: guestOrigin
    }), 'original-2');
  });

  await test('incomplete Shared Chat markers fail closed for persistent learning', () => {
    const unknown = source.sharedChatOriginFromTwitchTags({
      'room-id': '100',
      'source-only': '0'
    });
    assert.equal(unknown.type, 'shared_unknown');
    assert.equal(unknown.persistentLearningEligible, false);

    const unknownNotice = source.sharedChatOriginFromTwitchTags({
      'room-id': '100',
      'source-msg-id': 'subgift'
    });
    assert.equal(unknownNotice.type, 'shared_unknown');
    assert.equal(unknownNotice.persistentLearningEligible, false);

    const falseBooleanMarker = source.sharedChatOriginFromTwitchTags({
      'room-id': '100',
      sourceOnly: false
    });
    assert.equal(falseBooleanMarker.type, 'shared_unknown');
    assert.equal(falseBooleanMarker.persistentLearningEligible, false);

    const camelCaseGuest = source.sharedChatOriginFromRecord({
      sharedChat: {},
      tags: { roomId: '100', sourceRoomId: '200', sourceId: 'camel-source-1' }
    });
    assert.equal(camelCaseGuest.type, 'shared_guest');
    assert.equal(camelCaseGuest.sourceMessageId, 'camel-source-1');
    assert.equal(camelCaseGuest.persistentLearningEligible, false);

    const ordinary = source.sharedChatOriginFromTwitchTags({
      'room-id': '100',
      badges: {},
      mod: '0'
    });
    assert.equal(ordinary.type, 'local');
    assert.equal(ordinary.persistentLearningEligible, true);
  });

  await test('Shared Chat source badges never grant GeneralQwert command authority', () => {
    const custom = freshRequire('services/customCommands.js', {
      '../models/CustomCommand': {},
      '../models/CustomCommandSettings': {},
      './twitchFollowers': { getFollowInfo: async () => null, formatFollowAge: () => '', formatFollowDate: () => '' },
      './twitchChannels': { getGameInfo: async () => null }
    });

    const externalSourceStaff = {
      'room-id': '100',
      'source-room-id': '200',
      'source-id': 'source-staff',
      badges: {},
      'source-badges': 'broadcaster/1,vip/1,subscriber/12',
      mod: '1',
      subscriber: '1'
    };
    assert.equal(source.roleFromTwitchTags(externalSourceStaff), 'viewer');
    assert.equal(custom.getViewerUserLevel(externalSourceStaff), 'everyone');

    const alsoQwertMod = {
      ...externalSourceStaff,
      badges: { moderator: '1' }
    };
    assert.equal(source.roleFromTwitchTags(alsoQwertMod), 'moderator');
    assert.equal(custom.getViewerUserLevel(alsoQwertMod), 'moderator');

    const alsoQwertSubscriber = {
      ...externalSourceStaff,
      badges: { subscriber: '6' },
      mod: '0'
    };
    assert.equal(custom.getViewerUserLevel(alsoQwertSubscriber), 'subscriber');
  });

  await test('Shared Chat announcements never become GeneralQwert moderator announcements', () => {
    const guestAnnouncement = source.normalizeChatRecord({
      kind: 'moderator_announcement',
      author: { userId: 'guest-mod', login: 'guestmod', displayName: 'GuestMod', role: 'moderator' },
      body: 'Guest room announcement',
      sharedChat: {
        active: true,
        type: 'shared_guest',
        destinationRoomId: '100',
        sourceRoomId: '200',
        sourceMessageId: 'announce-source-1'
      }
    });
    assert.equal(guestAnnouncement.author.role, 'viewer');
    const marked = source.renderChatRecord(guestAnnouncement);
    assert.match(marked, /^\[SHARED CHAT GUEST ANNOUNCEMENT/);
    assert.doesNotMatch(marked, /^\[MODERATOR ANNOUNCEMENT/);
    const legacySafe = source.renderChatRecord(guestAnnouncement, { includeOriginMarker: false });
    assert.equal(legacySafe, 'GuestMod: Guest room announcement');
    assert.doesNotMatch(legacySafe, /MODERATOR ANNOUNCEMENT/);

    const reparsed = source.normalizeChatRecord(marked);
    assert.equal(reparsed.sharedChat.type, 'shared_guest');
    assert.equal(reparsed.author.role, 'viewer');
  });

  await test('persistent learning filters keep Qwert-origin chat and drop guest or unknown origins', () => {
    const records = [
      { body: 'ordinary local', author: { userId: 'l1', login: 'local', displayName: 'Local' } },
      {
        body: 'shared local',
        author: { userId: 'l2', login: 'local2', displayName: 'Local2' },
        sharedChat: { active: true, type: 'shared_local', destinationRoomId: '100', sourceRoomId: '100', sourceMessageId: 's1' }
      },
      {
        body: 'guest line',
        author: { userId: 'g1', login: 'guest', displayName: 'Guest' },
        sharedChat: { active: true, type: 'shared_guest', destinationRoomId: '100', sourceRoomId: '200', sourceMessageId: 's2' }
      },
      {
        body: 'unknown line',
        author: { userId: 'u1', login: 'unknown', displayName: 'Unknown' },
        sharedChat: { active: true, type: 'shared_unknown', destinationRoomId: '100', sourceMessageId: 's3' }
      }
    ];
    const filtered = source.filterPersistentLearningChatRecords(records);
    assert.deepEqual(filtered.map((item) => source.normalizeChatRecord(item).text), ['ordinary local', 'shared local']);
  });

  await test('viewer profile learning excludes Shared Chat guest and unknown-origin speakers', () => {
    const profiles = freshRequire('services/viewerProfiles.js', {
      '../models/ViewerProfile': {},
      '../models/ViewerProfileSettings': {}
    });
    const records = [
      { body: 'local one', author: { userId: 'l1', login: 'local', displayName: 'Local' } },
      {
        body: 'guest one',
        author: { userId: 'g1', login: 'guest', displayName: 'Guest' },
        sharedChat: { active: true, type: 'shared_guest', destinationRoomId: '100', sourceRoomId: '200', sourceMessageId: 'g1' }
      },
      {
        body: 'unknown one',
        author: { userId: 'u1', login: 'unknown', displayName: 'Unknown' },
        sharedChat: { active: true, type: 'shared_unknown', destinationRoomId: '100', sourceMessageId: 'u1' }
      }
    ];
    const index = profiles.buildParticipantCounts(records);
    assert.equal(index.participants.length, 1);
    assert.equal(index.participants[0].username, 'local');
    assert.equal(memory.parseViewerChatLine(records[1]), null);
    assert.equal(memory.parseViewerChatLine(records[2]), null);
    assert.equal(memory.parseViewerChatLine(records[0]).username, 'local');
  });

  await test('stream-lore learning does not call Gemini for guest-only Shared Chat evidence', async () => {
    let calls = 0;
    const sharedMemory = freshRequire('services/sessionMemory.js', {
      './geminiClient': {
        requestGeminiDataWithRetry: async () => {
          calls += 1;
          return { text: '{"streamLoreObservations":[]}' };
        }
      }
    });
    const result = await sharedMemory.generateStreamLoreObservations({
      chatLogs: [
        {
          body: 'guest joke one',
          author: { userId: 'g1', login: 'guest', displayName: 'Guest' },
          sharedChat: { active: true, type: 'shared_guest', destinationRoomId: '100', sourceRoomId: '200', sourceMessageId: 'g1' }
        },
        {
          body: 'guest joke two',
          author: { userId: 'g2', login: 'guest2', displayName: 'Guest2' },
          sharedChat: { active: true, type: 'shared_unknown', destinationRoomId: '100', sourceMessageId: 'g2' }
        }
      ],
      existingObservations: []
    });
    assert.deepEqual(result, []);
    assert.equal(calls, 0);
  });

  await test('Shared Chat guest lines remain available in temporary session memory context', () => {
    const context = memory.buildSessionMemoryContext({
      blocks: [],
      question: 'what happened?',
      recentChatLogs: [{
        body: 'what is Chair?',
        author: { userId: 'g1', login: 'guest', displayName: 'Guest' },
        sharedChat: { active: true, type: 'shared_guest', destinationRoomId: '100', sourceRoomId: '200', sourceMessageId: 'g1' }
      }],
      config: { enabled: true, recentChatMessages: 20 },
      streamLive: true
    });
    assert.match(context.text, /\[SHARED CHAT GUEST\]/);
    assert.match(context.text, /Guest: what is Chair\?/);
    assert.match(context.text, /temporary current-stream joint-chat context/i);
  });

  await test('public recap and Tagged Question scrubbers remove internal Shared Chat labels and raw IDs', () => {
    const recap = freshRequire('services/recapGenerator.js', {
      './recapPromptConfig': {
        getRecapPromptConfig: async () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' }),
        getDefaultRecapPromptConfig: () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' })
      }
    });
    const bot = freshRequire('services/botPersonality.js', {
      '../models/BotPersonalityConfig': {},
      './viewerProfiles': { getRelevantViewerProfiles: async () => [], formatViewerProfilesForPrompt: () => '' },
      './streamLore': { buildManualLoreContext: () => '', buildLearnedLoreText: () => '' }
    });
    const leaked = [
      'TRUSTED SHARED CHAT REQUESTER ROUTING:',
      'Requester origin classification: SHARED_CHAT_GUEST',
      '[Moriginal-id] [SHARED CHAT GUEST - OtherRoom] Guest: hello source-room-id=200 source-id=original-id sourceRoomId=200 sourceMessageId=original-id destinationRoomId=100 userId=guest-id.',
      'A remembered claim [sources: Moriginal-id, Eevent-1]. Shared Chat got chaotic.'
    ].join('\n');
    const recapClean = recap.stripInternalSharedChatProvenance(leaked);
    const botClean = bot.stripSharedChatInternalLabels(leaked);
    for (const cleaned of [recapClean, botClean]) {
      assert.doesNotMatch(cleaned, /\[SHARED CHAT GUEST/i);
      assert.doesNotMatch(cleaned, /\[Moriginal-id\]|\[sources:/i);
      assert.doesNotMatch(cleaned, /source-room-id|source-id|sourceRoomId|sourceMessageId|destinationRoomId|userId/i);
      assert.doesNotMatch(cleaned, /requester origin classification|shared chat requester routing|SHARED_CHAT_GUEST/i);
      assert.match(cleaned, /Shared Chat got chaotic/);
    }
  });

  await test('Shared Chat internal routing markers are blocked as model-output leaks', () => {
    const security = require('../services/promptSecurity');
    for (const text of [
      'SHARED CHAT REQUESTER ROUTING: internal data',
      'Requester origin classification: SHARED_CHAT_GUEST',
      'SHARED CHAT EXTERNAL/UNKNOWN PROVENANCE (temporary only)',
      'GENERALQWERT_HOME_CHAT'
    ]) {
      assert.equal(security.inspectModelOutputForLeak(text).blocked, true);
    }
    assert.equal(security.inspectModelOutputForLeak('Shared Chat got chaotic tonight.').blocked, false);
  });

  await test('Shared Chat requester context is conservative for unresolved source rooms', () => {
    const bot = freshRequire('services/botPersonality.js', {
      '../models/BotPersonalityConfig': {},
      './viewerProfiles': { getRelevantViewerProfiles: async () => [], formatViewerProfilesForPrompt: () => '' },
      './streamLore': { buildManualLoreContext: () => '', buildLearnedLoreText: () => '' }
    });
    const context = bot.formatSharedChatRequesterContext({ active: true, type: 'shared_unknown' });
    assert.match(context, /SHARED_CHAT_ORIGIN_UNKNOWN/);
    assert.match(context, /external for persistent/i);
    assert.match(context, /current-conversation context/i);
  });

  await test('native moderator checks ignore source-room staff badges but honor destination-room badges', () => {
    const handler = freshRequire('services/twitchMessageHandler.js', {
      './viewerProfiles': {
        setViewerProfileOptOut: async () => ({}),
        syncViewerIdentity: async () => ({}),
        recordViewerCommandUsage: async () => ({})
      },
      './loreDirectives': {
        parseLoreDirective: () => ({ matched: false }),
        tryHandleLoreDirective: async () => ({ matched: false }),
        consumeOwnResponse: () => false
      },
      './promptSecurity': { detectPromptInjection: () => ({ block: false }) }
    });
    const sourceModOnly = {
      'room-id': '100',
      'source-room-id': '200',
      'source-id': 's1',
      badges: {},
      'source-badges': 'moderator/1',
      mod: '1'
    };
    assert.equal(handler.isModOrBroadcaster(sourceModOnly), false);
    assert.equal(handler.isModOrBroadcaster({ ...sourceModOnly, badges: { moderator: '1' } }), true);
  });


  await test('message ingestion keeps guest chat in recap context without syncing persistent profiles', async () => {
    let syncCalls = 0;
    const recorded = [];
    const handlerModule = freshRequire('services/twitchMessageHandler.js', {
      './viewerProfiles': {
        setViewerProfileOptOut: async () => ({}),
        syncViewerIdentity: async () => { syncCalls += 1; },
        recordViewerCommandUsage: async () => ({})
      },
      './loreDirectives': {
        parseLoreDirective: () => ({ matched: false }),
        tryHandleLoreDirective: async () => ({ matched: false }),
        consumeOwnResponse: () => false
      },
      './promptSecurity': { detectPromptInjection: () => ({ block: false }) }
    });
    const recapManager = {
      getStatus: () => ({ streamLive: true }),
      recordChatMessage: (value) => { recorded.push(value); return true; }
    };
    const handler = handlerModule.createTwitchMessageHandler({
      getRecapManager: () => recapManager,
      getCustomCommandManager: () => null,
      getChatTimerManager: () => ({ recordViewerActivity: () => {} }),
      getBotPersonalityManager: () => null,
      getPersistentPinManager: () => null,
      getClipCommandManager: () => null,
      sendMessage: async () => ({}),
      botUsername: 'sqwertarmybot',
      summaryPrefix: 'Hourly Recap: '
    });

    await handler.handleMessage('#generalqwert', {
      username: 'guestviewer',
      'display-name': 'GuestViewer',
      'user-id': 'g1',
      'room-id': '100',
      'source-room-id': '200',
      'source-id': 'guest-source-1',
      id: 'guest-copy-1',
      badges: {},
      'source-badges': 'subscriber/12'
    }, 'what is Chair?');

    assert.equal(syncCalls, 0);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].sharedChat.type, 'shared_guest');
    assert.equal(recorded[0].sharedChat.sourceMessageId, 'guest-source-1');

    await handler.handleMessage('#generalqwert', {
      username: 'unknownorigin',
      'display-name': 'UnknownOrigin',
      'user-id': 'u1',
      'room-id': '100',
      'source-id': 'unknown-source-1',
      id: 'unknown-copy-1',
      badges: {}
    }, 'source room metadata was incomplete');

    assert.equal(syncCalls, 0);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[1].sharedChat.type, 'shared_unknown');

    await handler.handleMessage('#generalqwert', {
      username: 'homeviewer',
      'display-name': 'HomeViewer',
      'user-id': 'h1',
      'room-id': '100',
      'source-room-id': '100',
      'source-id': 'home-source-1',
      id: 'home-copy-1',
      badges: {}
    }, 'Chair should choose.');

    assert.equal(syncCalls, 1);
    assert.equal(recorded.length, 3);
    assert.equal(recorded[2].sharedChat.type, 'shared_local');
  });

  if (failed) {
    console.error(`\n${failed} test(s) failed; ${passed} passed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${passed} attribution regression tests passed.`);
  }
})();
