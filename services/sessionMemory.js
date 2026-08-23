const DEFAULT_SESSION_MEMORY_CONFIG = Object.freeze({
  enabled: true,
  recentDetailedHours: 2,
  maxContextCharacters: 18000,
  recentChatMessages: 30,
  relevantOlderBlocks: 2,
  promptInstructions: ''
});

const MIN_RECENT_DETAILED_HOURS = 1;
const MAX_RECENT_DETAILED_HOURS = 8;
const MIN_MAX_CONTEXT_CHARACTERS = 4000;
const MAX_MAX_CONTEXT_CHARACTERS = 40000;
const MIN_RECENT_CHAT_MESSAGES = 0;
const MAX_RECENT_CHAT_MESSAGES = 100;
const MIN_RELEVANT_OLDER_BLOCKS = 0;
const MAX_RELEVANT_OLDER_BLOCKS = 6;
const MAX_SESSION_MEMORY_PROMPT_LENGTH = 6000;
const MAX_DETAILED_SUMMARY_LENGTH = 3000;
const MAX_COMPACT_SUMMARY_LENGTH = 550;

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeSessionMemoryConfig(value = {}) {
  return {
    enabled: value?.enabled !== false,
    recentDetailedHours: clampNumber(value?.recentDetailedHours, MIN_RECENT_DETAILED_HOURS, MAX_RECENT_DETAILED_HOURS, DEFAULT_SESSION_MEMORY_CONFIG.recentDetailedHours),
    maxContextCharacters: clampNumber(value?.maxContextCharacters, MIN_MAX_CONTEXT_CHARACTERS, MAX_MAX_CONTEXT_CHARACTERS, DEFAULT_SESSION_MEMORY_CONFIG.maxContextCharacters),
    recentChatMessages: clampNumber(value?.recentChatMessages, MIN_RECENT_CHAT_MESSAGES, MAX_RECENT_CHAT_MESSAGES, DEFAULT_SESSION_MEMORY_CONFIG.recentChatMessages),
    relevantOlderBlocks: clampNumber(value?.relevantOlderBlocks, MIN_RELEVANT_OLDER_BLOCKS, MAX_RELEVANT_OLDER_BLOCKS, DEFAULT_SESSION_MEMORY_CONFIG.relevantOlderBlocks),
    promptInstructions: String(value?.promptInstructions || '').trim().slice(0, MAX_SESSION_MEMORY_PROMPT_LENGTH)
  };
}

function extractGeminiText(data) {
  let text = '';
  if (Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const item of step.content) {
        if (typeof item?.text === 'string') text += `${item.text} `;
      }
    }
  }
  if (!text && typeof data?.output_text === 'string') text = data.output_text;
  if (!text && typeof data?.outputText === 'string') text = data.outputText;
  if (!text && typeof data?.text === 'string') text = data.text;
  if (!text && Array.isArray(data?.outputs)) {
    for (const output of data.outputs) {
      if (typeof output?.text === 'string') text += `${output.text} `;
    }
  }
  return String(text || '').trim();
}

async function callGemini(prompt) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({ model: 'gemini-3.5-flash-lite', input: prompt })
  });

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`Gemini returned invalid JSON. HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `Gemini API returned HTTP ${response.status}`);
  }

  const text = extractGeminiText(data);
  if (!text) throw new Error('Gemini returned no readable session-memory text.');
  return text;
}

function cleanJsonText(text) {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function normalizeList(value, maxItems = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, maxItems);
}

function truncateText(text, maxLength) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isRoutineEventSubObservation(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!value) return false;

  const routineTelemetryPatterns = [
    /\bsubscribed(?:\s+to\s+qwert)?(?:\s+at)?\s+tier\s*[123]\b/,
    /\bresubscribed\b/,
    /\bcumulative\s+months?\b/,
    /\bgifted\s+\d*\s*(?:sub(?:scription)?s?)\b/,
    /\bcheered\s+\d*\s*bits?\b/,
    /\bfollowed\s+qwert\b/,
    /\braided\s+qwert(?:\s+with\s+\d+\s+viewers?)?\b/,
    /\bhype\s+train\s+(?:began|started|ended)\b/,
    /\bqwert\s+went\s+(?:live|offline)\b/
  ];

  return routineTelemetryPatterns.some((pattern) => pattern.test(value));
}

async function generateSessionMemoryBlock({ chatLogs = [], streamContexts = [], twitchEvents = [], streamLore = '', streamTiming = {}, publicRecap = '', config = {}, viewerLearningEnabled = false, streamLoreLearningEnabled = false }) {
  const normalizedConfig = normalizeSessionMemoryConfig(config);
  if (!normalizedConfig.enabled && !viewerLearningEnabled && !streamLoreLearningEnabled) return null;

  const sourceChat = Array.isArray(chatLogs) ? chatLogs.filter(Boolean) : [];
  const sourceEvents = Array.isArray(twitchEvents) ? twitchEvents : [];
  const contexts = Array.isArray(streamContexts) ? streamContexts : [];
  const startedAtMs = Number(streamTiming?.windowStartedAtMs || 0) || null;
  const endedAtMs = Number(streamTiming?.generatedAtMs || Date.now());
  const contextText = contexts.length
    ? contexts.map((item, index) => `Context ${index + 1}: title=${String(item?.title || 'Unknown')}; category=${String(item?.category || 'Unknown')}`).join('\n')
    : 'No title/category metadata supplied.';
  const eventText = sourceEvents.length
    ? sourceEvents.map((item) => `- ${String(item?.text || '').trim()}`).filter((line) => line !== '-').join('\n')
    : '(none)';
  const extraInstructions = normalizedConfig.promptInstructions || '(none)';

  const viewerLearningRules = viewerLearningEnabled ? `
- For viewerUpdates, include durable viewer-specific information that could genuinely help the bot recognize or understand that viewer in future streams.
- Only learn a fact from something the viewer says about themselves, or from a clearly established recurring interaction involving them. Do not treat another chatter's claim about a person as truth.
- Learn viewer profile facts from SOURCE CHAT only. Never create viewer facts from Stream Lore, title/category metadata, public recap text, or verified Twitch events.
- Routine Twitch telemetry is NEVER a viewer-profile fact: subscriptions/resubs, cumulative subscription months, follows, raids, cheers/Bits, gifted subs, Hype Trains, and stream online/offline status must not become viewer observations.
- Do not require repetition for a clearly self-stated durable preference, recurring hobby, stable community role, or established personal callback. One clear self-stated durable fact may be proposed at low or medium confidence; repeated evidence may raise confidence.
- Recurring interaction patterns may also be proposed when SOURCE CHAT shows them clearly enough to be useful later.
- Do not store sensitive/private personal data, health information, religion, politics, sexuality, legal names, contact details, precise locations, financial information, or anything that would be creepy/invasive to retain.
- Avoid one-off moods, temporary activities, throwaway opinions, sarcasm, guesses, and ephemeral facts.
- Prefer a few useful candidates over being so conservative that active chatters never accumulate any profile context.
- viewerUpdates should be empty when nothing durable is worth remembering.` : '';
  const streamLoreLearningRules = streamLoreLearningEnabled ? `
- For streamLoreObservations, suggest only CHANNEL-SPECIFIC context that may help interpret future streams: recurring jokes, nicknames, terminology, traditions, callbacks, running bits, or emerging community conventions.
- Learn stream lore from SOURCE CHAT only. Never generate lore observations from the existing Stream Lore, metadata, public recap, or verified Twitch events.
- Routine Twitch telemetry is NEVER stream lore: subscriptions/resubs, cumulative subscription months, follows, raids, cheers/Bits, gifted subs, Hype Trains, and stream online/offline status must not become lore observations.
- Do not require proof across multiple streams before proposing something. A candidate may be proposed when the current chat window contains at least two distinct supporting messages/interactions, or when chat clearly refers to something as an already-established callback, nickname, tradition, or running joke.
- Use low confidence for a plausible emerging pattern, medium for clearly repeated/established context, and high only when chat makes the convention unusually explicit and unambiguous.
- Prefer a small number of useful observations over being overly conservative. Moderator approval is required before learned lore is used, so propose genuinely useful candidates rather than waiting for near-certainty.
- Do not suggest one-off events, current gameplay outcomes, temporary plans, ordinary chatter, generic facts about games, or speculative interpretations.
- Preserve uncertainty. If the meaning is too vague to help interpret a future reference, omit it.
- streamLoreObservations should be empty when nothing durable or meaningfully reusable is worth proposing.` : '';
  const jsonFields = [
    '"detailedSummary":"..."',
    '"compactSummary":"..."',
    '"topics":["..."]',
    '"people":["..."]',
    viewerLearningEnabled ? '"viewerUpdates":[{"username":"chat username exactly as shown","displayName":"display name","observations":[{"fact":"durable concise fact","confidence":"low|medium|high"}]}]' : '',
    streamLoreLearningEnabled ? '"streamLoreObservations":[{"fact":"durable channel-specific lore observation","confidence":"low|medium|high"}]' : ''
  ].filter(Boolean);
  const jsonShape = `{${jsonFields.join(',')}}`;

  const prompt = `You are building TEMPORARY CURRENT-STREAM MEMORY for a Twitch chat bot in GeneralQwert's channel. This memory exists only until the stream ends and is used to answer viewer questions later in the same stream.

GOAL:
Preserve question-answerable details from this recap window that a viewer may reasonably ask about later. Be concise but retain useful specifics that a public 500-character recap may omit.

CURRENT STREAM METADATA (background only):
${contextText}

VERIFIED TWITCH EVENTS:
${eventText}

PUBLIC HOURLY RECAP (continuity aid only; current source below remains authoritative):
${String(publicRecap || '(none)').trim() || '(none)'}

STREAM-SPECIFIC LORE (background only; not proof of current events):
${String(streamLore || '(none)').trim() || '(none)'}

OPTIONAL MODERATOR MEMORY INSTRUCTIONS:
${extraInstructions}

SOURCE CHAT FOR THIS WINDOW:
${sourceChat.join('\n') || '(no meaningful chat messages)'}

RULES:
- Current source chat and verified Twitch events are the only evidence for events in this window.
- Metadata and stream lore may clarify references but are not evidence that something happened now.
- Preserve names of viewers involved, game/boss/item names, solutions that worked, causes explicitly established by source, decisions Qwert made, plans Qwert explicitly stated, outcomes, and notable context needed to answer later questions.
- Preserve uncertainty. Never upgrade guesses, jokes, suggestions, predictions, or questions into facts.
- Do not invent chronology or causality from message order.
- Ignore greetings, bot-command noise, emote spam, repetitive reactions, and low-value play-by-play unless needed for a later answer.
- Never reconstruct text marked [censored].
- detailedSummary must be at most ${MAX_DETAILED_SUMMARY_LENGTH} characters.
- compactSummary must be at most ${MAX_COMPACT_SUMMARY_LENGTH} characters and should act like an index of the most important facts/topics in this block.
- topics should contain short retrieval keywords/phrases.
- people should contain viewer/streamer names explicitly relevant to retained facts.${viewerLearningRules}${streamLoreLearningRules}
- Return valid JSON only, no markdown fences.

JSON SHAPE:
${jsonShape}`;

  const raw = await callGemini(prompt);
  let parsed;
  try {
    parsed = JSON.parse(cleanJsonText(raw));
  } catch (err) {
    throw new Error(`Session memory returned invalid JSON: ${err.message}`);
  }

  const detailedSummary = truncateText(parsed?.detailedSummary, MAX_DETAILED_SUMMARY_LENGTH);
  const compactSummary = truncateText(parsed?.compactSummary || detailedSummary, MAX_COMPACT_SUMMARY_LENGTH);
  if (!detailedSummary && !compactSummary) return null;

  const viewerUpdates = viewerLearningEnabled && Array.isArray(parsed?.viewerUpdates)
    ? parsed.viewerUpdates.slice(0, 40).map((update) => ({
        username: String(update?.username || '').trim(),
        displayName: String(update?.displayName || update?.username || '').trim(),
        observations: (Array.isArray(update?.observations) ? update.observations : []).slice(0, 12).map((observation) => ({
          fact: truncateText(observation?.fact || observation?.text || '', 400),
          confidence: ['low', 'medium', 'high'].includes(observation?.confidence) ? observation.confidence : 'medium'
        })).filter((observation) => observation.fact && !isRoutineEventSubObservation(observation.fact))
      })).filter((update) => update.username && update.observations.length)
    : [];

  const streamLoreObservations = streamLoreLearningEnabled && Array.isArray(parsed?.streamLoreObservations)
    ? parsed.streamLoreObservations.slice(0, 20).map((observation) => ({
        fact: truncateText(observation?.fact || observation?.text || observation?.observation || '', 400),
        confidence: ['low', 'medium', 'high'].includes(observation?.confidence) ? observation.confidence : 'medium'
      })).filter((observation) => observation.fact && !isRoutineEventSubObservation(observation.fact))
    : [];

  return {
    startedAtMs,
    endedAtMs,
    detailedSummary: detailedSummary || compactSummary,
    compactSummary: compactSummary || detailedSummary,
    topics: normalizeList(parsed?.topics),
    people: normalizeList(parsed?.people),
    viewerUpdates,
    streamLoreObservations
  };
}

function tokenize(text) {
  const stop = new Set(['the','and','for','that','this','with','what','when','where','which','who','why','how','did','does','was','were','are','is','it','to','of','in','on','at','a','an','qwert','sqwertarmybot','bot','earlier','today','tonight','stream']);
  return String(text || '').toLowerCase().match(/[a-z0-9_'-]{3,}/g)?.filter((word) => !stop.has(word)) || [];
}

function scoreBlockForQuestion(block, questionTokens) {
  if (!questionTokens.length) return 0;
  const haystack = `${block?.topics?.join(' ') || ''} ${block?.people?.join(' ') || ''} ${block?.compactSummary || ''} ${block?.detailedSummary || ''}`.toLowerCase();
  let score = 0;
  for (const token of questionTokens) {
    if (haystack.includes(token)) score += 1;
    if ((block?.topics || []).some((item) => String(item).toLowerCase().includes(token))) score += 2;
    if ((block?.people || []).some((item) => String(item).toLowerCase().includes(token))) score += 2;
  }
  return score;
}

function formatBlockTime(block) {
  const start = Number(block?.startedAtMs || 0);
  const end = Number(block?.endedAtMs || 0);
  if (!start && !end) return 'time unavailable';
  const fmt = (value) => value ? new Date(value).toISOString() : '?';
  return `${fmt(start)} to ${fmt(end)}`;
}

function buildSessionMemoryContext({ blocks = [], question = '', recentChatLogs = [], config = {}, streamLive = false }) {
  const normalizedConfig = normalizeSessionMemoryConfig(config);
  if (!normalizedConfig.enabled || !streamLive) {
    return { text: '', stats: { enabled: normalizedConfig.enabled, blockCount: Array.isArray(blocks) ? blocks.length : 0, includedDetailedBlocks: 0, compactCharacters: 0, contextCharacters: 0 } };
  }

  const validBlocks = (Array.isArray(blocks) ? blocks : []).filter((block) => block?.detailedSummary || block?.compactSummary);
  const now = Date.now();
  const recentCutoff = now - normalizedConfig.recentDetailedHours * 60 * 60 * 1000;
  const recent = validBlocks.filter((block) => Number(block?.endedAtMs || 0) >= recentCutoff);
  const older = validBlocks.filter((block) => Number(block?.endedAtMs || 0) < recentCutoff);
  const questionTokens = tokenize(question);
  const relevantOlder = older
    .map((block, index) => ({ block, index, score: scoreBlockForQuestion(block, questionTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, normalizedConfig.relevantOlderBlocks)
    .map((item) => item.block);

  const compactLines = validBlocks.map((block, index) => {
    const labels = [...(block?.topics || []), ...(block?.people || [])].slice(0, 8).join(', ');
    return `- Block ${index + 1} [${formatBlockTime(block)}]: ${String(block?.compactSummary || block?.detailedSummary || '').trim()}${labels ? ` | Index: ${labels}` : ''}`;
  });

  const selectedDetailed = [];
  const seen = new Set();
  for (const block of [...recent, ...relevantOlder]) {
    const key = `${block?.sequence || ''}:${block?.endedAtMs || ''}:${block?.detailedSummary || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectedDetailed.push(block);
  }

  const detailSections = selectedDetailed.map((block) => `DETAILED MEMORY [${formatBlockTime(block)}]:\n${String(block?.detailedSummary || '').trim()}`);
  const chatSlice = normalizedConfig.recentChatMessages > 0
    ? (Array.isArray(recentChatLogs) ? recentChatLogs.slice(-normalizedConfig.recentChatMessages) : [])
    : [];

  let text = 'CURRENT-STREAM SESSION MEMORY (temporary; clears when this Twitch stream ends):';
  if (detailSections.length) text += `\n\nSELECTED DETAILED MEMORY:\n${detailSections.join('\n\n')}`;
  if (chatSlice.length) text += `\n\nRECENT MEANINGFUL CHAT SINCE THE LAST COMPLETED MEMORY BLOCK:\n${chatSlice.join('\n')}`;
  text += `\n\nCOMPACT HISTORY INDEX (whole-stream orientation; lower priority than selected detail above):\n${compactLines.join('\n') || '(no completed memory blocks yet)'}`;

  if (text.length > normalizedConfig.maxContextCharacters) {
    text = text.slice(0, normalizedConfig.maxContextCharacters).trimEnd();
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak > Math.floor(normalizedConfig.maxContextCharacters * 0.8)) text = text.slice(0, lastBreak).trimEnd();
    text += '\n[Session memory context truncated to configured limit.]';
  }

  return {
    text,
    stats: {
      enabled: true,
      blockCount: validBlocks.length,
      includedDetailedBlocks: selectedDetailed.length,
      compactCharacters: compactLines.join('\n').length,
      contextCharacters: text.length
    }
  };
}

module.exports = {
  DEFAULT_SESSION_MEMORY_CONFIG,
  MIN_RECENT_DETAILED_HOURS,
  MAX_RECENT_DETAILED_HOURS,
  MIN_MAX_CONTEXT_CHARACTERS,
  MAX_MAX_CONTEXT_CHARACTERS,
  MIN_RECENT_CHAT_MESSAGES,
  MAX_RECENT_CHAT_MESSAGES,
  MIN_RELEVANT_OLDER_BLOCKS,
  MAX_RELEVANT_OLDER_BLOCKS,
  MAX_SESSION_MEMORY_PROMPT_LENGTH,
  normalizeSessionMemoryConfig,
  generateSessionMemoryBlock,
  buildSessionMemoryContext
};
