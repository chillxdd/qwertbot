const { getRecapPromptConfig, getDefaultRecapPromptConfig } = require('./recapPromptConfig');

const SUMMARY_PREFIX = 'Hourly Recap: ';
const TWITCH_MESSAGE_LIMIT = 500;
const SUMMARY_TEXT_LIMIT = TWITCH_MESSAGE_LIMIT - SUMMARY_PREFIX.length;

const FIRST_RECAP_DELAY = 60 * 60 * 1000;
const RECURRING_RECAP_DELAY = 60 * 60 * 1000;
const RECAP_FAILURE_RETRY_DELAY = 5 * 60 * 1000;
const RECAP_COMMAND_COOLDOWN = 5 * 60 * 1000;
const STREAM_STATUS_POLL_INTERVAL = 30 * 1000;
const TOKEN_VALIDATION_INTERVAL = 60 * 60 * 1000;
const RECAP_EXPANSION_THRESHOLD = 380;
const RECAP_EXPANSION_MIN_MESSAGES = 20;
const ACTIVE_CHAT_MESSAGE_THRESHOLD = 100;
const ACTIVE_CHAT_EXPANSION_THRESHOLD = 430;
const ACTIVE_CHAT_TARGET_MIN = 440;
const ACTIVE_CHAT_ACCEPTABLE_MIN = 420;
const NORMAL_CHAT_ACCEPTABLE_MIN = 380;
const MAX_EXPANSION_ATTEMPTS = 2;

const sensitivePatterns = [
  /\bporn(?:ography)?\b/gi,
  /\bincest\b/gi,
  /\brape(?:d|s|ing)?\b/gi,
  /\bsuicid(?:e|al)\b/gi,
  /\bbehead(?:ed|ing)?\b/gi,
  /\bdecapitat(?:e|ed|ing|ion)\b/gi
];

function sanitizeChatForGemini(chatLogs) {
  let censoredCount = 0;
  let affectedMessages = 0;

  const logs = chatLogs.map((chat) => {
    let sanitized = chat;
    let changed = false;

    for (const pattern of sensitivePatterns) {
      sanitized = sanitized.replace(pattern, () => {
        censoredCount++;
        changed = true;
        return '[censored]';
      });
    }

    if (changed) affectedMessages++;
    return sanitized;
  });

  return {
    logs,
    censoredCount,
    affectedMessages,
    sanitized: censoredCount > 0
  };
}

function formatStreamContext(streamContexts = []) {
  if (!Array.isArray(streamContexts) || streamContexts.length === 0) {
    return `STREAM CONTEXT:\nNo Twitch title/category metadata was supplied for this recap.\nDo not guess the stream title, game, or category.`;
  }

  const unique = [];

  for (const context of streamContexts) {
    const item = {
      title: String(context?.title || '').trim(),
      category: String(context?.category || '').trim(),
      gameId: String(context?.gameId || '').trim()
    };

    const previous = unique[unique.length - 1];
    if (
      previous &&
      previous.title === item.title &&
      previous.category === item.category &&
      previous.gameId === item.gameId
    ) {
      continue;
    }

    unique.push(item);
  }

  const lines = unique.map((context, index) => [
    `Context ${index + 1}:`,
    `- Twitch title: ${context.title || 'Unknown'}`,
    `- Twitch category/game: ${context.category || 'Unknown'}`
  ].join('\n'));

  return `STREAM CONTEXT DURING THIS RECAP WINDOW:\n${lines.join('\n\n')}\n\nSTREAM CONTEXT RULES:\n- Twitch title and category/game are background metadata only.\n- They may help interpret game-specific words or references.\n- They are NOT evidence that a specific event, action, result, milestone, win, loss, joke, or gameplay moment happened.\n- Chat remains the source of truth for specific events and claims.\n- If metadata changed during the window, do NOT infer which messages belonged to which metadata state unless chat explicitly establishes it.\n- Do NOT use metadata changes to invent chronology or causality.`;
}


function formatTwitchEvents(twitchEvents = []) {
  if (!Array.isArray(twitchEvents) || twitchEvents.length === 0) {
    return `VERIFIED TWITCH EVENTS:\nNo verified Twitch EventSub events were supplied for this recap.`;
  }

  const lines = twitchEvents.map((event) => {
    const when = event?.timestamp ? new Date(event.timestamp).toISOString() : 'unknown time';
    return `- [${when}] ${String(event?.text || '').trim()}`;
  }).filter((line) => !line.endsWith('] '));

  return `VERIFIED TWITCH EVENTS DURING THIS RECAP WINDOW:\n${lines.join('\n')}\n\nTWITCH EVENT RULES:\n- These EventSub records are verified Twitch facts and may be stated as facts.\n- Chat is still the source for viewer reactions, jokes, interpretations, and surrounding discussion.\n- Do not invent a reaction to an event unless chat supports it.\n- Do not infer that an event caused a separate chat topic merely because they occurred near each other.\n- Group routine follows rather than listing every follower unless an individual follow became relevant in chat.\n- Subs, gift subs, cheers, raids, and Hype Trains may be named when useful and supported by these verified records.`;
}


function formatStreamLore(streamLore = '') {
  const lore = String(streamLore || '').trim();

  if (!lore) {
    return `STREAM-SPECIFIC LORE:\nNo manually supplied stream-specific lore is currently saved.`;
  }

  return `STREAM-SPECIFIC LORE (MANUALLY SUPPLIED BY QWERT/MOD):\n${lore}\n\nSTREAM LORE RULES:\n- This lore is persistent context supplied by Qwert/mods to explain names, callbacks, recurring jokes, relationships between recurring bits, or other channel-specific references.\n- Use it only when it helps interpret CURRENT chat or VERIFIED TWITCH EVENTS.\n- Lore may explain what a current reference means, but it does NOT prove that a lore event happened again in the current recap window.\n- Do not present lore as a current-hour event unless current chat or verified Twitch events support that it happened now.\n- Do not force lore into the recap when current chat does not make it relevant.\n- If current source material conflicts with lore, trust the current source material.`;
}

function formatStreamTiming(streamTiming = {}) {
  const startedAtMs = Number(streamTiming?.startedAtMs || 0);
  const generatedAtMs = Number(streamTiming?.generatedAtMs || Date.now());
  const suppliedUptimeMs = Number(streamTiming?.uptimeMs);
  const uptimeMs = Number.isFinite(suppliedUptimeMs) && suppliedUptimeMs >= 0
    ? suppliedUptimeMs
    : (startedAtMs > 0 ? Math.max(0, generatedAtMs - startedAtMs) : null);

  if (!startedAtMs || uptimeMs === null) {
    return `STREAM UPTIME:\nExact Twitch stream-start timing was not available for this recap. Do not guess how long the stream has been live.`;
  }

  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const duration = `${hours}h ${minutes}m ${seconds}s`;
  const startedAtIso = new Date(startedAtMs).toISOString();
  const generatedAtIso = new Date(generatedAtMs).toISOString();

  return `STREAM UPTIME (TRUSTED TWITCH TIMING):\n- Twitch stream started at: ${startedAtIso}\n- Recap generation time: ${generatedAtIso}\n- Exact elapsed live time at generation: ${duration}\n\nSTREAM UPTIME RULES:\n- Treat this timing as authoritative for how long the CURRENT Twitch stream has been live. Do not estimate stream duration from chat.\n- You may use the exact elapsed time to interpret chat jokes, questions, requests, bets, or complaints about stream length.\n- If chat asks for \"another X hours\", \"more hours\", \"keep going\", or similar, you may understand that as a request/joke about extending the current stream from this known uptime baseline.\n- A viewer request or joke about additional hours is NOT proof Qwert agreed to stream longer. Preserve it as a request/joke unless the current source explicitly establishes a commitment.\n- Do not infer unrelated events from uptime alone.`;
}

function formatPreviousRecaps(previousRecaps = []) {
  if (!Array.isArray(previousRecaps) || previousRecaps.length === 0) {
    return `PREVIOUS HOURLY RECAPS FROM THIS STREAM:\nNo earlier hourly recaps are available for this stream.`;
  }

  const lines = previousRecaps
    .map((recap, index) => {
      const sequence = Number(recap?.sequence) || index + 1;
      const text = String(recap?.text || '').trim();
      return text ? `- Earlier recap ${sequence}: ${text}` : '';
    })
    .filter(Boolean);

  if (lines.length === 0) {
    return `PREVIOUS HOURLY RECAPS FROM THIS STREAM:\nNo earlier hourly recaps are available for this stream.`;
  }

  return `PREVIOUS HOURLY RECAPS FROM THIS STREAM:\n${lines.join('\n')}\n\nPREVIOUS RECAP RULES:\n- These earlier recaps are continuity context only. They are NOT evidence that anything happened again in the current hour.\n- Use them to recognize callbacks, recurring jokes, names, or ongoing themes and to avoid unnecessarily repeating old recap material.\n- Every factual claim in the CURRENT recap must still be supported by the CURRENT source chat or CURRENT verified Twitch events.\n- Do not carry an old event, result, opinion, relationship, or joke into the current recap unless the current source supports that it continued or returned.\n- If an older recap conflicts with the current source, trust the current source.\n- Do not waste space re-explaining old context unless it helps make a current-hour callback understandable.`;
}

async function sendGeminiPrompt(prompt) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      model: 'gemini-3.5-flash-lite',
      input: prompt
    })
  });

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`Gemini returned invalid JSON. HTTP ${response.status}`);
  }

  if (!response.ok) {
    console.error('[Recap Gemini] API error:', JSON.stringify(data, null, 2));
    const error = new Error(data?.error?.message || data?.message || `Gemini API returned HTTP ${response.status}`);
    error.status = response.status;
    error.geminiData = data;
    throw error;
  }

  return data;
}

function buildPrimaryPrompt(chatLogs, streamContexts, twitchEvents = [], previousRecaps = [], streamLore = '', streamTiming = {}, primaryInstructions = '') {
  const chatContext = chatLogs.join('\n');
  const streamContext = formatStreamContext(streamContexts);
  const eventContext = formatTwitchEvents(twitchEvents);
  const previousRecapContext = formatPreviousRecaps(previousRecaps);
  const streamLoreContext = formatStreamLore(streamLore);
  const streamTimingContext = formatStreamTiming(streamTiming);
  const editableInstructions = String(primaryInstructions || '').trim();

  return `You are generating an hourly Twitch recap for Qwert.

EDITABLE RECAP INSTRUCTIONS (saved in MongoDB):
${editableInstructions}

${streamContext}

${eventContext}

${previousRecapContext}

${streamLoreContext}

${streamTimingContext}

NON-NEGOTIABLE SOURCE-OF-TRUTH AND ACCURACY RULES:
- The supplied chat messages are the source of truth for chat claims, reactions, jokes, viewer opinions, and discussion.
- Messages labeled [MODERATOR ANNOUNCEMENT ...] are official Twitch /announce messages sent by a moderator or broadcaster. Treat the announcement text as an intentional channel statement for this recap window, while avoiding assumptions beyond what the announcement actually says.
- VERIFIED TWITCH EVENTS are a source of truth only for the Twitch events explicitly listed there.
- Previous hourly recaps are continuity context only and are NOT evidence that anything happened again in the current hour.
- Stream-specific lore is interpretation/background context only and is NOT proof that an event happened in the current hour.
- Twitch title/category metadata is background context only and is never proof that an event happened.
- STREAM UPTIME is authoritative only for the current stream's elapsed live time and may be used to interpret duration-related chat without guessing.
- Every factual detail about what happened must be directly supported by supplied current chat or verified Twitch EventSub records.
- Never fill missing context with assumptions, outside knowledge, common game knowledge, or what seems likely.
- Never turn speculation, jokes, guesses, predictions, questions, or suggestions into established facts.
- Do not combine unrelated messages in a way that creates a new implied fact.
- When uncertain, omit the detail or preserve the ambiguity.

NON-NEGOTIABLE AMBIGUITY / LABEL RULES:
- Preserve the exact type of thing chat is discussing. If chat says "favorites," do not silently change it to "team," "roster," "party," "lineup," or "build."
- Pokemon names appearing together do NOT prove they are Qwert's active team.
- Suggestions to add/remove/replace/rank Pokemon do NOT automatically mean gameplay team changes.
- Directional or ordinal choices such as "left / middle / right", "first / second / third", colors, letters, or numbers do NOT by themselves prove menu navigation, item selection, starter selection, Pokeball selection, or any other gameplay/UI action.
- Stream-specific lore may clarify what a CURRENT reference means when the current source invokes that lore, but lore alone cannot prove the current event occurred.
- Never use stream title/category or outside game knowledge to fill an ambiguous referent.

NON-NEGOTIABLE CHRONOLOGY / CAUSALITY RULES:
- Messages are ordered older to newer, but order is NOT a narrative timeline.
- Do not infer distinct chronological phases unless current chat explicitly establishes them.
- Do not imply that one topic/event caused another merely because messages were nearby or ordered that way.
- Avoid causal wording such as prompting, leading to, causing, resulting in, sparking, triggering, in response to, or because of this unless the source explicitly supports the relationship.

NON-NEGOTIABLE OUTPUT RULES:
- Some messages may contain "[censored]". Never guess, reconstruct, or repeat the censored word.
- You have exactly ${SUMMARY_TEXT_LIMIT} characters available for the recap text.
- NEVER exceed ${SUMMARY_TEXT_LIMIT} characters.
- Never end with "..." or an unfinished thought.
- Do not start with "Hourly Recap:", "Chat Recap:", or "AI Summary:" because the bot adds the prefix.
- Accuracy overrides any conflicting editable instruction.

BEFORE WRITING, SILENTLY CHECK:
1. Did I invent chronology?
2. Did I imply unsupported causality?
3. Did I replace a source label with a more specific one?
4. Did I use title/category, prior recaps, or lore as proof of a current event?
5. Did I turn a suggestion/question/joke into fact?
6. Did I infer what an ambiguous choice represented without current-source support?
If yes, fix it.

Recent Twitch chat:
${chatContext}`;
}
function buildExpansionPrompt(currentSummary, chatLogs, streamContexts, twitchEvents = [], previousRecaps = [], streamLore = '', targetMin = 400, streamTiming = {}, expansionInstructions = '') {
  const editableInstructions = String(expansionInstructions || '').trim();

  return `You are revising an existing Twitch recap for Qwert.

EDITABLE EXPANSION INSTRUCTIONS (saved in MongoDB):
${editableInstructions}

${formatStreamContext(streamContexts)}

${formatTwitchEvents(twitchEvents)}

${formatPreviousRecaps(previousRecaps)}

${formatStreamLore(streamLore)}

${formatStreamTiming(streamTiming)}

CURRENT RECAP:
${currentSummary}

SOURCE CHAT:
${chatLogs.join('\n')}

NON-NEGOTIABLE EXPANSION RULES:
- Chat and VERIFIED TWITCH EVENTS are the only sources of truth for current-hour events and claims. Stream metadata, previous recaps, and lore are context only. STREAM UPTIME is authoritative only for exact elapsed stream time.
- Lore may clarify a current reference but cannot prove that a lore event happened again now.
- Preserve ambiguity and exact labels. Do not infer what left/middle/right, first/second/third, colors, numbers, or other vague choices represent unless the current source says so.
- Do not infer chronology from message order or causation from proximity/order.
- Do not turn questions, jokes, suggestions, guesses, or predictions into facts.
- Do not restore [censored] text.
- This recap window contains ${chatLogs.length} source chat messages.
- When enough distinct worthwhile material exists, target ${targetMin}-${SUMMARY_TEXT_LIMIT} characters. Treat ${targetMin} as a serious target, but never use filler, repetition, or unsupported claims to reach it.
- Avoid semantic duplication even when wording differs. Prefer a different supported topic over a narrower restatement of one already covered.
- Preserve [MODERATOR ANNOUNCEMENT ...] messages as intentional moderator/broadcaster statements when relevant without inventing implications beyond their text.
- NEVER exceed ${SUMMARY_TEXT_LIMIT} characters.
- Use complete sentences. Never end with "...".
- Do not start with "Hourly Recap:", "Chat Recap:", or "AI Summary:".
- Accuracy overrides any conflicting editable instruction.

Before outputting, silently verify every causal link, specific noun/label, and interpretation of an ambiguous reference against the current source.

Output ONLY the revised recap.`;
}
async function callGemini(chatLogs, streamContexts = [], twitchEvents = [], previousRecaps = [], streamLore = '', streamTiming = {}, primaryInstructions = '') {
  return sendGeminiPrompt(buildPrimaryPrompt(chatLogs, streamContexts, twitchEvents, previousRecaps, streamLore, streamTiming, primaryInstructions));
}

async function expandRecapWithGemini({ currentSummary, chatLogs, streamContexts = [], twitchEvents = [], previousRecaps = [], streamLore = '', streamTiming = {}, targetMin = 400, attempt = 1, acceptableMin = 380, expansionInstructions = '' }) {
  let prompt = buildExpansionPrompt(currentSummary, chatLogs, streamContexts, twitchEvents, previousRecaps, streamLore, targetMin, streamTiming, expansionInstructions);

  if (attempt > 1) {
    prompt += `\n\nSTRICT RETRY REQUIREMENT:\n- The previous expansion was still too short.\n- Produce ${targetMin}-${SUMMARY_TEXT_LIMIT} characters whenever the supplied source contains enough supported material.\n- Do not stop below ${acceptableMin} characters unless reaching ${acceptableMin} would require filler, repetition, or unsupported claims.\n- Scan the source again for a DIFFERENT noteworthy supported detail that was omitted.\n- Output only the revised recap.`;
  }

  return sendGeminiPrompt(prompt);
}

function extractGeminiText(data) {
  let summary = '';

  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const item of step.content) {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          summary += `${item.text} `;
        }
      }
    }
  }

  if (!summary && typeof data.output_text === 'string') summary = data.output_text;
  if (!summary && typeof data.outputText === 'string') summary = data.outputText;
  if (!summary && typeof data.text === 'string') summary = data.text;

  if (!summary && Array.isArray(data.outputs)) {
    for (const output of data.outputs) {
      if (typeof output?.text === 'string') summary += `${output.text} `;
    }
  }

  return summary.trim();
}

function cleanRecapWording(summary) {
  return summary
    .replace(/\bLater on,\s*/gi, 'Also, ')
    .replace(/\bLater,\s*/gi, 'Also, ')
    .replace(/\bAfterward,\s*/gi, 'Also, ')
    .replace(/\bAfterwards,\s*/gi, 'Also, ')
    .replace(/\bSubsequently,\s*/gi, 'Also, ')
    .replace(/\bEventually,\s*/gi, 'Also, ')
    .replace(/\bThen,\s*/gi, 'Also, ')
    .replace(/\bBefore that,\s*/gi, 'Also, ')
    .replace(/,\s*prompting\s+(?:chat|viewers|members)\s+to\s+/gi, '. Chat also ')
    .replace(/,\s*which prompted\s+(?:chat|viewers|members)\s+to\s+/gi, '. Chat also ')
    .replace(/,\s*leading\s+(?:chat|viewers|members)\s+to\s+/gi, '. Chat also ')
    .replace(/,\s*which led\s+(?:chat|viewers|members)\s+to\s+/gi, '. Chat also ')
    .replace(/,\s*causing\s+(?:chat|viewers|members)\s+to\s+/gi, '. Chat also ')
    .replace(/,\s*resulting in\s+/gi, '. Also, ')
    .replace(/,\s*sparking\s+/gi, '. Also, ')
    .replace(/,\s*triggering\s+/gi, '. Also, ')
    .replace(/\bAlso,\s+also\b/gi, 'Also')
    .replace(/\.\s+also,\s+/gi, '. Also, ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanRecapPrefixes(summary) {
  return summary
    .replace(/^AI Summary:\s*/i, '')
    .replace(/^Chat Recap:\s*/i, '')
    .replace(/^Hourly Recap:\s*/i, '')
    .trim();
}

function removeTrailingEllipsis(summary) {
  if (!/\.{3}\s*$/.test(summary)) return summary;

  const withoutEllipsis = summary.replace(/\s*\.{3}\s*$/, '');
  const lastSentenceEnd = Math.max(
    withoutEllipsis.lastIndexOf('.'),
    withoutEllipsis.lastIndexOf('?'),
    withoutEllipsis.lastIndexOf('!')
  );

  if (lastSentenceEnd >= 0) {
    return withoutEllipsis.substring(0, lastSentenceEnd + 1).trim();
  }

  return withoutEllipsis.trim();
}

function enforceSummaryLimit(summary) {
  if (summary.length <= SUMMARY_TEXT_LIMIT) return summary;

  const withinLimit = summary.substring(0, SUMMARY_TEXT_LIMIT);
  const lastSentenceEnd = Math.max(
    withinLimit.lastIndexOf('.'),
    withinLimit.lastIndexOf('?'),
    withinLimit.lastIndexOf('!')
  );

  if (lastSentenceEnd >= 0) {
    return withinLimit.substring(0, lastSentenceEnd + 1).trim();
  }

  const lastSpace = withinLimit.lastIndexOf(' ');
  return lastSpace > 0 ? withinLimit.substring(0, lastSpace).trim() : withinLimit.trim();
}

function normalizeRecap(summary) {
  let cleaned = cleanRecapPrefixes(summary);
  cleaned = cleanRecapWording(cleaned);
  cleaned = removeTrailingEllipsis(cleaned);
  cleaned = enforceSummaryLimit(cleaned);
  return cleaned;
}

function isGeminiInputBlocked(err) {
  const message = (err?.message || '').toLowerCase();
  return (
    message.includes('input blocked') ||
    message.includes('sensitive words') ||
    message.includes('prohibited use policy') ||
    message.includes('blocked the chat input')
  );
}

async function generateRecap(chatLogs, streamContexts = [], twitchEvents = [], previousRecaps = [], streamLore = '', streamTiming = {}, recapChannelName = '') {
  if ((!Array.isArray(chatLogs) || chatLogs.length === 0) && (!Array.isArray(twitchEvents) || twitchEvents.length === 0)) {
    throw new Error('No chat logs or verified Twitch events were provided to Gemini.');
  }

  chatLogs = Array.isArray(chatLogs) ? chatLogs : [];

  let promptConfig = getDefaultRecapPromptConfig();
  if (recapChannelName) {
    try {
      promptConfig = await getRecapPromptConfig(recapChannelName);
      console.log(`[Recap Gemini] Loaded recap prompt instructions from ${promptConfig.source === 'mongodb' ? 'MongoDB' : 'code defaults'}.`);
    } catch (promptErr) {
      console.error('[Recap Gemini] Could not load recap prompt config from MongoDB. Using code defaults:', promptErr.message || promptErr);
      promptConfig = getDefaultRecapPromptConfig();
    }
  }

  const sanitization = sanitizeChatForGemini(chatLogs);

  if (sanitization.sanitized) {
    console.log(`[Recap Gemini] Sanitized ${sanitization.censoredCount} sensitive term(s) across ${sanitization.affectedMessages} message(s).`);
  }

  let primaryData;

  try {
    primaryData = await callGemini(sanitization.logs, streamContexts, twitchEvents, previousRecaps, streamLore, streamTiming, promptConfig.primaryInstructions);
  } catch (err) {
    if (isGeminiInputBlocked(err)) {
      const blockedError = new Error('Gemini blocked the chat input even after sensitive-term redaction.');
      blockedError.inputBlocked = true;
      blockedError.sanitization = sanitization;
      throw blockedError;
    }
    throw err;
  }

  let summary = extractGeminiText(primaryData);

  if (!summary) {
    console.error('[Recap Gemini] Unexpected response:', JSON.stringify(primaryData, null, 2));
    throw new Error('Gemini returned a successful response but no readable text output was found.');
  }

  summary = normalizeRecap(summary);
  console.log('[Recap Gemini] Primary recap:', summary);
  console.log(`[Recap Gemini] Primary length: ${summary.length}/${SUMMARY_TEXT_LIMIT}`);

  const sourceMessageCount = sanitization.logs.length;
  const activeChatWindow = sourceMessageCount >= ACTIVE_CHAT_MESSAGE_THRESHOLD;
  const expansionThreshold = activeChatWindow
    ? ACTIVE_CHAT_EXPANSION_THRESHOLD
    : RECAP_EXPANSION_THRESHOLD;
  const expansionTargetMin = activeChatWindow
    ? ACTIVE_CHAT_TARGET_MIN
    : 400;

  const shouldExpand =
    summary.length < expansionThreshold &&
    sourceMessageCount >= RECAP_EXPANSION_MIN_MESSAGES;

  if (shouldExpand) {
    const activityLabel = activeChatWindow ? 'active chat window' : 'chat window';
    const acceptableMin = activeChatWindow
      ? ACTIVE_CHAT_ACCEPTABLE_MIN
      : NORMAL_CHAT_ACCEPTABLE_MIN;

    console.log(`[Recap Gemini] Recap is under ${expansionThreshold} chars with ${sourceMessageCount} source messages (${activityLabel}). Up to ${MAX_EXPANSION_ATTEMPTS} expansion attempts will target ${expansionTargetMin}-${SUMMARY_TEXT_LIMIT} chars; outputs under ${acceptableMin} chars are considered too short when supported material exists.`);

    let longestSummary = summary;

    for (let attempt = 1; attempt <= MAX_EXPANSION_ATTEMPTS; attempt++) {
      try {
        const expansionData = await expandRecapWithGemini({
          currentSummary: longestSummary,
          chatLogs: sanitization.logs,
          streamContexts,
          twitchEvents,
          previousRecaps,
          streamLore,
          streamTiming,
          targetMin: expansionTargetMin,
          attempt,
          acceptableMin,
          expansionInstructions: promptConfig.expansionInstructions
        });

        let expandedSummary = extractGeminiText(expansionData);

        if (!expandedSummary) {
          console.log(`[Recap Gemini] Expansion attempt ${attempt} returned no readable recap.`);
          continue;
        }

        expandedSummary = normalizeRecap(expandedSummary);
        console.log(`[Recap Gemini] Expanded recap attempt ${attempt}:`, expandedSummary);
        console.log(`[Recap Gemini] Expanded length attempt ${attempt}: ${expandedSummary.length}/${SUMMARY_TEXT_LIMIT}`);

        if (expandedSummary.length > longestSummary.length) {
          longestSummary = expandedSummary;
          console.log(`[Recap Gemini] Expansion attempt ${attempt} is the new longest valid recap.`);
        } else {
          console.log(`[Recap Gemini] Expansion attempt ${attempt} was not longer than the best recap so far.`);
        }

        if (longestSummary.length >= acceptableMin) {
          console.log(`[Recap Gemini] Recap reached the acceptable minimum of ${acceptableMin} chars; no further expansion retry is needed.`);
          break;
        }

        if (attempt < MAX_EXPANSION_ATTEMPTS) {
          console.log(`[Recap Gemini] Best recap is still only ${longestSummary.length} chars. Retrying expansion with a stricter length instruction.`);
        }
      } catch (err) {
        console.error(`[Recap Gemini] Expansion error attempt ${attempt}:`, err);
        if (attempt < MAX_EXPANSION_ATTEMPTS) {
          console.log('[Recap Gemini] Retrying expansion after the failed attempt.');
        }
      }
    }

    if (longestSummary.length > summary.length) {
      summary = longestSummary;
      console.log('[Recap Gemini] Longest expanded recap selected.');
    } else {
      console.log('[Recap Gemini] No expansion improved the primary recap. Keeping primary recap.');
    }
  }

  summary = enforceSummaryLimit(summary);
  console.log('[Recap Gemini] Final recap:', summary);
  console.log(`[Recap Gemini] Final length: ${summary.length}/${SUMMARY_TEXT_LIMIT}`);

  return { summary, sanitization };
}


module.exports = {
  generateRecap,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT,
  SUMMARY_TEXT_LIMIT,
  sanitizeChatForGemini
};
