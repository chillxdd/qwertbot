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


  await test('Shared Chat source tags preserve guest provenance and canonical source IDs', () => {
    const tags = {
      id: 'destination-copy-1',
      username: 'guestviewer',
      'display-name': 'GuestViewer',
      'user-id': 'guest-user-1',
      'room-id': 'qwert-room',
      'source-room-id': 'partner-room',
      'source-id': 'original-source-message-1',
      badges: {},
      mod: false,
      'source-badges': { broadcaster: '1' }
    };
    const origin = source.sharedChatOriginFromTwitchTags(tags);
    assert.equal(origin.active, true);
    assert.equal(origin.isGuest, true);
    assert.equal(origin.destinationRoomId, 'qwert-room');
    assert.equal(origin.sourceRoomId, 'partner-room');
    assert.equal(origin.sourceMessageId, 'original-source-message-1');

    const record = source.normalizeChatRecord({
      twitchMessageId: tags.id,
      sourceMessageId: origin.sourceMessageId,
      sharedChat: origin,
      author: source.identityFromTwitchTags(tags, 'GuestViewer'),
      body: 'hello from the other room'
    });
    assert.equal(record.twitchMessageId, 'destination-copy-1');
    assert.equal(source.canonicalChatMessageId(record), 'original-source-message-1');
    assert.equal(source.isSharedChatGuest(record), true);
    assert.match(source.renderChatRecord(record), /^\[SHARED CHAT GUEST\]/);
    assert.equal(source.isSharedChatGuest(source.normalizeChatRecord(source.renderChatRecord(record))), true);
  });

  await test('Shared Chat home-room originals are not classified as guests', () => {
    const origin = source.sharedChatOriginFromTwitchTags({
      'room-id': 'qwert-room',
      'source-room-id': 'qwert-room',
      'source-id': 'home-original'
    });
    assert.equal(origin.active, true);
    assert.equal(origin.isGuest, false);
  });

  await test('source-room broadcaster badges never grant GeneralQwert moderator authority', () => {
    const identity = source.identityFromTwitchTags({
      username: 'otherstreamer',
      'display-name': 'OtherStreamer',
      'user-id': 'guest-broadcaster',
      'room-id': 'qwert-room',
      'source-room-id': 'partner-room',
      'source-id': 'source-broadcaster-message',
      // Be deliberately hostile/conservative here: even if the duplicated
      // copy carries role-looking values in the ordinary fields, source-room
      // authority must never become GeneralQwert-room authority.
      badges: { broadcaster: '1', moderator: '1', vip: '1', subscriber: '12' },
      mod: true,
      subscriber: true,
      'source-badges': { broadcaster: '1' }
    });
    assert.equal(identity.role, 'viewer');
  });

  await test('Shared Chat guest command levels are always treated as Everyone', () => {
    const custom = freshRequire('services/customCommands.js', {
      '../models/CustomCommand': {},
      '../models/CustomCommandSettings': {},
      './twitchFollowers': {},
      './twitchChannels': {}
    });
    const guestTags = {
      username: 'partnerstreamer',
      'user-id': 'partner-user',
      'room-id': 'qwert-room',
      'source-room-id': 'partner-room',
      'source-id': 'partner-source-message',
      badges: { broadcaster: '1', moderator: '1', vip: '1', subscriber: '24' },
      mod: true,
      subscriber: true,
      'source-badges': { broadcaster: '1' }
    };
    assert.equal(custom.getViewerUserLevel(guestTags), 'everyone');
    assert.equal(custom.meetsUserLevel(guestTags, 'subscriber'), false);
    assert.equal(custom.meetsUserLevel(guestTags, 'twitch_vip'), false);
    assert.equal(custom.meetsUserLevel(guestTags, 'moderator'), false);
    assert.equal(custom.meetsUserLevel(guestTags, 'owner'), false);

    const homeTags = {
      ...guestTags,
      'source-room-id': 'qwert-room',
      'source-id': 'qwert-home-message'
    };
    assert.equal(custom.getViewerUserLevel(homeTags), 'owner');
  });

  await test('Shared Chat guests are excluded from permanent Viewer Profile participant counts', () => {
    const profiles = freshRequire('services/viewerProfiles.js', {
      '../models/ViewerProfile': {},
      '../models/ViewerProfileSettings': {}
    });
    const guest = {
      twitchMessageId: 'guest-copy',
      sourceMessageId: 'guest-original',
      sharedChat: { active: true, isGuest: true, destinationRoomId: 'qwert', sourceRoomId: 'partner' },
      author: { userId: 'g1', login: 'guest', displayName: 'Guest' },
      body: 'guest message'
    };
    const home = {
      twitchMessageId: 'home-message',
      author: { userId: 'h1', login: 'homeviewer', displayName: 'HomeViewer' },
      body: 'home message'
    };
    const index = profiles.buildParticipantCounts([guest, home]);
    assert.equal(index.participants.length, 1);
    assert.equal(index.participants[0].identity.userId, 'h1');
  });

  await test('Shared Chat guest-only input cannot create permanent viewer or stream-lore learning', async () => {
    const guestRecords = [1, 2].map((index) => ({
      twitchMessageId: `guest-copy-${index}`,
      sourceMessageId: `guest-original-${index}`,
      sharedChat: { active: true, isGuest: true, destinationRoomId: 'qwert', sourceRoomId: 'partner' },
      author: { userId: 'g1', login: 'guest', displayName: 'Guest' },
      body: `distinct guest message ${index}`
    }));
    assert.deepEqual(await memory.generateViewerLearningUpdates({ chatLogs: guestRecords }), []);
    assert.deepEqual(await memory.generateStreamLoreObservations({ chatLogs: guestRecords }), []);
  });

  await test('temporary session memory retains explicit Shared Chat guest provenance', () => {
    const guest = {
      sharedChat: {
        active: true,
        isGuest: true,
        destinationRoomId: 'qwert-room',
        sourceRoomId: 'partner-room',
        sourceBroadcasterDisplayName: 'PartnerStreamer'
      },
      author: { userId: 'g1', login: 'guest', displayName: 'GuestViewer' },
      body: 'joint-stream message'
    };
    const guests = memory.collectSharedChatGuestIdentities([guest]);
    assert.equal(guests.length, 1);
    assert.equal(guests[0].userId, 'g1');
    assert.equal(guests[0].sourceBroadcasterDisplayName, 'PartnerStreamer');
    assert.match(memory.formatSharedChatGuestMemoryProvenance({ sharedChatGuests: guests }), /not establish GeneralQwert community membership/i);
  });

  await test('recap and attribution prompts receive Shared Chat provenance rules', () => {
    const recap = freshRequire('services/recapGenerator.js', {
      './geminiClient': { requestGeminiDataWithRetry: async () => ({ text: '' }) },
      './recapPromptConfig': {
        getRecapPromptConfig: async () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' }),
        getDefaultRecapPromptConfig: () => ({ source: 'test', primaryInstructions: '', expansionInstructions: '' })
      }
    });
    const guest = {
      sharedChat: { active: true, isGuest: true, destinationRoomId: 'qwert', sourceRoomId: 'partner', sourceBroadcasterDisplayName: 'Partner' },
      author: { userId: 'g1', login: 'guest', displayName: 'Guest' },
      body: 'hello'
    };
    assert.equal(recap.containsSharedChatGuestSource([guest]), true);
    assert.match(recap.formatSharedChatRules([guest]), /valid evidence for the current combined live conversation/i);
    assert.match(audit.formatSharedChatAuditRules([guest]), /does NOT establish that its author is a GeneralQwert regular/i);
  });

  await test('guest requester provenance is explicit and does not imply GeneralQwert membership', () => {
    const bot = freshRequire('services/botPersonality.js', {
      '../models/BotPersonalityConfig': {},
      './viewerProfiles': { getRelevantViewerProfiles: async () => [], formatViewerProfilesForPrompt: () => '' },
      './streamLore': { buildManualLoreContext: () => '', buildLearnedLoreText: () => '' }
    });
    const text = bot.formatSharedChatRequesterContext({
      active: true,
      isGuest: true,
      destinationRoomId: 'qwert',
      sourceRoomId: 'partner',
      sourceBroadcasterDisplayName: 'PartnerStreamer'
    });
    assert.match(text, /TWITCH SHARED CHAT GUEST/);
    assert.match(text, /does NOT establish.*GeneralQwert regular/i);
    assert.equal(bot.formatSharedChatRequesterContext({ active: false, isGuest: false }), '');
  });

  await test('guest Tagged Questions do not auto-load a matching GeneralQwert Viewer Profile', async () => {
    let profileCall = null;
    let modelPrompt = '';
    const bot = freshRequire('services/botPersonality.js', {
      '../models/BotPersonalityConfig': {
        findOne: () => ({ lean: async () => ({
          name: 'Oakbot',
          personality: 'Answer directly.',
          audience: 'everyone',
          cooldownSeconds: 5,
          modsBypassCooldown: true,
          sessionMemory: { enabled: false }
        }) })
      },
      './viewerProfiles': {
        getRelevantViewerProfiles: async (...args) => {
          profileCall = args;
          return [];
        },
        formatViewerProfilesForPrompt: () => ''
      },
      './geminiClient': {
        requestGeminiText: async (prompt) => {
          modelPrompt = prompt;
          return 'The shared stream is still happening.';
        },
        isRetryableGeminiError: () => false
      },
      './streamLore': { buildManualLoreContext: () => '', buildLearnedLoreText: () => '' },
      './attributionAudit': {
        auditGeneratedAttribution: async ({ text }) => ({ text, changed: false, unsupported: [] })
      }
    });
    const manager = bot.createBotPersonalityManager({
      channelName: 'generalqwert',
      botUsername: 'sqwertarmybot',
      sendMessage: async () => ({ method: 'test' }),
      getStreamContext: () => ({ statusKnown: true, streamLive: true, title: 'Joint stream', category: 'Pokemon' }),
      getCurrentChatRecords: () => [],
      getCurrentEventRecords: () => []
    });
    await manager.initialize();
    const tags = {
      id: 'copy-1',
      username: 'guestviewer',
      'display-name': 'GuestViewer',
      'user-id': 'g1',
      'room-id': 'qwert-room',
      'source-room-id': 'partner-room',
      'source-id': 'original-1',
      badges: {},
      mod: false
    };
    const origin = source.sharedChatOriginFromTwitchTags(tags);
    const result = await manager.handleTaggedQuestion({
      rawMessage: '@SqwertArmyBot what is happening?',
      displayName: 'GuestViewer',
      tags,
      replyParentMessageId: 'copy-1',
      sharedChatOrigin: origin
    });
    assert.equal(result.responded, true);
    assert.ok(profileCall);
    assert.equal(profileCall[3].requesterIdentity, null);
    assert.equal(profileCall[3].recipientIdentity, null);
    assert.equal(profileCall[3].excludeIdentities[0].userId, 'g1');
    assert.match(modelPrompt, /Requester origin: TWITCH SHARED CHAT GUEST/);
    assert.match(modelPrompt, /Do not auto-bind a GeneralQwert Viewer Profile/i);
  });

  await test('Shared Chat source-room roles cannot unlock mod-only Tagged Questions', async () => {
    let modelCalls = 0;
    const bot = freshRequire('services/botPersonality.js', {
      '../models/BotPersonalityConfig': {
        findOne: () => ({ lean: async () => ({
          name: 'Oakbot',
          personality: 'Answer directly.',
          audience: 'mods',
          cooldownSeconds: 5,
          modsBypassCooldown: true,
          sessionMemory: { enabled: false }
        }) })
      },
      './viewerProfiles': {
        getRelevantViewerProfiles: async () => [],
        formatViewerProfilesForPrompt: () => ''
      },
      './geminiClient': {
        requestGeminiText: async () => { modelCalls += 1; return 'should not run'; },
        isRetryableGeminiError: () => false
      },
      './streamLore': { buildManualLoreContext: () => '', buildLearnedLoreText: () => '' },
      './attributionAudit': {
        auditGeneratedAttribution: async ({ text }) => ({ text, changed: false, unsupported: [] })
      }
    });
    const manager = bot.createBotPersonalityManager({
      channelName: 'generalqwert',
      botUsername: 'sqwertarmybot',
      sendMessage: async () => ({ method: 'test' }),
      getStreamContext: () => ({ statusKnown: true, streamLive: true }),
      getCurrentChatRecords: () => [],
      getCurrentEventRecords: () => []
    });
    await manager.initialize();
    const result = await manager.handleTaggedQuestion({
      rawMessage: '@SqwertArmyBot can source-room staff use this?',
      displayName: 'PartnerStreamer',
      tags: {
        id: 'copy-mod-question',
        username: 'partnerstreamer',
        'display-name': 'PartnerStreamer',
        'user-id': 'partner-user',
        'room-id': 'qwert-room',
        'source-room-id': 'partner-room',
        'source-id': 'source-mod-question',
        badges: { broadcaster: '1', moderator: '1' },
        mod: true,
        'source-badges': { broadcaster: '1' }
      }
    });
    assert.equal(result.matched, true);
    assert.equal(result.responded, false);
    assert.equal(result.reason, 'audience');
    assert.equal(modelCalls, 0);
  });

  await test('guest messages are recorded for recap but cannot inherit source-room command authority or habits', async () => {
    let syncCalls = 0;
    let commandUsageCalls = 0;
    let stopRecapCalls = 0;
    const recorded = [];
    const handlerModule = freshRequire('services/twitchMessageHandler.js', {
      './viewerProfiles': {
        setViewerProfileOptOut: async () => ({}),
        syncViewerIdentity: async () => { syncCalls += 1; },
        recordViewerCommandUsage: async () => { commandUsageCalls += 1; }
      },
      './loreDirectives': {
        parseLoreDirective: () => ({ matched: false }),
        tryHandleLoreDirective: async () => ({ matched: false }),
        consumeOwnResponse: () => false
      }
    });
    const recapManager = {
      getStatus: () => ({ streamLive: true }),
      recordChatMessage: (record) => { recorded.push(record); return true; },
      stopRecap: async () => { stopRecapCalls += 1; },
      handleRecapCommand: async () => {}
    };
    const handler = handlerModule.createTwitchMessageHandler({
      getRecapManager: () => recapManager,
      getCustomCommandManager: () => null,
      getChatTimerManager: () => null,
      getBotPersonalityManager: () => null,
      sendMessage: async () => {},
      botUsername: 'sqwertarmybot',
      summaryPrefix: 'Hourly Recap: '
    });
    const tags = {
      id: 'copy-1',
      username: 'partnerstreamer',
      'display-name': 'PartnerStreamer',
      'user-id': 'p1',
      'room-id': 'qwert-room',
      'source-room-id': 'partner-room',
      'source-id': 'original-1',
      badges: { broadcaster: '1', moderator: '1', vip: '1', subscriber: '18' },
      mod: true,
      subscriber: true,
      'source-badges': { broadcaster: '1' }
    };
    await handler.handleMessage('#generalqwert', tags, 'hello from shared chat');
    assert.equal(syncCalls, 0);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].sharedChat.isGuest, true);
    assert.equal(recorded[0].sourceMessageId, 'original-1');

    await handler.handleMessage('#generalqwert', { ...tags, id: 'copy-2', 'source-id': 'original-2' }, '!recap');
    assert.equal(commandUsageCalls, 0);

    await handler.handleMessage('#generalqwert', { ...tags, id: 'copy-3', 'source-id': 'original-3' }, '!stoprecap');
    assert.equal(stopRecapCalls, 0);
  });

  await test('Shared Chat source-room authority cannot write GeneralQwert Stream Lore', async () => {
    const loreDirectives = freshRequire('services/loreDirectives.js', {
      './streamLore': {
        getStreamLore: async () => { throw new Error('guest directive must be rejected before storage lookup'); },
        applyStreamLoreObservations: async () => { throw new Error('guest directive must never be applied'); },
        normalizeLoreDirectiveConfig: (value) => value,
        DEFAULT_LORE_DIRECTIVE_CONFIG: { enabled: true }
      }
    });
    const result = await loreDirectives.tryHandleLoreDirective({
      channel: '#generalqwert',
      rawMessage: '@SqwertArmyBot add "partner lore" to the lore.',
      displayName: 'PartnerStreamer',
      tags: {
        username: 'partnerstreamer',
        'display-name': 'PartnerStreamer',
        'user-id': 'partner-user',
        'room-id': 'qwert-room',
        'source-room-id': 'partner-room',
        'source-id': 'source-lore-directive',
        badges: { broadcaster: '1', moderator: '1' },
        mod: true,
        'source-badges': { broadcaster: '1' }
      },
      botUsername: 'sqwertarmybot',
      recapManager: null,
      sendMessage: async () => {}
    });
    assert.equal(result.matched, false);
  });

  await test('Shared Chat announcements never create an unscoped GeneralQwert moderator role', () => {
    const record = source.normalizeChatRecord({
      kind: 'moderator_announcement',
      author: { userId: 'partner-mod', login: 'partnermod', displayName: 'PartnerMod', role: 'viewer' },
      body: 'Source-room announcement',
      sharedChat: {
        active: true,
        isGuest: true,
        destinationRoomId: 'qwert-room',
        sourceRoomId: 'partner-room'
      }
    });
    assert.equal(record.author.role, 'viewer');
    const rendered = source.renderChatRecord(record);
    assert.match(rendered, /^\[SHARED CHAT GUEST\]/);
    assert.match(rendered, /\[MODERATOR ANNOUNCEMENT by PartnerMod\]/);
    assert.equal(source.normalizeChatRecord(rendered).author.role, 'viewer');
  });

  await test('Shared Chat guest aliases are excluded from local subject lore matching', () => {
    const lore = freshRequire('services/streamLore.js', {
      '../models/StreamLore': {}
    });
    const manual = lore.buildManualLoreContext([
      { scope: 'global', subject: 'Global', text: 'The chair is a recurring character.', enabled: true },
      { scope: 'subject', subject: 'GuestViewer', aliases: ['guestviewer'], text: 'Local profile-like lore that must not bind to the guest.', enabled: true },
      { scope: 'subject', subject: 'Motmo_', aliases: ['motmo_'], text: 'Motmo_ created SqwertArmyBot.', enabled: true }
    ], 'GuestViewer asked Motmo_ a question.', {
      includeGlobal: true,
      excludeSubjectAliases: ['GuestViewer', 'guestviewer']
    });
    assert.match(manual, /chair is a recurring character/i);
    assert.match(manual, /Motmo_ created SqwertArmyBot/i);
    assert.doesNotMatch(manual, /must not bind to the guest/i);
  });

  await test('Shared Chat guest identity exclusions beat stale local profile aliases', async () => {
    const docs = [
      {
        _id: 'guest-profile',
        channelName: 'generalqwert',
        twitchUserId: 'old-unrelated-user-id',
        username: 'guestviewer',
        displayName: 'GuestViewer',
        aliases: ['FormerGuestName'],
        enabled: true,
        optedOut: false,
        facts: [],
        commandUsage: []
      },
      {
        _id: 'local-profile',
        channelName: 'generalqwert',
        twitchUserId: 'local-user-id',
        username: 'motmo_',
        displayName: 'Motmo_',
        aliases: [],
        enabled: true,
        optedOut: false,
        facts: [],
        commandUsage: []
      }
    ];
    const profiles = freshRequire('services/viewerProfiles.js', {
      '../models/ViewerProfile': {
        updateMany: async () => ({ modifiedCount: 0 }),
        find: () => ({ lean: async () => docs })
      },
      '../models/ViewerProfileSettings': {
        findOne: () => ({ lean: async () => ({ useInTaggedQuestions: true }) })
      }
    });
    const result = await profiles.getRelevantViewerProfiles(
      'generalqwert',
      'Tell me about GuestViewer and Motmo_.',
      4,
      {
        excludeIdentities: [{
          userId: 'current-guest-user-id',
          login: 'guestviewer',
          displayName: 'GuestViewer'
        }]
      }
    );
    assert.deepEqual(result.map((profile) => profile.username), ['motmo_']);
  });


  await test('Shared Chat source badge metadata is preserved but never used as local authority', () => {
    const origin = source.sharedChatOriginFromTwitchTags({
      'room-id': 'qwert-room',
      'source-room-id': 'partner-room',
      'source-id': 'source-badges-message',
      'source-badges': { broadcaster: '1', moderator: '1' },
      badges: {},
      mod: false
    });
    assert.deepEqual(origin.sourceBadges, { broadcaster: '1', moderator: '1' });
    const identity = source.identityFromTwitchTags({
      username: 'partnerstreamer',
      'display-name': 'PartnerStreamer',
      'user-id': 'partner-user',
      'room-id': 'qwert-room',
      'source-room-id': 'partner-room',
      'source-id': 'source-badges-message',
      'source-badges': { broadcaster: '1', moderator: '1' },
      badges: {},
      mod: false
    });
    assert.equal(identity.role, 'viewer');
  });

  await test('Tagged Questions exclude every currently observed Shared Chat guest from persistent profile binding', async () => {
    let profileCall = null;
    const bot = freshRequire('services/botPersonality.js', {
      '../models/BotPersonalityConfig': {
        findOne: () => ({ lean: async () => ({
          name: 'Oakbot',
          personality: 'Answer directly.',
          audience: 'everyone',
          cooldownSeconds: 5,
          modsBypassCooldown: true,
          sessionMemory: { enabled: false }
        }) })
      },
      './viewerProfiles': {
        getRelevantViewerProfiles: async (...args) => {
          profileCall = args;
          return [];
        },
        formatViewerProfilesForPrompt: () => ''
      },
      './geminiClient': {
        requestGeminiText: async () => 'No persistent guest profile was used.',
        isRetryableGeminiError: () => false
      },
      './streamLore': { buildManualLoreContext: () => '', buildLearnedLoreText: () => '' },
      './attributionAudit': {
        auditGeneratedAttribution: async ({ text }) => ({ text, changed: false, unsupported: [] })
      }
    });
    const otherGuest = {
      twitchMessageId: 'copy-other',
      sourceMessageId: 'source-other',
      sharedChat: {
        active: true,
        isGuest: true,
        destinationRoomId: 'qwert-room',
        sourceRoomId: 'partner-room'
      },
      author: { userId: 'g2', login: 'otherguest', displayName: 'OtherGuest' },
      body: 'hello from partner chat'
    };
    const manager = bot.createBotPersonalityManager({
      channelName: 'generalqwert',
      botUsername: 'sqwertarmybot',
      sendMessage: async () => ({ method: 'test' }),
      getStreamContext: () => ({ statusKnown: true, streamLive: true }),
      getCurrentChatRecords: () => [otherGuest],
      getCurrentEventRecords: () => []
    });
    await manager.initialize();
    await manager.handleTaggedQuestion({
      rawMessage: '@SqwertArmyBot who is OtherGuest?',
      displayName: 'GuestAsker',
      tags: {
        id: 'copy-asker',
        username: 'guestasker',
        'display-name': 'GuestAsker',
        'user-id': 'g1',
        'room-id': 'qwert-room',
        'source-room-id': 'partner-room',
        'source-id': 'source-asker',
        badges: {},
        mod: false
      }
    });
    assert.ok(profileCall);
    const excludedIds = new Set(profileCall[3].excludeIdentities.map((identity) => identity.userId));
    assert.deepEqual(excludedIds, new Set(['g1', 'g2']));
  });

  if (failed) {
    console.error(`\n${failed} test(s) failed; ${passed} passed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${passed} attribution regression tests passed.`);
  }
})();
