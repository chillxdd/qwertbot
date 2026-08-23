const BotPersonalityConfig = require('../models/BotPersonalityConfig');
const { normalizeSessionMemoryConfig } = require('./sessionMemory');
const { getRelevantViewerProfiles, formatViewerProfilesForPrompt } = require('./viewerProfiles');

const MAX_BOT_PERSONALITY_NAME_LENGTH = 80;
const MAX_BOT_PERSONALITY_LENGTH = 12000;
const TWITCH_MESSAGE_LIMIT = 500;
const MIN_BOT_PERSONALITY_COOLDOWN_SECONDS = 5;
const MAX_BOT_PERSONALITY_COOLDOWN_SECONDS = 86400;
const MAX_BOT_PERSONALITY_COOLDOWN_RESPONSE_LENGTH = 500;
const MAX_TAGGED_QUESTION_RETRIES = 2;
const TAGGED_QUESTION_RETRY_WINDOW_MS = 15000;
const TAGGED_QUESTION_FAILURE_GUARD_MS = 20000;
const MAX_TAGGED_QUESTION_FAILURE_RESPONSE_LENGTH = 500;
const DEFAULT_TAGGED_QUESTION_FAILURE_RESPONSE = 'Sorry $user, my AI brain is overloaded right now. Try asking me again in a moment.';


function formatCooldownRemaining(totalSeconds) {
  let seconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function renderCooldownResponse(template, displayName, remainingSeconds) {
  const user = String(displayName || 'viewer').replace(/^@+/, '').trim() || 'viewer';
  const remaining = formatCooldownRemaining(remainingSeconds);
  return String(template || '')
    .replace(/\$\(user\)|\$user\b/gi, user)
    .replace(/\$\((?:time|remaining)\)|\$(?:time|remaining)\b/gi, remaining)
    .trim();
}

function normalizeChannelName(channelName) {
  return String(channelName || '').toLowerCase().trim();
}

function normalizeAudience(audience) {
  return String(audience || '').toLowerCase() === 'everyone' ? 'everyone' : 'mods';
}

function normalizeAiRetryConfig(value = {}) {
  const maxRetries = Number(value?.maxRetries ?? MAX_TAGGED_QUESTION_RETRIES);
  return {
    enabled: value?.enabled !== false,
    maxRetries: Number.isFinite(maxRetries) ? Math.max(0, Math.min(MAX_TAGGED_QUESTION_RETRIES, Math.round(maxRetries))) : MAX_TAGGED_QUESTION_RETRIES,
    failureResponse: String(value?.failureResponse ?? DEFAULT_TAGGED_QUESTION_FAILURE_RESPONSE).trim().slice(0, MAX_TAGGED_QUESTION_FAILURE_RESPONSE_LENGTH)
  };
}

function renderFailureResponse(template, displayName) {
  const user = String(displayName || 'viewer').replace(/^@+/, '').trim() || 'viewer';
  return String(template || '')
    .replace(/\$\(user\)|\$user\b/gi, user)
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(err) {
  if (err?.retryable === true) return true;
  const status = Number(err?.status || 0);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  const message = String(err?.message || '').toLowerCase();
  return /high demand|temporar|rate limit|too many requests|timeout|timed out|service unavailable|network|fetch failed|connection reset|econnreset|eai_again/.test(message);
}

function isModOrBroadcaster(tags = {}) {
  const badges = tags.badges || {};
  return badges.broadcaster === '1' || tags.mod === true || tags.mod === '1' || badges.moderator === '1';
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
  if (!text && Array.isArray(data?.outputs)) {
    for (const output of data.outputs) {
      if (typeof output?.text === 'string') text += `${output.text} `;
    }
  }
  return String(text || '').trim();
}

async function callGemini(prompt, timeoutMs = 8000) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 8000));
  let response;
  try {
    response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        model: 'gemini-3.5-flash-lite',
        input: prompt
      }),
      signal: controller.signal
    });
  } catch (err) {
    const wrapped = new Error(controller.signal.aborted ? 'Gemini request timed out.' : (err?.message || 'Gemini request failed.'));
    wrapped.retryable = true;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    const err = new Error(`Gemini returned invalid JSON. HTTP ${response.status}`);
    err.status = response.status;
    err.retryable = response.status >= 500;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || data?.message || `Gemini API returned HTTP ${response.status}`);
    err.status = response.status;
    err.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
    throw err;
  }

  const text = extractGeminiText(data);
  if (!text) {
    const err = new Error('Gemini returned no readable text.');
    err.retryable = true;
    throw err;
  }
  return text;
}

async function callGeminiWithRetries(prompt, retryConfig, onRetry) {
  const retry = normalizeAiRetryConfig(retryConfig);
  const deadline = Date.now() + TAGGED_QUESTION_RETRY_WINDOW_MS;
  const maxAttempts = 1 + (retry.enabled ? retry.maxRetries : 0);
  const retryDelaysMs = [4000, 5000];
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)];
      if (Date.now() + delayMs >= deadline) break;
      if (typeof onRetry === 'function') onRetry({ attempt, maxRetries: maxAttempts - 1, delayMs, error: lastError });
      await sleep(delayMs);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1000) break;
    try {
      return await callGemini(prompt, Math.min(8000, remainingMs));
    } catch (err) {
      lastError = err;
      if (!retry.enabled || !isRetryableGeminiError(err)) break;
    }
  }

  throw lastError || new Error('Gemini retry window expired before another attempt could run.');
}




function toUnicodeBoldSans(text) {
  return Array.from(String(text || '')).map((ch) => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
    return ch;
  }).join('');
}

function clipTwitchMessage(text, prefix = '') {
  const full = `${prefix}${String(text || '').trim()}`.trim();
  return Array.from(full).slice(0, TWITCH_MESSAGE_LIMIT).join('').trim();
}

function createBotPersonalityManager({ channelName, botUsername, sendMessage, getStreamLore, getStreamContext, getSessionMemoryContext }) {
  const normalizedChannel = normalizeChannelName(channelName);
  const normalizedBotUsername = String(botUsername || '').toLowerCase().trim();
  let config = { name: '', personality: '', audience: 'mods', cooldownSeconds: MIN_BOT_PERSONALITY_COOLDOWN_SECONDS, modsBypassCooldown: true, cooldownResponse: '', aiRetry: normalizeAiRetryConfig(), sessionMemory: normalizeSessionMemoryConfig(), updatedAt: null };
  let lastPublicResponseAt = 0;
  const ownResponses = [];
  const failureGuards = new Map();
  const OWN_RESPONSE_TTL_MS = 15000;

  function cleanupOwnResponses() {
    const cutoff = Date.now() - OWN_RESPONSE_TTL_MS;
    while (ownResponses.length && ownResponses[0].createdAt < cutoff) ownResponses.shift();
  }

  function noteOwnResponse(message) {
    cleanupOwnResponses();
    ownResponses.push({ message: String(message || '').trim(), createdAt: Date.now() });
  }

  function consumeOwnResponse(message) {
    cleanupOwnResponses();
    const normalized = String(message || '').trim();
    const index = ownResponses.findIndex((entry) => entry.message === normalized);
    if (index === -1) return false;
    ownResponses.splice(index, 1);
    return true;
  }

  async function loadConfig() {
    const doc = await BotPersonalityConfig.findOne({ channelName: normalizedChannel }).lean();
    config = {
      name: String(doc?.name || ''),
      personality: String(doc?.personality || ''),
      audience: normalizeAudience(doc?.audience),
      cooldownSeconds: Math.max(MIN_BOT_PERSONALITY_COOLDOWN_SECONDS, Math.min(MAX_BOT_PERSONALITY_COOLDOWN_SECONDS, Number(doc?.cooldownSeconds || MIN_BOT_PERSONALITY_COOLDOWN_SECONDS))),
      modsBypassCooldown: doc?.modsBypassCooldown !== false,
      cooldownResponse: String(doc?.cooldownResponse || ''),
      aiRetry: normalizeAiRetryConfig(doc?.aiRetry || {}),
      sessionMemory: normalizeSessionMemoryConfig(doc?.sessionMemory || {}),
      updatedAt: doc?.updatedAt || null
    };
    return { ...config };
  }

  async function initialize() {
    await loadConfig();
    console.log(`[Tagged Questions] Loaded personality settings (name=${config.name || 'none'}, personality=${config.personality.length} characters, audience=${config.audience}, cooldown=${config.cooldownSeconds}s, modsBypass=${config.modsBypassCooldown}).`);
  }

  async function saveConfig({ name, personality, audience, cooldownSeconds, modsBypassCooldown, cooldownResponse, aiRetry, sessionMemory }) {
    const normalizedName = String(name || '').replace(/\s+/g, ' ').trim();
    if (normalizedName.length > MAX_BOT_PERSONALITY_NAME_LENGTH) {
      throw new Error(`Tagged-question name cannot exceed ${MAX_BOT_PERSONALITY_NAME_LENGTH} characters.`);
    }

    const normalizedPersonality = String(personality || '').trim();
    if (normalizedPersonality.length > MAX_BOT_PERSONALITY_LENGTH) {
      throw new Error(`Bot personality cannot exceed ${MAX_BOT_PERSONALITY_LENGTH} characters.`);
    }

    const normalizedAudience = normalizeAudience(audience);
    const normalizedCooldown = Number(cooldownSeconds ?? MIN_BOT_PERSONALITY_COOLDOWN_SECONDS);
    if (!Number.isFinite(normalizedCooldown) || normalizedCooldown < MIN_BOT_PERSONALITY_COOLDOWN_SECONDS || normalizedCooldown > MAX_BOT_PERSONALITY_COOLDOWN_SECONDS) {
      throw new Error(`AI question cooldown must be between ${MIN_BOT_PERSONALITY_COOLDOWN_SECONDS} and ${MAX_BOT_PERSONALITY_COOLDOWN_SECONDS} seconds.`);
    }
    const roundedCooldown = Math.round(normalizedCooldown * 1000) / 1000;
    const normalizedBypass = Boolean(modsBypassCooldown);
    const normalizedCooldownResponse = String(cooldownResponse || '').trim();
    if (normalizedCooldownResponse.length > MAX_BOT_PERSONALITY_COOLDOWN_RESPONSE_LENGTH) {
      throw new Error(`Tagged-question cooldown response cannot exceed ${MAX_BOT_PERSONALITY_COOLDOWN_RESPONSE_LENGTH} characters.`);
    }
    const normalizedAiRetry = normalizeAiRetryConfig(aiRetry || config.aiRetry || {});
    if (String(aiRetry?.failureResponse ?? normalizedAiRetry.failureResponse).trim().length > MAX_TAGGED_QUESTION_FAILURE_RESPONSE_LENGTH) {
      throw new Error(`Tagged-question AI failure response cannot exceed ${MAX_TAGGED_QUESTION_FAILURE_RESPONSE_LENGTH} characters.`);
    }
    const normalizedSessionMemory = normalizeSessionMemoryConfig(sessionMemory || config.sessionMemory || {});
    const doc = await BotPersonalityConfig.findOneAndUpdate(
      { channelName: normalizedChannel },
      { $set: { name: normalizedName, personality: normalizedPersonality, audience: normalizedAudience, cooldownSeconds: roundedCooldown, modsBypassCooldown: normalizedBypass, cooldownResponse: normalizedCooldownResponse, aiRetry: normalizedAiRetry, sessionMemory: normalizedSessionMemory } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    config = {
      name: String(doc?.name || ''),
      personality: String(doc?.personality || ''),
      audience: normalizeAudience(doc?.audience),
      cooldownSeconds: Math.max(MIN_BOT_PERSONALITY_COOLDOWN_SECONDS, Math.min(MAX_BOT_PERSONALITY_COOLDOWN_SECONDS, Number(doc?.cooldownSeconds || MIN_BOT_PERSONALITY_COOLDOWN_SECONDS))),
      modsBypassCooldown: doc?.modsBypassCooldown !== false,
      cooldownResponse: String(doc?.cooldownResponse || ''),
      aiRetry: normalizeAiRetryConfig(doc?.aiRetry || {}),
      sessionMemory: normalizeSessionMemoryConfig(doc?.sessionMemory || {}),
      updatedAt: doc?.updatedAt || null
    };
    return { ...config };
  }

  function parseTaggedQuestion(rawMessage) {
    const raw = String(rawMessage || '').trim();
    if (!raw || !raw.endsWith('?') || !normalizedBotUsername) return null;

    const lower = raw.toLowerCase();
    const mention = `@${normalizedBotUsername}`;
    if (!lower.startsWith(mention)) return null;

    const boundary = raw.charAt(mention.length);
    if (boundary && !/[\s,:-]/.test(boundary)) return null;

    const question = raw.slice(mention.length).replace(/^[\s,:-]+/, '').trim();
    if (!question || question === '?') return null;
    return question;
  }

  async function handleTaggedQuestion({ rawMessage, displayName, tags = {}, replyParentMessageId = '' }) {
    const question = parseTaggedQuestion(rawMessage);
    if (!question) return { matched: false };

    const replyTarget = String(replyParentMessageId || '').trim();
    const sendTaggedResponse = (text) => sendMessage(
      normalizedChannel,
      text,
      replyTarget ? { replyParentMessageId: replyTarget } : {}
    );

    if (!config.personality) {
      return { matched: true, responded: false, reason: 'personality_empty' };
    }

    const viewerIsMod = isModOrBroadcaster(tags);
    if (config.audience === 'mods' && !viewerIsMod) {
      return { matched: true, responded: false, reason: 'audience' };
    }

    const bypassCooldown = viewerIsMod && config.modsBypassCooldown;
    const cooldownMs = Math.max(0, Number(config.cooldownSeconds || 0) * 1000);
    if (!bypassCooldown && cooldownMs > 0 && Date.now() - lastPublicResponseAt < cooldownMs) {
      const remainingMs = Math.max(0, cooldownMs - (Date.now() - lastPublicResponseAt));
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      const cooldownTemplate = String(config.cooldownResponse || '').trim();
      if (!cooldownTemplate) {
        return { matched: true, responded: false, reason: 'cooldown', remainingSeconds };
      }

      const renderedCooldown = clipTwitchMessage(renderCooldownResponse(cooldownTemplate, displayName, remainingSeconds));
      if (!renderedCooldown) {
        return { matched: true, responded: false, reason: 'cooldown', remainingSeconds };
      }

      noteOwnResponse(renderedCooldown);
      const result = await sendTaggedResponse(renderedCooldown);
      return {
        matched: true,
        responded: true,
        reason: 'cooldown',
        cooldownResponse: true,
        remainingSeconds,
        message: renderedCooldown,
        sendMethod: result?.method || 'unknown'
      };
    }

    const failureGuardKey = String(tags?.['user-id'] || displayName || 'viewer').toLowerCase().trim();
    const failureGuardUntil = Number(failureGuards.get(failureGuardKey) || 0);
    if (failureGuardUntil > Date.now()) {
      return { matched: true, responded: false, reason: 'failure_guard', remainingSeconds: Math.ceil((failureGuardUntil - Date.now()) / 1000) };
    }
    if (failureGuardUntil) failureGuards.delete(failureGuardKey);

    let streamLore = '';
    if (typeof getStreamLore === 'function') {
      try {
        const loreRecord = await getStreamLore(normalizedChannel);
        streamLore = String(loreRecord?.effectiveText || loreRecord?.text || '').trim();
      } catch (err) {
        console.error('[Tagged Questions] Could not load stream lore for tagged question:', err?.message || err);
      }
    }

    let streamContext = { statusKnown: false, streamLive: false, title: '', category: '' };
    if (typeof getStreamContext === 'function') {
      try {
        const context = getStreamContext() || {};
        streamContext = {
          statusKnown: context.statusKnown !== false,
          streamLive: Boolean(context.streamLive),
          title: String(context.title || context.currentStreamTitle || '').trim(),
          category: String(context.category || context.currentStreamCategory || '').trim()
        };
      } catch (err) {
        console.error('[Tagged Questions] Could not load current Twitch stream context for tagged question:', err?.message || err);
      }
    }

    let sessionMemoryContext = '';
    if (config.sessionMemory?.enabled && typeof getSessionMemoryContext === 'function') {
      try {
        const memory = await getSessionMemoryContext(question);
        sessionMemoryContext = String(memory?.text || memory || '').trim();
      } catch (err) {
        console.error('[Tagged Questions] Could not load current-stream session memory:', err?.message || err);
      }
    }

    let viewerProfileContext = '';
    try {
      const relevantProfiles = await getRelevantViewerProfiles(normalizedChannel, question, 4);
      viewerProfileContext = formatViewerProfilesForPrompt(relevantProfiles);
    } catch (err) {
      console.error('[Tagged Questions] Could not load relevant viewer profiles:', err?.message || err);
    }

    const currentStreamContext = !streamContext.statusKnown
      ? `CURRENT TWITCH STREAM CONTEXT:
- Live status: UNKNOWN (stream-status polling has not initialized yet).
- Do not assume Qwert is live or describe anything as happening right now.`
      : streamContext.streamLive
        ? `CURRENT TWITCH STREAM CONTEXT:
- Live status: LIVE
- Title: ${streamContext.title || 'Unknown'}
- Category/game: ${streamContext.category || 'Unknown'}`
        : `CURRENT TWITCH STREAM CONTEXT:
- Live status: OFFLINE
- Qwert is not currently live on Twitch.`;

    const prompt = `You are ${botUsername || 'the configured Twitch bot'}, a Twitch chat bot answering one viewer question in GeneralQwert's chat.

BOT PERSONALITY (saved by the broadcaster/mods):
${config.personality}

${currentStreamContext}

STREAM-SPECIFIC LORE (saved or approved by the broadcaster/mods; background context only):
${streamLore || '(none saved)'}

CURRENT-STREAM SESSION MEMORY (temporary same-stream evidence; may include completed hourly memory blocks and recent meaningful chat):
${sessionMemoryContext || '(no session memory available)'}

RELEVANT VIEWER PROFILES (persistent community context; only profiles referenced by this question are included):
${viewerProfileContext || '(no relevant viewer profiles)'}

VIEWER: ${String(displayName || 'viewer')}
QUESTION: ${question}

RULES:
- Answer the question directly while following the supplied personality.
- Use the current Twitch title and category/game as the strongest background context for interpreting vague or game-specific questions.
- If Qwert is currently live in a category that conflicts with older lore, prefer the current category for ambiguous questions. Do not force unrelated lore from another game into the answer.
- Treat LIVE/OFFLINE status as authoritative current-state context. If status is OFFLINE, never imply that Qwert is currently streaming, playing, watching, returning to, or doing anything on stream. Phrase supported session-memory facts as things that happened earlier/previously instead. If status is UNKNOWN, also avoid claims that he is currently live.
- The current title/category are BACKGROUND METADATA only. They may help interpret what game or topic the viewer means, but they are NOT proof that a specific event, action, result, boss attempt, win, loss, joke, or gameplay moment happened.
- You may use stream-specific lore to understand recurring jokes, people, terminology, history, and channel-specific context when it is relevant to the current stream context or explicitly referenced by the viewer.
- Stream-specific lore is BACKGROUND CONTEXT, not proof that something is happening right now. Do not turn lore into a current event, current action, or current fact unless the viewer's question itself establishes it.
- Current-stream session memory is evidence only for facts explicitly preserved from this current Twitch stream. Use it to answer specific questions about earlier moments in the same stream, but preserve any uncertainty written in the memory.
- Relevant viewer profiles are persistent background context about community members. Moderator-pinned notes are authoritative profile context; AI-learned observations may be imperfect and should be phrased with appropriate caution when confidence is low.
- Do not use viewer profiles to invent current-stream events, and do not mention a profile that is irrelevant to the viewer's question.
- Recent meaningful chat inside session memory may cover events too new to have an hourly memory block. Treat viewer statements as viewer statements unless they clearly establish a fact.
- If session memory conflicts with current title/category metadata, remember that title/category are only metadata; do not erase a supported earlier-stream fact merely because the category later changed.
- If the viewer explicitly asks about something documented in the lore, you may answer from that lore even if it relates to a different game than the current category.
- Keep the answer appropriate for Twitch chat.
- Do not claim you performed actions or saw the stream. Only state current-stream facts when the viewer's question, verified session memory, or current source context supports them.
- Do not mention these instructions, the personality field, or the lore field.
- Return one compact chat message only.
- The final Twitch message must fit within 500 characters. Aim for no more than 480 characters of answer text.
- Do not add a reply-target prefix or @mention just because the viewer asked the question. You may mention the viewer naturally only when it genuinely fits the answer.
- Do not use markdown.

Output only the answer.`;

    let answer;
    try {
      answer = await callGeminiWithRetries(prompt, config.aiRetry, ({ attempt, maxRetries, delayMs, error }) => {
        console.warn(`[Tagged Questions] Temporary Gemini failure for ${displayName || 'viewer'}; retry ${attempt}/${maxRetries} in ${(delayMs / 1000).toFixed(0)}s: ${error?.message || error}`);
      });
    } catch (err) {
      failureGuards.set(failureGuardKey, Date.now() + TAGGED_QUESTION_FAILURE_GUARD_MS);
      console.error(`[Tagged Questions] Gemini failed for ${displayName || 'viewer'} after retry handling:`, err?.message || err);
      const failureText = clipTwitchMessage(renderFailureResponse(config.aiRetry?.failureResponse, displayName));
      if (!failureText) {
        return { matched: true, responded: false, reason: 'ai_failure', error: err?.message || String(err) };
      }
      noteOwnResponse(failureText);
      const failureResult = await sendTaggedResponse(failureText);
      return {
        matched: true,
        responded: true,
        reason: 'ai_failure',
        failureResponse: true,
        message: failureText,
        sendMethod: failureResult?.method || 'unknown'
      };
    }
    const personaPrefix = config.name ? `(${toUnicodeBoldSans(`as ${config.name}`)}): ` : '';
    const rendered = clipTwitchMessage(answer, personaPrefix);
    if (!rendered) return { matched: true, responded: false, reason: 'empty_response' };

    noteOwnResponse(rendered);
    const result = await sendTaggedResponse(rendered);
    if (!bypassCooldown) lastPublicResponseAt = Date.now();
    return { matched: true, responded: true, message: rendered, sendMethod: result?.method || 'unknown' };
  }

  return {
    initialize,
    loadConfig,
    saveConfig,
    getConfig: () => ({ ...config, aiRetry: { ...config.aiRetry }, sessionMemory: { ...config.sessionMemory } }),
    handleTaggedQuestion,
    consumeOwnResponse
  };
}

module.exports = {
  MAX_BOT_PERSONALITY_NAME_LENGTH,
  MAX_BOT_PERSONALITY_LENGTH,
  MIN_BOT_PERSONALITY_COOLDOWN_SECONDS,
  MAX_BOT_PERSONALITY_COOLDOWN_SECONDS,
  MAX_BOT_PERSONALITY_COOLDOWN_RESPONSE_LENGTH,
  MAX_TAGGED_QUESTION_RETRIES,
  MAX_TAGGED_QUESTION_FAILURE_RESPONSE_LENGTH,
  createBotPersonalityManager
};
