const SUMMARY_PREFIX = 'Chat Recap: ';
const TWITCH_MESSAGE_LIMIT = 500;
const SUMMARY_TEXT_LIMIT = TWITCH_MESSAGE_LIMIT - SUMMARY_PREFIX.length;

const FIRST_RECAP_DELAY = 60 * 60 * 1000;
const FIRST_RECAP_MESSAGE_TRIGGER = 150;
const RECURRING_RECAP_DELAY = 45 * 60 * 1000;
const RECAP_FAILURE_RETRY_DELAY = 5 * 60 * 1000;

const STREAM_STATUS_POLL_INTERVAL = 30 * 1000;
const TOKEN_VALIDATION_INTERVAL = 60 * 60 * 1000;

const MAX_PASTED_MESSAGES = 150;

// ==========================================
// CHAT SANITIZATION
// ==========================================

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

  const sanitizedLogs = chatLogs.map((chat) => {
    let sanitized = chat;
    let messageChanged = false;

    for (const pattern of sensitivePatterns) {
      sanitized = sanitized.replace(pattern, () => {
        censoredCount++;
        messageChanged = true;
        return '[censored]';
      });
    }

    if (messageChanged) {
      affectedMessages++;
    }

    return sanitized;
  });

  return {
    logs: sanitizedLogs,
    censoredCount,
    affectedMessages,
    sanitized: censoredCount > 0
  };
}

// ==========================================
// GEMINI API REQUEST
// ==========================================

async function callGemini(chatLogs) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }

  const chatContext = chatLogs.join('\n');

  const customPrompt = `You are creating a factual, useful Twitch chat recap for Qwert or a viewer who was lurking, stepped away, or could not keep up with chat.

Always refer to the streamer/broadcaster as Qwert.

Your job is to tell them what was actually worth knowing from recent chat.

SOURCE-OF-TRUTH RULE:
The supplied chat messages are your ONLY source of factual information.
Treat anything not explicitly supported by those messages as unknown.
Accuracy is more important than sounding polished, complete, or confident.

STRICT FACTUAL ACCURACY:
- Every factual detail in the recap must be directly supported by the supplied chat.
- Never fill in missing context using assumptions, common knowledge, outside knowledge, or what you think someone probably meant.
- Never invent stream events, game events, milestones, raids, follows, subscriptions, viewer counts, follower counts, surprises, announcements, or other occurrences not explicitly supported by chat.
- Never turn speculation, jokes, guesses, predictions, or questions into established facts.
- Do not combine unrelated messages in a way that creates a new implied fact.
- When uncertain, omit the detail rather than guess.

PRESERVE AMBIGUITY:
Twitch chat often uses shorthand and assumes context you may not have.
If the meaning of a number, name, pronoun, event, milestone, or reference is unclear, preserve the original ambiguity or omit it.

Example:
If someone says "you almost have 200 on Twitch," you may say "they noted Qwert is almost at 200 on Twitch."
Do NOT change it to "200 followers," "200 viewers," "200 subscribers," or another interpretation unless the chat explicitly says what 200 refers to.

MESSAGE ORDER AND RECENCY:
- The supplied messages are ordered from older to newer within one recap window.
- Message order indicates recency, NOT a narrative timeline.
- Do NOT use words such as "later," "later on," "earlier," "afterward," "afterwards," "subsequently," "eventually," "then," or "before that" merely because one message appears after another.
- Do not imply that separate topics happened in distinct chronological phases unless the chat explicitly establishes that sequence.
- Prefer neutral connectors such as "also," "while," "and," or "meanwhile" when combining topics.
- Messages near the bottom are simply the most recent messages in the supplied chat window.

IMPORTANCE FILTER:
Not every chat message deserves to appear in the recap.

Prioritize details that are:
- Funny, surprising, chaotic, memorable, or likely to make someone laugh.
- Clearly important to the stream or current gameplay.
- Repeated by multiple viewers.
- Part of an ongoing joke, debate, prediction, argument, or running topic.
- A notable or interesting question directed at Qwert.
- Something chat reacted strongly to.
- A clear win, loss, clutch moment, mistake, discovery, or other notable game-related reaction.
- Useful context for understanding what chat was broadly focused on.

Deprioritize or omit:
- Routine greetings and farewells.
- Someone saying they are leaving, going to work, joining a meeting, eating, sleeping, lurking, or returning.
- Mundane personal updates that chat did not meaningfully react to.
- Isolated food, drink, product, or brand preferences unless they became a larger discussion or joke.
- Minor one-off comments with no broader relevance.
- Details that are specific but not actually interesting.
- A user's personal update simply because it is easy to summarize.

Before writing the recap, internally rank candidate details by recap value and include only the strongest ones.

OVERALL PICTURE:
- If many messages revolve around the same broad topic, summarize that topic once instead of listing many individual comments.
- Use usernames and direct examples only for the funniest, strongest, most representative, or most useful moments.
- Balance specific highlights with a clear overall picture of what chat was mainly focused on.
- Do not turn the recap into a list of unrelated usernames and one-off comments.
- It is better to capture 3 or 4 meaningful themes or moments well than to mention 8 mundane details.

OPTIONAL VIBE OPENER:
- You MAY begin with one very short description of the overall chat mood or vibe if it is strongly and clearly supported by many messages.
- Keep it extremely short, ideally only a few words.
- Example: "Chat is chaotic and Pokémon-heavy, ..."
- Do not use a vibe opener if it would crowd out useful concrete information.
- Avoid generic phrases such as "fun and lively," "good vibes," "friendly banter," or "supportive atmosphere."
- If the recap itself already makes the mood obvious, skip the vibe description entirely.

PRIORITIZE CONCRETE DETAILS:
- Mention specific usernames only when their contribution is genuinely noteworthy, funny, repeated, useful, or central to a larger topic.
- Do not include a username merely because their message is easy to summarize.
- Mention specific people, games, characters, Pokémon, items, events, strategies, or other named topics when they matter to the recap.
- Capture notable opinions, disagreements, debates, questions, predictions, suggestions, decisions, and reactions.
- Mention recurring jokes, callbacks, stream lore, or memorable comments when clearly supported by chat.
- If chat is reacting to something, describe only what the messages actually establish they are reacting to.
- Combine related comments efficiently, but do not merge unrelated comments into a new claim.

AVOID VAGUE SUMMARIES:
- Do not waste space describing mood when specific useful information is available.
- Do not say "viewers discussed strategies" when the specific strategy or opinion is worth mentioning.
- Do not say "chat was joking around" when the actual joke can be briefly described.
- Avoid filler such as "friendly banter," "shared support," "good vibes," or similar generic language.
- Do not force specificity when a broader summary would better represent the conversation.

CENSORED CHAT:
- Some messages may contain the literal text "[censored]".
- Keep surrounding context when useful.
- Do not guess, restore, reconstruct, or repeat the censored word.
- It is okay to omit the censored detail entirely.

BEFORE WRITING THE RECAP:
Internally:
1. Identify the main topics and notable moments.
2. Identify which individual messages are actually funny, important, repeated, or representative.
3. Remove mundane or low-value details.
4. Rank what remains by recap value.
5. Write the recap using ONLY supported details.

Do not output your analysis or ranking.
Output only the final recap.

LENGTH AND ENDING:
- You have exactly ${SUMMARY_TEXT_LIMIT} characters available for the recap text.
- Aim to use most of those ${SUMMARY_TEXT_LIMIT} characters when there are enough useful, well-supported details.
- NEVER exceed ${SUMMARY_TEXT_LIMIT} characters.
- Every sentence must be complete.
- Never end with "..." or an unfinished thought.
- Never begin another topic unless you have enough room to finish that thought.
- If there is not enough room for another complete topic, omit that topic entirely.
- Prefer fewer complete, meaningful details over squeezing in mundane extras.
- Do not sacrifice factual accuracy or sentence completeness just to get closer to the character limit.

STYLE:
- Write 2 to 4 compact sentences when useful.
- Be information-dense but natural and readable.
- No hashtags.
- Do not start with "Chat Recap:" because the bot adds it separately.
- Do not start with "AI Summary:".
- Never add assumptions, filler, inferred context, or fake chronology just to make the recap longer.
- A shorter recap containing the best moments is better than a longer recap filled with mundane details.

Recent Twitch chat:
${chatContext}`;

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        model: 'gemini-3.5-flash-lite',
        input: customPrompt
      })
    }
  );

  let data;

  try {
    data = await response.json();
  } catch (err) {
    throw new Error(
      `Gemini returned invalid JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    console.error('[Gemini API Error]', JSON.stringify(data, null, 2));

    const errorMessage =
      data?.error?.message ||
      data?.message ||
      `Gemini API returned HTTP ${response.status}`;

    const error = new Error(errorMessage);
    error.status = response.status;
    error.geminiData = data;

    throw error;
  }

  return data;
}

// ==========================================
// EXTRACT GEMINI RESPONSE
// ==========================================

function extractGeminiText(data) {
  let summary = '';

  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (
        step?.type !== 'model_output' ||
        !Array.isArray(step.content)
      ) {
        continue;
      }

      for (const item of step.content) {
        if (
          item?.type === 'text' &&
          typeof item.text === 'string' &&
          item.text.trim()
        ) {
          summary += `${item.text} `;
        }
      }
    }
  }

  if (!summary && typeof data.output_text === 'string') {
    summary = data.output_text;
  }

  if (!summary && typeof data.outputText === 'string') {
    summary = data.outputText;
  }

  if (!summary && typeof data.text === 'string') {
    summary = data.text;
  }

  if (!summary && Array.isArray(data.outputs)) {
    for (const output of data.outputs) {
      if (typeof output?.text === 'string') {
        summary += `${output.text} `;
      }
    }
  }

  return summary.trim();
}

// ==========================================
// CLEAN RECAP WORDING
// ==========================================

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
    .replace(/\bAlso,\s+also\b/gi, 'Also')
    .trim();
}

// ==========================================
// SAFE COMPLETE-SENTENCE LIMIT
// ==========================================

function enforceSummaryLimit(summary) {
  if (summary.length <= SUMMARY_TEXT_LIMIT) {
    return summary;
  }

  const withinLimit = summary.substring(
    0,
    SUMMARY_TEXT_LIMIT
  );

  const lastSentenceEnd = Math.max(
    withinLimit.lastIndexOf('.'),
    withinLimit.lastIndexOf('?'),
    withinLimit.lastIndexOf('!')
  );

  if (lastSentenceEnd >= 0) {
    return withinLimit
      .substring(0, lastSentenceEnd + 1)
      .trim();
  }

  const lastSpace = withinLimit.lastIndexOf(' ');

  if (lastSpace > 0) {
    return withinLimit
      .substring(0, lastSpace)
      .trim();
  }

  return withinLimit.trim();
}

// ==========================================
// GENERATE RECAP
// ==========================================

async function generateRecap(chatLogs) {
  if (!Array.isArray(chatLogs) || chatLogs.length === 0) {
    throw new Error(
      'No chat logs were provided to Gemini.'
    );
  }

  const sanitization =
    sanitizeChatForGemini(chatLogs);

  if (sanitization.sanitized) {
    console.log(
      `[Gemini] Sanitized ${sanitization.censoredCount} sensitive term(s) across ` +
      `${sanitization.affectedMessages} message(s).`
    );
  }

  let data;

  try {
    data = await callGemini(
      sanitization.logs
    );
  } catch (err) {
    const message = err.message || '';

    const inputBlocked =
      message.includes('Input blocked') ||
      message.includes('sensitive words') ||
      message.includes('Prohibited Use policy');

    if (inputBlocked) {
      const blockedError = new Error(
        'Gemini blocked the chat input even after sensitive-term redaction.'
      );

      blockedError.inputBlocked = true;
      blockedError.sanitization =
        sanitization;

      throw blockedError;
    }

    throw err;
  }

  let summary =
    extractGeminiText(data);

  if (!summary) {
    console.error(
      '[Gemini Unexpected Response]',
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      'Gemini returned a successful response but no readable text output was found.'
    );
  }

  summary = summary
    .replace(/^AI Summary:\s*/i, '')
    .replace(/^Chat Recap:\s*/i, '');

  summary =
    cleanRecapWording(summary);

  if (/\.{3}\s*$/.test(summary)) {
    const withoutEllipsis =
      summary.replace(/\s*\.{3}\s*$/, '');

    const lastSentenceEnd = Math.max(
      withoutEllipsis.lastIndexOf('.'),
      withoutEllipsis.lastIndexOf('?'),
      withoutEllipsis.lastIndexOf('!')
    );

    if (lastSentenceEnd >= 0) {
      summary = withoutEllipsis
        .substring(0, lastSentenceEnd + 1)
        .trim();
    }
  }

  summary =
    enforceSummaryLimit(summary);

  console.log(
    '[Gemini Recap]',
    summary
  );

  console.log(
    `[Gemini Recap Length] ${summary.length}/${SUMMARY_TEXT_LIMIT}`
  );

  return {
    summary,
    sanitization
  };
}

// ==========================================
// PARSE PASTED RENDER LOGS
// ==========================================

function parsePastedChat(
  rawText,
  ignoredUsernames = []
) {
  if (
    typeof rawText !== 'string' ||
    !rawText.trim()
  ) {
    return {
      logs: [],
      totalValidMessages: 0,
      truncated: false
    };
  }

  const ignored = ignoredUsernames
    .filter(Boolean)
    .map((name) =>
      name.toLowerCase().trim()
    );

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsedMessages = [];

  for (const originalLine of lines) {
    const line = originalLine
      .replace(
        /\x1B\[[0-9;]*[A-Za-z]/g,
        ''
      )
      .trim();

    let username = '';
    let message = '';
    let match;

    match = line.match(
      /<([A-Za-z0-9_]{1,25})>\s*:?\s*(.+)$/
    );

    if (match) {
      username = match[1];
      message = match[2];
    }

    if (!username) {
      match = line.match(
        /^([A-Za-z0-9_]{1,25}):\s*(.+)$/
      );

      if (match) {
        username = match[1];
        message = match[2];
      }
    }

    if (!username) {
      match = line.match(
        /\[[^\]]+\]\s+([A-Za-z0-9_]{1,25}):\s*(.+)$/
      );

      if (match) {
        username = match[1];
        message = match[2];
      }
    }

    if (!username || !message) {
      continue;
    }

    if (
      ignored.includes(
        username.toLowerCase()
      )
    ) {
      continue;
    }

    message = message.trim();

    if (!message) {
      continue;
    }

    parsedMessages.push(
      `${username}: ${message}`
    );
  }

  const totalValidMessages =
    parsedMessages.length;

  return {
    logs: parsedMessages.slice(
      -MAX_PASTED_MESSAGES
    ),
    totalValidMessages,
    truncated:
      totalValidMessages >
      MAX_PASTED_MESSAGES
  };
}

// ==========================================
// COUNTDOWN FORMATTER
// ==========================================

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(
    0,
    Math.ceil(milliseconds / 1000)
  );

  const minutes = Math.floor(
    totalSeconds / 60
  );

  const seconds =
    totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}min ${seconds}s`;
  }

  return `${seconds}s`;
}

// ==========================================
// AUTOMATIC RECAP MANAGER
// ==========================================

function createRecapManager({
  client,
  channelName,
  botUsername,
  twitchAccessToken
}) {
  const accessToken =
    (twitchAccessToken || '')
      .replace(/^oauth:/i, '')
      .trim();

  let twitchClientId = '';

  let streamStateInitialized = false;
  let streamLive = false;

  let recapMessages = [];
  let messageSequence = 0;

  let firstRecapSent = false;
  let recapInProgress = false;

  let streamSessionStartedAt = 0;
  let nextRecapAt = 0;

  let recapTimer = null;
  let streamPollTimer = null;
  let tokenValidationTimer = null;

  // ========================================
  // TWITCH TOKEN VALIDATION
  // ========================================

  async function validateTwitchToken() {
    if (!accessToken) {
      throw new Error(
        'TWITCH_BOT_ACCESS_TOKEN is missing.'
      );
    }

    const response = await fetch(
      'https://id.twitch.tv/oauth2/validate',
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `Twitch token validation failed with HTTP ${response.status}.`
      );
    }

    const data =
      await response.json();

    if (!data.client_id) {
      throw new Error(
        'Twitch token validation did not return a Client ID.'
      );
    }

    twitchClientId =
      data.client_id;

    console.log(
      '[Recap] Twitch OAuth token validated.'
    );

    return data;
  }

  // ========================================
  // TWITCH STREAM STATUS
  // ========================================

  async function fetchStreamStatus(
    allowRetry = true
  ) {
    if (!twitchClientId) {
      await validateTwitchToken();
    }

    const url =
      'https://api.twitch.tv/helix/streams?' +
      new URLSearchParams({
        user_login: channelName
      }).toString();

    const response = await fetch(
      url,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,
          'Client-Id':
            twitchClientId
        }
      }
    );

    if (
      response.status === 401 &&
      allowRetry
    ) {
      console.warn(
        '[Recap] Twitch API returned 401. Revalidating token.'
      );

      await validateTwitchToken();

      return fetchStreamStatus(false);
    }

    if (!response.ok) {
      throw new Error(
        `Twitch stream-status request failed with HTTP ${response.status}.`
      );
    }

    const data =
      await response.json();

    const stream =
      Array.isArray(data.data) &&
      data.data.length > 0
        ? data.data[0]
        : null;

    return {
      live: Boolean(stream),
      startedAt:
        stream?.started_at || null
    };
  }

  // ========================================
  // TIMER MANAGEMENT
  // ========================================

  function clearRecapTimer() {
    if (recapTimer) {
      clearTimeout(recapTimer);
      recapTimer = null;
    }
  }

  function scheduleRecapAt(timestamp) {
    clearRecapTimer();

    nextRecapAt = timestamp;

    const delay = Math.max(
      0,
      timestamp - Date.now()
    );

    recapTimer = setTimeout(
      () => {
        sendAutomaticRecap(
          firstRecapSent
            ? '45-minute timer'
            : '1-hour timer'
        ).catch((err) => {
          console.error(
            '[Recap] Scheduled recap error:',
            err
          );
        });
      },
      delay
    );
  }

  // ========================================
  // STREAM START
  // ========================================

  function startStreamSession(
    detectedStartedAt = null,
    alreadyLiveAtStartup = false
  ) {
    clearRecapTimer();

    streamLive = true;

    recapMessages = [];
    messageSequence = 0;

    firstRecapSent = false;
    recapInProgress = false;

    /*
     * If the bot was already running and saw
     * the offline -> online transition, Twitch's
     * started_at timestamp is safe to use.
     *
     * If Render/bot starts while Qwert is
     * already live, we cannot recover chat from
     * before the bot started, so the recap clock
     * starts from detection time instead.
     */
    if (
      detectedStartedAt &&
      !alreadyLiveAtStartup
    ) {
      const parsed =
        Date.parse(detectedStartedAt);

      streamSessionStartedAt =
        Number.isNaN(parsed)
          ? Date.now()
          : parsed;
    } else {
      streamSessionStartedAt =
        Date.now();
    }

    nextRecapAt =
      streamSessionStartedAt +
      FIRST_RECAP_DELAY;

    scheduleRecapAt(
      nextRecapAt
    );

    console.log(
      '[Recap] Qwert is LIVE. Automatic recap session started.'
    );

    console.log(
      '[Recap] First recap will send after 60 minutes or 150 messages, whichever comes first.'
    );
  }

  // ========================================
  // STREAM END
  // ========================================

  function endStreamSession() {
    clearRecapTimer();

    streamLive = false;

    recapMessages = [];
    messageSequence = 0;

    firstRecapSent = false;
    recapInProgress = false;

    streamSessionStartedAt = 0;
    nextRecapAt = 0;

    console.log(
      '[Recap] Qwert is OFFLINE. Automatic recap session stopped and recap history cleared.'
    );
  }

  // ========================================
  // STREAM STATUS POLL
  // ========================================

  async function checkStreamStatus() {
    try {
      const status =
        await fetchStreamStatus();

      if (!streamStateInitialized) {
        streamStateInitialized = true;

        if (status.live) {
          startStreamSession(
            status.startedAt,
            true
          );
        } else {
          streamLive = false;

          console.log(
            '[Recap] Qwert is currently offline. Waiting for stream start.'
          );
        }

        return;
      }

      if (
        status.live &&
        !streamLive
      ) {
        startStreamSession(
          status.startedAt,
          false
        );

        return;
      }

      if (
        !status.live &&
        streamLive
      ) {
        endStreamSession();
      }
    } catch (err) {
      console.error(
        '[Recap] Stream status check failed:',
        err
      );
    }
  }

  // ========================================
  // RECORD CHAT
  // ========================================

  function recordChatMessage({
    displayName,
    rawMessage
  }) {
    if (!streamLive) {
      return;
    }

    const text =
      (rawMessage || '').trim();

    if (
      !text ||
      text.startsWith('!')
    ) {
      return;
    }

    messageSequence++;

    recapMessages.push({
      id: messageSequence,
      timestamp: Date.now(),
      text:
        `${displayName}: ${text}`
    });

    /*
     * Only the FIRST recap may be triggered
     * early by hitting 150 messages.
     *
     * After the first recap, recaps stay on
     * the fixed 45-minute schedule.
     */
    if (
      !firstRecapSent &&
      !recapInProgress &&
      recapMessages.length >=
        FIRST_RECAP_MESSAGE_TRIGGER
    ) {
      sendAutomaticRecap(
        '150-message trigger'
      ).catch((err) => {
        console.error(
          '[Recap] 150-message recap error:',
          err
        );
      });
    }
  }

  // ========================================
  // AUTOMATIC RECAP
  // ========================================

  async function sendAutomaticRecap(
    reason
  ) {
    if (
      !streamLive ||
      recapInProgress
    ) {
      return;
    }

    recapInProgress = true;
    clearRecapTimer();

    const snapshot =
      [...recapMessages];

    const snapshotMaxId =
      snapshot.length > 0
        ? snapshot[
            snapshot.length - 1
          ].id
        : null;

    const chatLogs =
      snapshot.map(
        (item) => item.text
      );

    console.log(
      `[Recap] Automatic recap triggered by ${reason}.`
    );

    console.log(
      `[Recap] Window contains ${chatLogs.length} chat messages.`
    );

    try {
      let twitchMessage;

      if (
        chatLogs.length === 0
      ) {
        twitchMessage =
          SUMMARY_PREFIX +
          'Chat was quiet this stretch—nothing notable to recap.';
      } else {
        const result =
          await generateRecap(
            chatLogs
          );

        twitchMessage =
          SUMMARY_PREFIX +
          result.summary;
      }

      /*
       * Qwert may have gone offline while
       * Gemini was generating the recap.
       */
      if (!streamLive) {
        console.log(
          '[Recap] Stream ended during recap generation. Recap was not sent.'
        );

        recapInProgress = false;
        return;
      }

      await client.say(
        channelName,
        twitchMessage
      );

      console.log(
        '[Recap] Sent:',
        twitchMessage
      );

      console.log(
        `[Recap] Length: ${twitchMessage.length}/500`
      );

      /*
       * Permanently discard ONLY messages
       * that existed when this recap began.
       *
       * Any chat that arrived while Gemini
       * was generating stays for the next
       * recap window.
       */
      if (
        snapshotMaxId !== null
      ) {
        recapMessages =
          recapMessages.filter(
            (item) =>
              item.id >
              snapshotMaxId
          );
      }

      firstRecapSent = true;
      recapInProgress = false;

      /*
       * Every recap after the first one is
       * exactly 45 minutes after the previous
       * successful recap.
       */
      nextRecapAt =
        Date.now() +
        RECURRING_RECAP_DELAY;

      scheduleRecapAt(
        nextRecapAt
      );

      console.log(
        '[Recap] Previous recap messages marked as used.'
      );

      console.log(
        '[Recap] Next automatic recap scheduled in 45 minutes.'
      );
    } catch (err) {
      console.error(
        '[Recap] Automatic recap failed:',
        err
      );

      recapInProgress = false;

      /*
       * Keep the existing messages if Gemini
       * or Twitch fails. Retry automatically
       * five minutes later instead of losing
       * the recap window.
       */
      nextRecapAt =
        Date.now() +
        RECAP_FAILURE_RETRY_DELAY;

      scheduleRecapAt(
        nextRecapAt
      );

      console.log(
        '[Recap] Retrying automatic recap in 5 minutes.'
      );
    }
  }

  // ========================================
  // !RECAP STATUS COMMAND
  // ========================================

  async function handleRecapCommand({
    channel,
    displayName
  }) {
    try {
      if (!streamLive) {
        await client.say(
          channel,
          `@${displayName}, chat recaps will start when Qwert goes live.`
        );

        return;
      }

      if (recapInProgress) {
        await client.say(
          channel,
          `@${displayName}, the next chat recap is being generated now.`
        );

        return;
      }

      if (!nextRecapAt) {
        await client.say(
          channel,
          `@${displayName}, the automatic recap timer is starting now.`
        );

        return;
      }

      const timeRemaining =
        formatCountdown(
          nextRecapAt -
          Date.now()
        );

      if (!firstRecapSent) {
        await client.say(
          channel,
          `@${displayName}, the next chat recap will be sent in ${timeRemaining}, or sooner if chat reaches ${FIRST_RECAP_MESSAGE_TRIGGER} messages.`
        );

        return;
      }

      await client.say(
        channel,
        `@${displayName}, the next chat recap will be sent in ${timeRemaining}.`
      );
    } catch (err) {
      console.error(
        '[Recap] Failed to answer !recap:',
        err
      );
    }
  }

  // ========================================
  // CURRENT WINDOW FOR WEB TEST
  // ========================================

  function getCurrentWindowLogs() {
    return recapMessages
      .map((item) => item.text);
  }

  // ========================================
  // START MANAGER
  // ========================================

  async function start() {
    if (
      !channelName ||
      !accessToken
    ) {
      console.error(
        '[Recap] Cannot start automatic recaps: Twitch configuration is incomplete.'
      );

      return;
    }

    try {
      await validateTwitchToken();
    } catch (err) {
      console.error(
        '[Recap] Initial Twitch token validation failed:',
        err
      );

      return;
    }

    await checkStreamStatus();

    streamPollTimer =
      setInterval(
        checkStreamStatus,
        STREAM_STATUS_POLL_INTERVAL
      );

    tokenValidationTimer =
      setInterval(
        () => {
          validateTwitchToken()
            .catch((err) => {
              console.error(
                '[Recap] Hourly Twitch token validation failed:',
                err
              );
            });
        },
        TOKEN_VALIDATION_INTERVAL
      );

    console.log(
      '[Recap] Automatic stream detection enabled.'
    );

    console.log(
      '[Recap] Twitch stream status will be checked every 30 seconds.'
    );
  }

  return {
    start,
    recordChatMessage,
    handleRecapCommand,
    getCurrentWindowLogs
  };
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  createRecapManager,
  generateRecap,
  parsePastedChat,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT,
  SUMMARY_TEXT_LIMIT,
  MAX_PASTED_MESSAGES
};
