const { getRecentStreamRecaps, saveStreamRecap, clearStreamRecapsByChannel } = require('../services/streamRecapHistory');

const SUMMARY_PREFIX = 'Hourly Recap: ';
const TWITCH_MESSAGE_LIMIT = 500;
const SUMMARY_TEXT_LIMIT = TWITCH_MESSAGE_LIMIT - SUMMARY_PREFIX.length;

const FIRST_RECAP_DELAY = 60 * 60 * 1000;
const RECURRING_RECAP_DELAY = 60 * 60 * 1000;
const RECAP_FAILURE_RETRY_DELAY = 5 * 60 * 1000;
const RECAP_COMMAND_COOLDOWN = 5 * 60 * 1000;
const STREAM_STATUS_POLL_INTERVAL = 30 * 1000;
const TOKEN_VALIDATION_INTERVAL = 60 * 60 * 1000;
const MAX_PASTED_MESSAGES = 150;
const RECAP_EXPANSION_THRESHOLD = 380;
const RECAP_EXPANSION_MIN_MESSAGES = 20;
const ACTIVE_CHAT_MESSAGE_THRESHOLD = 100;
const ACTIVE_CHAT_EXPANSION_THRESHOLD = 430;
const ACTIVE_CHAT_TARGET_MIN = 440;

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
    console.error('[Gemini API Error]', JSON.stringify(data, null, 2));
    const error = new Error(data?.error?.message || data?.message || `Gemini API returned HTTP ${response.status}`);
    error.status = response.status;
    error.geminiData = data;
    throw error;
  }

  return data;
}

function buildPrimaryPrompt(chatLogs, streamContexts, twitchEvents = [], previousRecaps = []) {
  const chatContext = chatLogs.join('\n');
  const streamContext = formatStreamContext(streamContexts);
  const eventContext = formatTwitchEvents(twitchEvents);
  const previousRecapContext = formatPreviousRecaps(previousRecaps);

  return `You are creating a factual, useful Twitch chat recap for Qwert or a viewer who was lurking, stepped away, or could not keep up with chat.

Always refer to the streamer/broadcaster as Qwert.

Your job is to tell them what was actually worth knowing from recent chat.

${streamContext}

${eventContext}

${previousRecapContext}

SOURCE-OF-TRUTH RULE:
The supplied chat messages are the source of truth for chat claims, reactions, jokes, viewer opinions, and discussion.
The VERIFIED TWITCH EVENTS section is also a source of truth for the Twitch events explicitly listed there.
Previous hourly recaps are continuity context only and are NOT a source of truth for the current hour.
Twitch title/category metadata is background context only and is never proof that an event happened.
Accuracy is more important than sounding polished or narratively complete.

STRICT FACTUAL ACCURACY:
- Every factual detail about what happened must be directly supported by supplied chat OR the verified Twitch EventSub records.
- Never fill missing context with assumptions, outside knowledge, common game knowledge, or what seems likely.
- Never invent stream/game events, milestones, raids, follows, subscriptions, cheers, counts, announcements, or outcomes beyond what chat or verified Twitch events support.
- Never turn speculation, jokes, guesses, predictions, questions, or suggestions into established facts.
- Do not combine unrelated messages in a way that creates a new implied fact.
- When uncertain, omit the detail or preserve the ambiguity.

PRESERVE AMBIGUITY:
- If a number, name, pronoun, event, milestone, or reference is unclear, keep it unclear or omit it.
- Example: "almost have 200 on Twitch" may become "almost at 200 on Twitch" but NEVER "200 followers/viewers/subscribers" unless chat says which.

REFERENT AND LABEL PRESERVATION:
- Preserve the exact type of thing chat is discussing.
- If chat says "favorites," summarize it as favorites. Do NOT silently change it to "team," "roster," "party," "lineup," or "build."
- If chat says "list," do not decide what kind of list it is unless chat establishes that.
- Pokemon names appearing together do NOT prove they are Qwert's active team.
- Suggestions to add/remove/replace/rank Pokemon do NOT automatically mean gameplay team changes.
- Do not infer the purpose of a collection, ranking, list, group, favorites selection, lineup, roster, party, or box.
- Keep source terminology whenever possible. Broader-but-accurate wording is better than specific-but-inferred wording.
- Directional or ordinal choices such as "left / middle / right", "first / second / third", colors, letters, or numbers do NOT by themselves prove that chat was navigating a menu, choosing an item, selecting a starter, picking a Pokeball, or performing any other gameplay/UI action.
- If chat only debates options like "left, middle, or right," summarize that literally as chat debating or voting on left/middle/right unless the source itself identifies what those choices represent.
- Never use stream title/category or outside game knowledge to name an ambiguous choice. For example, a Pokemon category does not let you infer that "left / middle / right" means starter Pokeballs.

MESSAGE ORDER AND RECENCY:
- Messages are ordered older to newer, but order is NOT a narrative timeline.
- Do NOT use "later," "earlier," "afterward," "then," "eventually," or similar chronology merely because one message appears after another.
- Do not imply distinct chronological phases unless chat explicitly establishes them.
- Use neutral connectors for independent topics.

CAUSALITY RULE:
- Do NOT imply that one topic, event, joke, loss, win, comment, question, or reaction caused another unless chat explicitly establishes that relationship.
- Message proximity and order are NOT evidence of causation.
- Never use "prompting," "which prompted," "leading to," "which led to," "causing," "resulting in," "sparking," "triggering," "in response to," "because of this," or similar causal wording unless clearly supported.
- If you cannot prove A caused B, describe A and B independently.

IMPORTANCE FILTER:
Prioritize:
- Funny, surprising, memorable, or strongly reacted-to moments.
- Clearly important stream/gameplay details supported by chat.
- Repeated topics, ongoing jokes, fake commands, debates, predictions, arguments, or suggestions.
- Notable questions directed at Qwert.
- Clear wins, losses, mistakes, discoveries, or reactions when chat actually supports them.
- Useful context about what chat was broadly focused on.
- Sexual jokes, innuendo, suggestive fake commands, or mildly NSFW humor when genuinely noteworthy.

Deprioritize:
- Routine greetings/farewells.
- Someone leaving for work, a meeting, food, sleep, lurking, or returning.
- Mundane one-off personal updates.
- Weak isolated comments or generic filler.

OVERALL PICTURE:
- Summarize broad repeated topics once instead of listing every message.
- Mention usernames only when genuinely notable or useful.
- Balance concrete highlights with the overall picture.
- Do not force unrelated topics into one story.

SEXUAL / SUGGESTIVE CHAT:
- Sexual jokes, innuendo, suggestive humor, horny jokes, or mildly NSFW fake commands may be included when recap-worthy.
- Do not erase them merely to make the recap family-friendly.
- Paraphrase very explicit wording into milder, non-graphic wording.
- Do NOT repeatedly default to the word "banter."
- Prefer specific wording such as "suggestive jokes," "horny jokes," "NSFW humor," "chat got suggestive," "some innuendo," or a softened description of the actual joke when accurate.
- Avoid graphic sexual descriptions or explicit anatomical detail.
- Do not moralize.

WORDING VARIETY:
- Avoid repetitive stock recap language.
- Do not overuse "banter," "chaos," "chaotic," "vibes," "meanwhile," "discussion," or "debate."
- Prefer concrete verbs such as "joked," "suggested," "argued," "questioned," "celebrated," or "reacted" only when supported.
- Do not introduce unsupported meaning merely for variety.

CENSORED CHAT:
- Some messages may contain "[censored]".
- Never guess, reconstruct, or repeat the censored word.
- Summarize surrounding context only if it remains clear.

BEFORE WRITING, SILENTLY CHECK:
1. Did I invent chronology?
2. Did I imply unsupported causality?
3. Did I replace a source label with a more specific one?
4. Did I use title/category as proof of an event?
5. Did I turn a suggestion/question/joke into fact?
6. Did I infer what an ambiguous choice (left/middle/right, first/second/third, etc.) represented, or turn it into menu/navigation/gameplay action without explicit source support?
7. Did I rely on stock wording like "banter" when a concrete description works?
If yes, fix it.

LENGTH AND COVERAGE:
- You have exactly ${SUMMARY_TEXT_LIMIT} characters available for the recap text.
- When enough worthwhile material exists, target about 400-${SUMMARY_TEXT_LIMIT} characters.
- Do not pad with mundane details.
- A recap under 350 characters should happen only when source chat genuinely lacks enough noteworthy material.
- NEVER exceed ${SUMMARY_TEXT_LIMIT} characters.
- Use 2-4 compact complete sentences when useful.
- Never end with "..." or an unfinished thought.
- Do not start with "Hourly Recap:", "Chat Recap:", or "AI Summary:" because the bot adds the prefix.

Recent Twitch chat:
${chatContext}`;
}

function buildExpansionPrompt(currentSummary, chatLogs, streamContexts, twitchEvents = [], previousRecaps = [], targetMin = 400) {
  return `You are revising an existing Twitch recap for Qwert so it uses more of the available space without inventing anything.

${formatStreamContext(streamContexts)}

${formatTwitchEvents(twitchEvents)}

${formatPreviousRecaps(previousRecaps)}

CURRENT RECAP:
${currentSummary}

SOURCE CHAT:
${chatLogs.join('\n')}

RULES:
- Chat and the VERIFIED TWITCH EVENTS section are the sources of truth for CURRENT-HOUR specific events and claims. Stream metadata and previous hourly recaps are context only.
- Keep accurate existing facts; correct unsupported implications.
- Do not import an event or detail from an earlier recap unless the current source chat or current verified events support it in this hour.
- Add only noteworthy details directly supported by chat.
- Preserve ambiguity and exact labels. "favorites" must not become "team" unless chat establishes team.
- Directional/ordinal choices such as "left / middle / right" or "first / second / third" must remain literal unless source chat explicitly identifies what the choices are. Do not turn them into menu navigation, item selection, starter selection, Pokeballs, or another gameplay/UI action based on metadata or game knowledge.
- Do not infer chronology from message order.
- Do not imply causation from proximity/order. Avoid causal connectors such as prompting/leading to/causing/resulting in/sparking/triggering unless chat explicitly proves the relationship.
- Do not turn questions, jokes, suggestions, guesses, or predictions into facts.
- Sexual/suggestive humor may be retained in softened non-graphic wording when noteworthy. Do not repeatedly default to "banter."
- Avoid repetitive stock words such as banter, chaos, vibes, meanwhile, discussion, and debate.
- Do not restore [censored] text.
- Omit greetings, farewells, mundane personal updates, and weak filler.
- This recap window contains ${chatLogs.length} source chat messages.
- When enough distinct worthwhile material exists, target ${targetMin}-${SUMMARY_TEXT_LIMIT} characters. Treat ${targetMin} as a serious target, not a suggestion.
- Actively scan the source for notable topics, jokes, reactions, gameplay details, predictions, or recurring themes omitted from CURRENT RECAP and add the best supported ones.
- Prefer adding another genuinely useful detail over merely rewording the same facts.
- Do not pad, repeat, or add mundane filler just to hit the target. Accuracy still wins if the source genuinely lacks enough worthwhile material.
- NEVER exceed ${SUMMARY_TEXT_LIMIT} characters.
- Use 2-4 compact complete sentences. Never end with "...".
- Do not start with "Hourly Recap:", "Chat Recap:", or "AI Summary:".

Before outputting, silently verify every causal link, every specific noun/label, and every interpretation of an ambiguous choice against the source chat. If it was inferred, rewrite neutrally.

Output ONLY the revised recap.`;
}

async function callGemini(chatLogs, streamContexts = [], twitchEvents = [], previousRecaps = []) {
  return sendGeminiPrompt(buildPrimaryPrompt(chatLogs, streamContexts, twitchEvents, previousRecaps));
}

async function expandRecapWithGemini({ currentSummary, chatLogs, streamContexts = [], twitchEvents = [], previousRecaps = [], targetMin = 400 }) {
  return sendGeminiPrompt(buildExpansionPrompt(currentSummary, chatLogs, streamContexts, twitchEvents, previousRecaps, targetMin));
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

async function generateRecap(chatLogs, streamContexts = [], twitchEvents = [], previousRecaps = []) {
  if ((!Array.isArray(chatLogs) || chatLogs.length === 0) && (!Array.isArray(twitchEvents) || twitchEvents.length === 0)) {
    throw new Error('No chat logs or verified Twitch events were provided to Gemini.');
  }

  chatLogs = Array.isArray(chatLogs) ? chatLogs : [];

  const sanitization = sanitizeChatForGemini(chatLogs);

  if (sanitization.sanitized) {
    console.log(`[Gemini] Sanitized ${sanitization.censoredCount} sensitive term(s) across ${sanitization.affectedMessages} message(s).`);
  }

  let primaryData;

  try {
    primaryData = await callGemini(sanitization.logs, streamContexts, twitchEvents, previousRecaps);
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
    console.error('[Gemini Unexpected Response]', JSON.stringify(primaryData, null, 2));
    throw new Error('Gemini returned a successful response but no readable text output was found.');
  }

  summary = normalizeRecap(summary);
  console.log('[Gemini Primary Recap]', summary);
  console.log(`[Gemini Primary Length] ${summary.length}/${SUMMARY_TEXT_LIMIT}`);

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
    console.log(`[Gemini] Recap is under ${expansionThreshold} chars with ${sourceMessageCount} source messages (${activityLabel}). Running expansion pass targeting ${expansionTargetMin}-${SUMMARY_TEXT_LIMIT} chars.`);

    try {
      const expansionData = await expandRecapWithGemini({
        currentSummary: summary,
        chatLogs: sanitization.logs,
        streamContexts,
        twitchEvents,
        previousRecaps,
        targetMin: expansionTargetMin
      });

      let expandedSummary = extractGeminiText(expansionData);

      if (expandedSummary) {
        expandedSummary = normalizeRecap(expandedSummary);
        console.log('[Gemini Expanded Recap]', expandedSummary);
        console.log(`[Gemini Expanded Length] ${expandedSummary.length}/${SUMMARY_TEXT_LIMIT}`);

        if (expandedSummary.length > summary.length) {
          summary = expandedSummary;
          console.log('[Gemini] Expanded recap selected.');
        } else {
          console.log('[Gemini] Expansion was not longer. Keeping primary recap.');
        }
      }
    } catch (err) {
      console.error('[Gemini Expansion Error]', err);
      console.log('[Gemini] Keeping primary recap because expansion failed.');
    }
  }

  summary = enforceSummaryLimit(summary);
  console.log('[Gemini Final Recap]', summary);
  console.log(`[Gemini Final Length] ${summary.length}/${SUMMARY_TEXT_LIMIT}`);

  return { summary, sanitization };
}

function parsePastedChat(rawText, ignoredUsernames = []) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { logs: [], totalValidMessages: 0, truncated: false };
  }

  const ignored = ignoredUsernames.filter(Boolean).map((name) => name.toLowerCase().trim());
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsedMessages = [];

  for (const originalLine of lines) {
    const line = originalLine.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim();
    let username = '';
    let message = '';
    let match = line.match(/<([A-Za-z0-9_]{1,25})>\s*:?\s*(.+)$/);

    if (match) {
      username = match[1];
      message = match[2];
    }

    if (!username) {
      match = line.match(/^([A-Za-z0-9_]{1,25}):\s*(.+)$/);
      if (match) {
        username = match[1];
        message = match[2];
      }
    }

    if (!username) {
      match = line.match(/\[[^\]]+\]\s+([A-Za-z0-9_]{1,25}):\s*(.+)$/);
      if (match) {
        username = match[1];
        message = match[2];
      }
    }

    if (!username || !message) continue;
    if (ignored.includes(username.toLowerCase())) continue;

    message = message.trim();
    if (!message) continue;

    parsedMessages.push(`${username}: ${message}`);
  }

  const totalValidMessages = parsedMessages.length;

  return {
    logs: parsedMessages.slice(-MAX_PASTED_MESSAGES),
    totalValidMessages,
    truncated: totalValidMessages > MAX_PASTED_MESSAGES
  };
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
}

function createRecapManager({
  client,
  channelName,
  getTwitchAccessToken,
  refreshTwitchAccessToken,
  validateTwitchAccessToken
}) {
  let twitchClientId = (process.env.TWITCH_CLIENT_ID || '').trim();
  let streamStateInitialized = false;
  let streamLive = false;
  let currentStreamTitle = '';
  let currentStreamCategory = '';
  let currentStreamGameId = '';
  let currentStreamId = '';
  let recapMessages = [];
  let messageSequence = 0;
  let streamContexts = [];
  let contextSequence = 0;
  let twitchEvents = [];
  let eventSequence = 0;
  let firstRecapSent = false;
  let recapInProgress = false;
  let streamSessionStartedAt = 0;
  let nextRecapAt = 0;
  let recapPaused = false;
  let pausedRemainingMs = 0;
  let recapTimer = null;
  let streamPollTimer = null;
  let tokenValidationTimer = null;
  let lastRecapCommandUse = 0;

  function addStreamContext({ title = '', category = '', gameId = '' }) {
    const item = {
      title: String(title || '').trim(),
      category: String(category || '').trim(),
      gameId: String(gameId || '').trim()
    };

    const previous = streamContexts[streamContexts.length - 1];
    if (
      previous &&
      previous.title === item.title &&
      previous.category === item.category &&
      previous.gameId === item.gameId
    ) {
      return;
    }

    contextSequence++;
    streamContexts.push({ id: contextSequence, timestamp: Date.now(), ...item });
    console.log('[Recap] Stream context recorded:', {
      title: item.title || 'Unknown',
      category: item.category || 'Unknown'
    });
  }

  function updateCurrentStreamContext(status) {
    const newTitle = String(status?.title || '').trim();
    const newCategory = String(status?.category || '').trim();
    const newGameId = String(status?.gameId || '').trim();

    const changed =
      newTitle !== currentStreamTitle ||
      newCategory !== currentStreamCategory ||
      newGameId !== currentStreamGameId;

    currentStreamTitle = newTitle;
    currentStreamCategory = newCategory;
    currentStreamGameId = newGameId;

    if (changed && streamLive && !recapPaused) {
      addStreamContext({ title: newTitle, category: newCategory, gameId: newGameId });
    }
  }

  async function getAccessTokenOrThrow() {
    const token = await getTwitchAccessToken();
    if (!token) {
      const error = new Error('No Twitch OAuth token is stored in MongoDB. Authorize the bot from the WebUI.');
      error.reauthorizationRequired = true;
      throw error;
    }
    return token;
  }

  async function fetchStreamStatus(allowRefresh = true) {
    if (!twitchClientId) {
      throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
    }

    let accessToken = await getAccessTokenOrThrow();
    const url = 'https://api.twitch.tv/helix/streams?' + new URLSearchParams({
      user_login: channelName
    }).toString();

    let response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': twitchClientId
      }
    });

    if (response.status === 401 && allowRefresh) {
      console.warn('[Recap] Twitch API returned 401. Refreshing OAuth token.');
      const refreshed = await refreshTwitchAccessToken();
      accessToken = refreshed?.accessToken || await getAccessTokenOrThrow();
      twitchClientId = (process.env.TWITCH_CLIENT_ID || twitchClientId).trim();

      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': twitchClientId
        }
      });
    }

    if (!response.ok) {
      throw new Error(`Twitch stream-status request failed with HTTP ${response.status}.`);
    }

    const data = await response.json();
    const stream = Array.isArray(data.data) && data.data.length > 0 ? data.data[0] : null;

    return {
      live: Boolean(stream),
      streamId: stream?.id || '',
      startedAt: stream?.started_at || null,
      title: stream?.title || '',
      category: stream?.game_name || '',
      gameId: stream?.game_id || ''
    };
  }

  async function validateStoredToken() {
    if (typeof validateTwitchAccessToken !== 'function') return;

    const token = await getAccessTokenOrThrow();

    try {
      const validation = await validateTwitchAccessToken(token);
      if (validation?.client_id) twitchClientId = validation.client_id;
      console.log('[Recap] Twitch OAuth token validated.');
    } catch (err) {
      if (err.status === 401 && typeof refreshTwitchAccessToken === 'function') {
        await refreshTwitchAccessToken();
        console.log('[Recap] Twitch OAuth token refreshed after validation failure.');
        return;
      }
      throw err;
    }
  }

  function clearRecapTimer() {
    if (recapTimer) {
      clearTimeout(recapTimer);
      recapTimer = null;
    }
  }

  function scheduleRecapAt(timestamp) {
    clearRecapTimer();
    if (recapPaused) return;

    nextRecapAt = timestamp;
    const delay = Math.max(0, timestamp - Date.now());

    recapTimer = setTimeout(() => {
      sendAutomaticRecap(firstRecapSent ? '60-minute timer' : 'first 60-minute timer')
        .catch((err) => console.error('[Recap] Scheduled recap error:', err));
    }, delay);
  }

  function startStreamSession(status, alreadyLiveAtStartup = false) {
    clearRecapTimer();
    streamLive = true;
    recapMessages = [];
    messageSequence = 0;
    streamContexts = [];
    contextSequence = 0;
    twitchEvents = [];
    eventSequence = 0;
    firstRecapSent = false;
    recapInProgress = false;
    recapPaused = false;
    pausedRemainingMs = 0;

    currentStreamId = String(status?.streamId || '').trim();
    currentStreamTitle = String(status?.title || '').trim();
    currentStreamCategory = String(status?.category || '').trim();
    currentStreamGameId = String(status?.gameId || '').trim();

    if (status?.startedAt && !alreadyLiveAtStartup) {
      const parsed = Date.parse(status.startedAt);
      streamSessionStartedAt = Number.isNaN(parsed) ? Date.now() : parsed;
    } else {
      streamSessionStartedAt = Date.now();
    }

    addStreamContext({
      title: currentStreamTitle,
      category: currentStreamCategory,
      gameId: currentStreamGameId
    });

    nextRecapAt = streamSessionStartedAt + FIRST_RECAP_DELAY;
    scheduleRecapAt(nextRecapAt);

    console.log('[Recap] Qwert is LIVE. Automatic recap session started.');
    console.log('[Recap] Current stream title:', currentStreamTitle || 'Unknown');
    console.log('[Recap] Current category:', currentStreamCategory || 'Unknown');
    console.log('[Recap] First recap will send after 60 minutes.');
  }

  function endStreamSession() {
    clearRecapTimer();
    streamLive = false;
    currentStreamId = '';
    currentStreamTitle = '';
    currentStreamCategory = '';
    currentStreamGameId = '';
    recapMessages = [];
    messageSequence = 0;
    streamContexts = [];
    contextSequence = 0;
    twitchEvents = [];
    eventSequence = 0;
    firstRecapSent = false;
    recapInProgress = false;
    recapPaused = false;
    pausedRemainingMs = 0;
    streamSessionStartedAt = 0;
    nextRecapAt = 0;
    clearStreamRecapsByChannel(channelName)
      .then((result) => console.log(`[Recap] Cleared ${result?.deletedCount || 0} stored stream recap session(s) from MongoDB.`))
      .catch((err) => console.error('[Recap] Could not clear stored stream recap history after stream end:', err.message || err));
    console.log('[Recap] Qwert is OFFLINE. Automatic recap session stopped and recap history cleared.');
  }

  async function checkStreamStatus() {
    try {
      const status = await fetchStreamStatus();

      if (!streamStateInitialized) {
        streamStateInitialized = true;
        if (status.live) startStreamSession(status, true);
        else {
          streamLive = false;
          clearStreamRecapsByChannel(channelName)
            .then((result) => {
              if (result?.deletedCount) console.log(`[Recap] Removed ${result.deletedCount} stale stored recap session(s) while Qwert is offline.`);
            })
            .catch((err) => console.error('[Recap] Could not clear stale stream recap history:', err.message || err));
          console.log('[Recap] Qwert is currently offline. Waiting for stream start.');
        }
        return;
      }

      if (status.live && !streamLive) {
        startStreamSession(status, false);
        return;
      }

      if (!status.live && streamLive) {
        endStreamSession();
        return;
      }

      if (status.live && streamLive) updateCurrentStreamContext(status);
    } catch (err) {
      console.error('[Recap] Stream status check failed:', err.message || err);
    }
  }

  async function stopRecap({ channel, displayName = 'MOD', announce = true }) {
    if (!streamLive) {
      if (announce) await client.say(channel, `@${displayName}, Qwert is offline, so the recap system is already inactive.`);
      return { success: false, message: 'Qwert is offline.' };
    }

    if (recapPaused) {
      if (announce) await client.say(channel, `@${displayName}, automatic hourly recaps are already paused.`);
      return { success: false, message: 'Automatic hourly recaps are already paused.' };
    }

    if (recapInProgress) {
      if (announce) await client.say(channel, `@${displayName}, an hourly recap is already being generated, so it can't be paused right now.`);
      return { success: false, message: 'An hourly recap is currently being generated.' };
    }

    pausedRemainingMs = nextRecapAt ? Math.max(0, nextRecapAt - Date.now()) : 0;
    recapPaused = true;
    clearRecapTimer();

    console.log(`[Recap] Paused by ${displayName}.`);
    console.log(`[Recap] ${recapMessages.length} messages preserved.`);
    console.log(`[Recap] ${formatCountdown(pausedRemainingMs)} remaining on timer.`);

    if (announce) {
      await client.say(channel, `@${displayName}, automatic hourly recaps are paused. ${recapMessages.length} messages are preserved and the timer is frozen with ${formatCountdown(pausedRemainingMs)} remaining.`);
    }

    return { success: true, message: `Automatic hourly recaps paused with ${formatCountdown(pausedRemainingMs)} remaining.` };
  }

  async function startRecap({ channel, displayName = 'MOD', announce = true }) {
    if (!streamLive) {
      if (announce) await client.say(channel, `@${displayName}, Qwert is offline. Hourly recaps will start fresh when the next stream begins.`);
      return { success: false, message: 'Qwert is offline.' };
    }

    if (!recapPaused) {
      if (announce) await client.say(channel, `@${displayName}, automatic hourly recaps are already running.`);
      return { success: false, message: 'Automatic hourly recaps are already running.' };
    }

    recapPaused = false;
    const resumeDelay = Math.max(1000, pausedRemainingMs);
    nextRecapAt = Date.now() + resumeDelay;
    pausedRemainingMs = 0;

    addStreamContext({
      title: currentStreamTitle,
      category: currentStreamCategory,
      gameId: currentStreamGameId
    });

    scheduleRecapAt(nextRecapAt);
    console.log(`[Recap] Resumed by ${displayName}. Next recap in ${formatCountdown(resumeDelay)}.`);

    if (announce) {
      await client.say(channel, `@${displayName}, automatic hourly recaps resumed where they left off. Next recap in ${formatCountdown(resumeDelay)}.`);
    }

    return { success: true, message: `Automatic hourly recaps resumed. Next recap in ${formatCountdown(resumeDelay)}.` };
  }

  function recordTwitchEvent(event) {
    if (!streamLive || recapPaused) return;
    const text = String(event?.text || '').trim();
    if (!text) return;

    eventSequence++;
    twitchEvents.push({
      id: eventSequence,
      timestamp: event?.timestamp || Date.now(),
      type: String(event?.type || 'twitch_event'),
      text
    });

    console.log(`[Recap] Verified Twitch event recorded: ${text}`);
  }

  function recordChatMessage({ displayName, rawMessage }) {
    if (!streamLive || recapPaused) return;
    const text = (rawMessage || '').trim();
    if (!text) return;

    messageSequence++;
    recapMessages.push({
      id: messageSequence,
      timestamp: Date.now(),
      text: `${displayName}: ${text}`
    });
  }

  function discardMessageSnapshot(snapshotMaxId) {
    if (snapshotMaxId === null) return;
    recapMessages = recapMessages.filter((item) => item.id > snapshotMaxId);
  }

  function discardEventSnapshot(snapshotMaxEventId) {
    if (snapshotMaxEventId === null) return;
    twitchEvents = twitchEvents.filter((item) => item.id > snapshotMaxEventId);
  }

  function discardContextSnapshot(snapshotMaxContextId) {
    if (snapshotMaxContextId === null) return;
    streamContexts = streamContexts.filter((item) => item.id > snapshotMaxContextId);

    if (streamContexts.length === 0 && streamLive) {
      addStreamContext({
        title: currentStreamTitle,
        category: currentStreamCategory,
        gameId: currentStreamGameId
      });
    }
  }

  async function sendAutomaticRecap(reason) {
    if (!streamLive || recapPaused || recapInProgress) return;

    recapInProgress = true;
    clearRecapTimer();

    const messageSnapshot = [...recapMessages];
    const contextSnapshot = [...streamContexts];
    const eventSnapshot = [...twitchEvents];
    const snapshotMaxId = messageSnapshot.length ? messageSnapshot[messageSnapshot.length - 1].id : null;
    const snapshotMaxContextId = contextSnapshot.length ? contextSnapshot[contextSnapshot.length - 1].id : null;
    const snapshotMaxEventId = eventSnapshot.length ? eventSnapshot[eventSnapshot.length - 1].id : null;
    const chatLogs = messageSnapshot.map((item) => item.text);

    console.log(`[Recap] Automatic recap triggered by ${reason}.`);
    console.log(`[Recap] Window contains ${chatLogs.length} chat messages and ${eventSnapshot.length} verified Twitch event(s).`);

    try {
      let twitchMessage;
      let recapSummaryBody;
      let previousRecaps = [];

      if (currentStreamId) {
        try {
          previousRecaps = await getRecentStreamRecaps({ streamId: currentStreamId, limit: 5 });
          console.log(`[Recap] Loaded ${previousRecaps.length} previous hourly recap(s) from this stream for continuity context.`);
        } catch (historyErr) {
          console.error('[Recap] Could not load previous stream recap context. Continuing without it:', historyErr.message || historyErr);
        }
      }

      if (chatLogs.length === 0 && eventSnapshot.length === 0) {
        recapSummaryBody = 'Chat was quiet this hour—nothing notable to recap.';
        twitchMessage = SUMMARY_PREFIX + recapSummaryBody;
      } else {
        const result = await generateRecap(chatLogs, contextSnapshot, eventSnapshot, previousRecaps);
        recapSummaryBody = result.summary;
        twitchMessage = SUMMARY_PREFIX + recapSummaryBody;
      }

      if (!streamLive) {
        console.log('[Recap] Stream ended during recap generation. Recap was not sent.');
        recapInProgress = false;
        return;
      }

      await client.say(channelName, twitchMessage, { temporaryPin: true });
      console.log('[Recap] Sent:', twitchMessage);
      console.log(`[Recap] Length: ${twitchMessage.length}/500`);

      if (currentStreamId && recapSummaryBody) {
        try {
          await saveStreamRecap({
            streamId: currentStreamId,
            channelName,
            startedAt: streamSessionStartedAt || null,
            text: recapSummaryBody
          });
          console.log('[Recap] Stored this hourly recap in MongoDB for same-stream continuity context.');
        } catch (historyErr) {
          console.error('[Recap] Recap sent successfully, but MongoDB history storage failed:', historyErr.message || historyErr);
        }
      }

      discardMessageSnapshot(snapshotMaxId);
      discardContextSnapshot(snapshotMaxContextId);
      discardEventSnapshot(snapshotMaxEventId);
      firstRecapSent = true;
      recapInProgress = false;
      nextRecapAt = Date.now() + RECURRING_RECAP_DELAY;
      scheduleRecapAt(nextRecapAt);
      console.log('[Recap] Next automatic recap scheduled in 60 minutes.');
    } catch (err) {
      console.error('[Recap] Automatic recap failed:', err);

      if (err.inputBlocked) {
        recapInProgress = false;
        discardMessageSnapshot(snapshotMaxId);
        discardContextSnapshot(snapshotMaxContextId);
        discardEventSnapshot(snapshotMaxEventId);
        firstRecapSent = true;

        if (streamLive) {
          try {
            await client.say(channelName, "The hourly recap was blocked due to sensitive terms found in chat. I'll try again in 60 minutes. Y'all may have gone a little too hard for the robot. LUL");
          } catch (sendErr) {
            console.error('[Recap] Failed to send blocked-recap notice:', sendErr);
          }

          nextRecapAt = Date.now() + RECURRING_RECAP_DELAY;
          scheduleRecapAt(nextRecapAt);
        }
        return;
      }

      recapInProgress = false;
      nextRecapAt = Date.now() + RECAP_FAILURE_RETRY_DELAY;
      scheduleRecapAt(nextRecapAt);
      console.log('[Recap] Retrying automatic recap in 5 minutes.');
    }
  }

  async function handleRecapCommand({ channel, displayName }) {
    const now = Date.now();
    const elapsed = now - lastRecapCommandUse;

    if (lastRecapCommandUse > 0 && elapsed < RECAP_COMMAND_COOLDOWN) {
      await client.say(channel, `@${displayName}, !recap is on cooldown! Try again in ${formatCountdown(RECAP_COMMAND_COOLDOWN - elapsed)}.`);
      return;
    }

    lastRecapCommandUse = now;

    try {
      if (!streamLive) {
        await client.say(channel, `@${displayName}, hourly recaps will start when Qwert goes live.`);
        return;
      }

      if (recapPaused) {
        await client.say(channel, `@${displayName}, automatic hourly recaps are currently paused by a moderator.`);
        return;
      }

      if (recapInProgress) {
        await client.say(channel, `@${displayName}, the next hourly recap is being generated now.`);
        return;
      }

      const remaining = nextRecapAt ? formatCountdown(nextRecapAt - Date.now()) : 'a moment';
      await client.say(channel, `@${displayName}, the next hourly recap will be sent in ${remaining}.`);
    } catch (err) {
      console.error('[Recap] Failed to answer !recap:', err);
    }
  }

  function getStatus() {
    return {
      streamStateInitialized,
      streamLive,
      currentStreamId: currentStreamId || null,
      currentStreamTitle: currentStreamTitle || null,
      currentStreamCategory: currentStreamCategory || null,
      currentStreamGameId: currentStreamGameId || null,
      recapPaused,
      loggingMessages: streamStateInitialized && streamLive && !recapPaused,
      recapInProgress,
      firstRecapSent,
      messagesInWindow: recapMessages.length,
      twitchEventsInWindow: twitchEvents.length,
      contextChangesInWindow: streamContexts.length,
      nextRecapAt: recapPaused ? null : nextRecapAt || null,
      pausedRemainingMs: recapPaused ? pausedRemainingMs : null,
      streamSessionStartedAt: streamSessionStartedAt || null
    };
  }

  function getCurrentWindowLogs() {
    return recapMessages.map((item) => item.text);
  }

  function getCurrentWindowEvents() {
    return twitchEvents.map((item) => ({ type: item.type, text: item.text, timestamp: item.timestamp }));
  }

  function getCurrentWindowContexts() {
    return streamContexts.map((item) => ({
      title: item.title,
      category: item.category,
      gameId: item.gameId
    }));
  }

  async function getCurrentStreamRecapHistory(limit = 5) {
    if (!currentStreamId) return [];
    return getRecentStreamRecaps({ streamId: currentStreamId, limit });
  }

  async function start() {
    if (!channelName) {
      console.error('[Recap] Cannot start automatic recaps: TWITCH_CHANNEL is missing.');
      return;
    }

    try {
      await validateStoredToken();
    } catch (err) {
      console.error('[Recap] Initial Twitch token validation failed:', err.message || err);
      return;
    }

    await checkStreamStatus();

    streamPollTimer = setInterval(checkStreamStatus, STREAM_STATUS_POLL_INTERVAL);
    tokenValidationTimer = setInterval(() => {
      validateStoredToken().catch((err) => {
        console.error('[Recap] Hourly Twitch token validation failed:', err.message || err);
      });
    }, TOKEN_VALIDATION_INTERVAL);

    console.log('[Recap] Automatic stream detection enabled.');
    console.log('[Recap] Twitch stream status/title/category will be checked every 30 seconds.');
    console.log('[Recap] Automatic recap cadence: every 60 minutes.');
  }

  return {
    start,
    recordChatMessage,
    recordTwitchEvent,
    handleRecapCommand,
    stopRecap,
    startRecap,
    getCurrentWindowLogs,
    getCurrentWindowContexts,
    getCurrentWindowEvents,
    getCurrentStreamRecapHistory,
    getStatus
  };
}

module.exports = {
  createRecapManager,
  generateRecap,
  parsePastedChat,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT,
  SUMMARY_TEXT_LIMIT,
  MAX_PASTED_MESSAGES
};
