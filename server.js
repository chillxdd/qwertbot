const express = require('express');
const tmi = require('tmi.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURATION
// ==========================================

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

const SUMMARY_PREFIX = 'Chat Recap: ';
const TWITCH_MESSAGE_LIMIT = 500;
const SUMMARY_TEXT_LIMIT = TWITCH_MESSAGE_LIMIT - SUMMARY_PREFIX.length;

if (!DASHBOARD_PASSWORD) {
  console.warn('WARNING: DASHBOARD_PASSWORD environment variable is not set.');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ==========================================
// TWITCH CONFIGURATION
// ==========================================

const rawToken = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').trim();
const pass = rawToken.startsWith('oauth:') ? rawToken : `oauth:${rawToken}`;
const channelName = (process.env.TWITCH_CHANNEL || '').toLowerCase().trim();
const botUsername = (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim();

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: botUsername,
    password: pass
  },
  channels: channelName ? [channelName] : []
});

if (!rawToken || !channelName || !botUsername) {
  console.warn('WARNING: Twitch configuration is incomplete.');
  console.warn(
    'Required variables: TWITCH_BOT_ACCESS_TOKEN, TWITCH_CHANNEL, TWITCH_BOT_USERNAME'
  );
} else {
  client.connect()
    .then(() => console.log(`Connected to Twitch channel: #${channelName}`))
    .catch((err) => console.error('Failed to connect to Twitch:', err));
}

// ==========================================
// CHAT LOGGING & COOLDOWN
// ==========================================

const recentChatLogs = [];
const MAX_LOG_SIZE = 50;

let lastRecapUse = 0;
let currentRecapCooldown = 15 * 60 * 1000;

const RECAP_SUCCESS_COOLDOWN = 15 * 60 * 1000;
const RECAP_FAILURE_COOLDOWN = 5 * 60 * 1000;

// ==========================================
// IGNORED CHAT USERS
// ==========================================

function isIgnoredUsername(username) {
  const ignoredUsers = [
    'nightbot',
    'streamelements',
    botUsername
  ].filter(Boolean);

  return ignoredUsers.includes((username || '').toLowerCase().trim());
}

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
// PARSE PASTED RENDER / TWITCH LOGS
// ==========================================

function parsePastedChat(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return {
      logs: [],
      totalValidMessages: 0,
      truncated: false
    };
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsedMessages = [];

  for (const originalLine of lines) {
    const line = originalLine
      .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
      .trim();

    let username = '';
    let message = '';
    let match;

    // [#channel] <username>: message
    // <username>: message
    match = line.match(/<([A-Za-z0-9_]{1,25})>\s*:?\s*(.+)$/);

    if (match) {
      username = match[1];
      message = match[2];
    }

    // username: message
    if (!username) {
      match = line.match(/^([A-Za-z0-9_]{1,25}):\s*(.+)$/);

      if (match) {
        username = match[1];
        message = match[2];
      }
    }

    // [#channel] username: message
    if (!username) {
      match = line.match(/\[[^\]]+\]\s+([A-Za-z0-9_]{1,25}):\s*(.+)$/);

      if (match) {
        username = match[1];
        message = match[2];
      }
    }

    if (!username || !message) {
      continue;
    }

    if (isIgnoredUsername(username)) {
      continue;
    }

    message = message.trim();

    if (!message) {
      continue;
    }

    parsedMessages.push(`${username}: ${message}`);
  }

  const totalValidMessages = parsedMessages.length;
  const truncated = totalValidMessages > 100;

  return {
    logs: parsedMessages.slice(-100),
    totalValidMessages,
    truncated
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

  const customPrompt = `You are creating a factual recap of recent Twitch chat for the broadcaster or a viewer who was lurking, stepped away, or could not keep up with chat.

Your job is to tell them what they actually missed.

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
If someone says "you almost have 200 on Twitch," you may say "they noted the channel is almost at 200 on Twitch."
Do NOT change it to "200 followers," "200 viewers," "200 subscribers," or another interpretation unless the chat explicitly says what 200 refers to.

MESSAGE ORDER AND RECENCY:
- The supplied messages are ordered from older to newer within one recent chat window.
- Message order indicates recency, NOT a narrative timeline.
- Do NOT use words such as "later," "earlier," "afterward," "subsequently," "eventually," "then," or "before that" merely because one message appears after another.
- Do not imply that separate topics happened in distinct chronological phases unless the chat explicitly establishes that sequence.
- Prefer neutral connectors such as "also," "while," "and," or "meanwhile" when combining topics.
- Messages near the bottom are simply the most recent messages in the supplied chat window.
- If recency itself matters, say "more recently" or "in the most recent messages," but only when useful.

OPTIONAL VIBE OPENER:
- You MAY begin with one very short description of the overall chat mood or vibe if it is strongly and clearly supported by many messages.
- Keep it extremely short, ideally only a few words.
- Example: "Chat is playful and competitive, ..."
- Do not use a vibe opener if it would crowd out useful concrete information.
- Avoid generic phrases such as "fun and lively," "good vibes," "friendly banter," or "supportive atmosphere."
- If the specific recap already makes the mood obvious, skip the vibe description entirely.

PRIORITIZE CONCRETE DETAILS:
- Mention specific usernames when their comment, opinion, joke, question, story, or reaction is notable.
- Mention specific people, games, characters, Pokémon, items, events, strategies, or other named topics when clearly stated.
- Capture notable opinions, disagreements, debates, questions, predictions, suggestions, decisions, and reactions.
- Mention recurring jokes, callbacks, stream lore, or memorable comments when clearly supported by chat.
- If chat is reacting to something, describe only what the messages actually establish they are reacting to.
- Combine related comments efficiently, but do not merge unrelated comments into a new claim.

AVOID VAGUE SUMMARIES:
- Do not waste space describing mood when specific information is available.
- Do not say "viewers discussed strategies" when the specific strategy or opinion is stated.
- Do not say "chat was joking around" when the actual joke can be briefly described.
- Avoid filler such as "friendly banter," "shared support," "good vibes," or similar generic language.
- Do not list usernames merely to include names. Mention them only when tied to a useful detail.

CENSORED CHAT:
- Some messages may contain the literal text "[censored]".
- Keep surrounding context when useful.
- Do not guess, restore, reconstruct, or repeat the censored word.
- It is okay to omit the censored detail entirely.

BEFORE WRITING THE RECAP:
Internally identify the concrete claims, questions, opinions, jokes, and events that are explicitly supported by the chat.
Then write the recap using ONLY those supported details.
Do not output your analysis or evidence list.
Output only the final recap.

LENGTH AND ENDING:
- You have exactly ${SUMMARY_TEXT_LIMIT} characters available for the recap text.
- Aim to use most of those ${SUMMARY_TEXT_LIMIT} characters when there are enough useful, well-supported details.
- NEVER exceed ${SUMMARY_TEXT_LIMIT} characters.
- Every sentence must be complete.
- Never end with "..." or an unfinished thought.
- Never begin another topic unless you have enough room to finish that thought.
- If there is not enough room for another complete topic, omit that topic entirely.
- Prefer fewer complete, useful details over squeezing in one additional incomplete detail.
- Do not sacrifice factual accuracy or sentence completeness just to get closer to the character limit.

STYLE:
- Write 2 to 4 compact sentences when useful.
- Be information-dense but natural and readable.
- No hashtags.
- Do not start with "Chat Recap:" because the bot adds it separately.
- Do not start with "AI Summary:".
- Never add assumptions, filler, inferred context, or fake chronology just to make the recap longer.
- A shorter complete recap is better than a longer recap with an unfinished final thought.

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
      `Gemini returned an invalid JSON response. HTTP ${response.status}`
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
      if (step?.type !== 'model_output' || !Array.isArray(step.content)) {
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
// SAFE COMPLETE-SENTENCE LIMIT
// ==========================================

function enforceSummaryLimit(summary) {
  if (summary.length <= SUMMARY_TEXT_LIMIT) {
    return summary;
  }

  const withinLimit = summary.substring(0, SUMMARY_TEXT_LIMIT);

  const sentenceEndings = [
    withinLimit.lastIndexOf('.'),
    withinLimit.lastIndexOf('?'),
    withinLimit.lastIndexOf('!')
  ];

  const lastSentenceEnd = Math.max(...sentenceEndings);

  /*
   * If at least one complete sentence exists inside the limit,
   * drop everything after that sentence.
   *
   * No "..." is added.
   */
  if (lastSentenceEnd >= 0) {
    return withinLimit
      .substring(0, lastSentenceEnd + 1)
      .trim();
  }

  /*
   * Extremely unlikely fallback:
   * Gemini produced >488 chars with no sentence punctuation.
   *
   * Cut at the last space so we don't split a word.
   */
  const lastSpace = withinLimit.lastIndexOf(' ');

  if (lastSpace > 0) {
    return withinLimit.substring(0, lastSpace).trim();
  }

  return withinLimit.trim();
}

// ==========================================
// GENERATE RECAP
// ==========================================

async function generateRecap(chatLogs) {
  if (!Array.isArray(chatLogs) || chatLogs.length === 0) {
    throw new Error('No chat logs were provided to Gemini.');
  }

  const sanitization = sanitizeChatForGemini(chatLogs);

  if (sanitization.sanitized) {
    console.log(
      `[Gemini] Sanitized ${sanitization.censoredCount} sensitive term(s) across ` +
      `${sanitization.affectedMessages} message(s).`
    );
  }

  let data;

  try {
    data = await callGemini(sanitization.logs);
  } catch (err) {
    const message = err.message || '';

    const inputBlocked =
      message.includes('Input blocked') ||
      message.includes('sensitive words') ||
      message.includes('Prohibited Use policy');

    if (inputBlocked) {
      const blockedError = new Error(
        'Gemini blocked the chat input even after sensitive-term redaction. ' +
        'One or more messages may contain content that cannot be submitted.'
      );

      blockedError.inputBlocked = true;
      blockedError.sanitization = sanitization;

      throw blockedError;
    }

    throw err;
  }

  let summary = extractGeminiText(data);

  if (!summary) {
    console.error(
      '[Gemini Unexpected Response]',
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      'Gemini returned a successful response but no readable text output was found.'
    );
  }

  // Prevent duplicate prefixes.
  summary = summary.replace(/^AI Summary:\s*/i, '');
  summary = summary.replace(/^Chat Recap:\s*/i, '');

  // Remove trailing ellipsis if Gemini ignored the prompt.
  if (/\.{3}\s*$/.test(summary)) {
    const withoutEllipsis = summary.replace(/\s*\.{3}\s*$/, '');
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

  // Hard safety limit without chopping a sentence.
  summary = enforceSummaryLimit(summary);

  console.log('[Gemini Recap]', summary);
  console.log(
    `[Gemini Recap Length] ${summary.length}/${SUMMARY_TEXT_LIMIT} text characters`
  );

  return {
    summary,
    sanitization
  };
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ==========================================
// WEB DASHBOARD
// ==========================================

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>SqwertArmyBot Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <style>
    body {
      font-family: Arial, sans-serif;
      background: #0f0f12;
      color: #fff;
      padding: 20px;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 80vh;
      margin: 0;
    }

    .card {
      background: #18181b;
      border: 1px solid #26262c;
      border-radius: 8px;
      padding: 24px;
      width: 100%;
      max-width: 650px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    }

    h2 {
      margin-top: 0;
      color: #9146ff;
    }

    p {
      color: #adadb8;
      font-size: 14px;
    }

    label {
      display: block;
      font-size: 12px;
      color: #adadb8;
      margin-bottom: 6px;
    }

    input, textarea {
      width: 100%;
      padding: 12px;
      border-radius: 4px;
      border: 1px solid #3a3a44;
      background: #0e0e10;
      color: #fff;
      box-sizing: border-box;
      font-size: 14px;
    }

    input {
      margin-bottom: 16px;
    }

    textarea {
      min-height: 300px;
      resize: vertical;
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
      line-height: 1.4;
      margin-bottom: 8px;
    }

    button {
      width: 100%;
      padding: 12px;
      background: #9146ff;
      border: none;
      color: white;
      border-radius: 4px;
      font-weight: bold;
      cursor: pointer;
      font-size: 14px;
      margin-bottom: 8px;
    }

    button:hover {
      background: #772ce8;
    }

    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .test-buttons {
      display: flex;
      gap: 8px;
    }

    .test-buttons button,
    #testPastedBtn {
      background: #2f2f38;
    }

    .test-buttons button:hover,
    #testPastedBtn:hover {
      background: #3f3f4a;
    }

    .divider {
      border: 0;
      border-top: 1px solid #26262c;
      margin: 20px 0;
    }

    .section-title {
      color: #adadb8;
      font-size: 12px;
      font-weight: bold;
      margin-bottom: 10px;
    }

    .hint {
      color: #777783;
      font-size: 11px;
      margin: 0 0 10px;
      line-height: 1.4;
    }

    #status, #testResult {
      margin-top: 12px;
      font-size: 13px;
      word-break: break-word;
    }

    #testResult {
      background: #0e0e10;
      border-radius: 4px;
      padding: 12px;
      display: none;
      line-height: 1.45;
    }

    .char-count {
      display: block;
      color: #777783;
      margin-top: 8px;
      font-size: 11px;
    }

    .sanitized-warning {
      display: block;
      color: #f5c542;
      margin-top: 10px;
      font-size: 11px;
    }

    @media (max-width: 550px) {
      .test-buttons {
        flex-direction: column;
        gap: 0;
      }
    }
  </style>
</head>

<body>
  <div class="card">
    <h2>SqwertArmyBot Control</h2>

    <p>
      Sending to channel:
      <strong>#${channelName || 'Not configured'}</strong>
    </p>

    <label for="passwordInput">Password</label>

    <input
      type="password"
      id="passwordInput"
      placeholder="Enter password..."
      autocomplete="current-password"
    >

    <form id="chatForm">
      <label for="messageInput">Message to Twitch</label>

      <input
        type="text"
        id="messageInput"
        placeholder="Type a message..."
        autocomplete="off"
      >

      <button type="submit" id="sendChatBtn">
        Send to Chat
      </button>
    </form>

    <div id="status"></div>

    <hr class="divider">

    <div class="section-title">AI Summary Testing</div>

    <div class="test-buttons">
      <button type="button" id="testSampleBtn">
        Test Sample Chat
      </button>

      <button type="button" id="testStoredBtn">
        Test Stored Chat
      </button>
    </div>

    <hr class="divider">

    <div class="section-title">Test Pasted Render Logs</div>

    <p class="hint">
      Paste Twitch chat lines from Render here. Nightbot, StreamElements,
      and ${botUsername || 'TWITCH_BOT_USERNAME'} are ignored automatically.
      If more than 100 valid chat messages are found, only the 100 most recent
      are sent to Gemini.
    </p>

    <textarea
      id="pastedChatInput"
      placeholder="Paste Render / Twitch chat logs here..."
    ></textarea>

    <button type="button" id="testPastedBtn">
      Test Pasted Chat
    </button>

    <div id="testResult"></div>
  </div>

  <script>
    const passwordInput = document.getElementById('passwordInput');
    const messageInput = document.getElementById('messageInput');
    const pastedChatInput = document.getElementById('pastedChatInput');

    const sendChatBtn = document.getElementById('sendChatBtn');
    const testSampleBtn = document.getElementById('testSampleBtn');
    const testStoredBtn = document.getElementById('testStoredBtn');
    const testPastedBtn = document.getElementById('testPastedBtn');

    const status = document.getElementById('status');
    const testResult = document.getElementById('testResult');

    document.getElementById('chatForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const password = passwordInput.value;
      const message = messageInput.value.trim();

      if (!password || !message) {
        return;
      }

      status.style.color = '#adadb8';
      status.textContent = 'Sending...';
      sendChatBtn.disabled = true;

      try {
        const response = await fetch('/send-chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ password, message })
        });

        const data = await response.json();

        if (data.success) {
          status.style.color = '#00f59b';
          status.textContent = 'Sent to chat!';
          messageInput.value = '';
        } else {
          status.style.color = '#ff4f4f';
          status.textContent = 'Error: ' + getErrorMessage(data.error);
        }
      } catch (err) {
        status.style.color = '#ff4f4f';
        status.textContent = 'Failed to reach server.';
      } finally {
        sendChatBtn.disabled = false;
      }
    });

    async function runSummaryTest(type) {
      const password = passwordInput.value;

      if (!password) {
        alert('Please enter the dashboard password first.');
        return;
      }

      if (type === 'pasted' && !pastedChatInput.value.trim()) {
        alert('Paste some Render chat logs first.');
        return;
      }

      setTestButtonsDisabled(true);

      testResult.style.display = 'block';
      testResult.style.color = '#adadb8';

      if (type === 'sample') {
        testResult.textContent = 'Generating summary from sample chat...';
      } else if (type === 'stored') {
        testResult.textContent = 'Generating summary from stored chat...';
      } else {
        testResult.textContent = 'Parsing logs and generating summary...';
      }

      try {
        const body = { password, type };

        if (type === 'pasted') {
          body.pastedChat = pastedChatInput.value;
        }

        const response = await fetch('/test-summary', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });

        const data = await response.json();

        if (data.success) {
          testResult.style.color = '#fff';

          let sourceText = 'Sample chat';

          if (data.source === 'stored') {
            sourceText =
              'Stored chat (' +
              data.messageCount +
              ' messages)';
          }

          if (data.source === 'pasted') {
            sourceText =
              'Pasted chat (' +
              data.messageCount +
              ' messages used';

            if (data.totalValidMessages > data.messageCount) {
              sourceText +=
                ' of ' +
                data.totalValidMessages +
                ' valid messages';
            }

            sourceText += ')';
          }

          let sanitizationText = '';

          if (data.sanitized) {
            sanitizationText =
              '<span class="sanitized-warning">' +
              '⚠ Sensitive chat text was redacted before being sent to Gemini: ' +
              data.censoredCount +
              ' term(s) across ' +
              data.affectedMessages +
              ' message(s).' +
              '</span>';
          }

          testResult.innerHTML =
            '<strong style="color:#00f59b;">' +
            escapeHtml(sourceText) +
            '</strong><br><br>' +
            escapeHtml(data.output) +
            '<span class="char-count">' +
            data.characterCount +
            ' / 500 characters' +
            '</span>' +
            sanitizationText;
        } else {
          testResult.style.color = '#ff4f4f';
          testResult.textContent =
            'Error: ' + getErrorMessage(data.error);
        }
      } catch (err) {
        testResult.style.color = '#ff4f4f';
        testResult.textContent = 'Failed to reach server.';
      } finally {
        setTestButtonsDisabled(false);
      }
    }

    function setTestButtonsDisabled(disabled) {
      testSampleBtn.disabled = disabled;
      testStoredBtn.disabled = disabled;
      testPastedBtn.disabled = disabled;
    }

    function getErrorMessage(error) {
      if (!error) return 'Unknown error';
      if (typeof error === 'string') return error;

      return error.message || JSON.stringify(error);
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    testSampleBtn.addEventListener(
      'click',
      () => runSummaryTest('sample')
    );

    testStoredBtn.addEventListener(
      'click',
      () => runSummaryTest('stored')
    );

    testPastedBtn.addEventListener(
      'click',
      () => runSummaryTest('pasted')
    );
  </script>
</body>
</html>
  `);
});

// ==========================================
// PASSWORD HELPER
// ==========================================

function isValidDashboardPassword(password) {
  if (!DASHBOARD_PASSWORD) {
    return false;
  }

  return password === DASHBOARD_PASSWORD;
}

// ==========================================
// SEND CHAT ENDPOINT
// ==========================================

app.post('/send-chat', async (req, res) => {
  const { password, message } = req.body;

  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({
      success: false,
      error: 'DASHBOARD_PASSWORD is not configured on the server.'
    });
  }

  if (!isValidDashboardPassword(password)) {
    return res.status(401).json({
      success: false,
      error: 'Incorrect password!'
    });
  }

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Message cannot be empty.'
    });
  }

  if (!channelName) {
    return res.status(500).json({
      success: false,
      error: 'TWITCH_CHANNEL is not configured.'
    });
  }

  try {
    await client.say(channelName, message.trim());

    return res.json({
      success: true
    });
  } catch (err) {
    console.error('Failed to send message:', err);

    return res.status(500).json({
      success: false,
      error: 'Failed to send to Twitch.'
    });
  }
});

// ==========================================
// SUMMARY TEST ENDPOINT
// ==========================================

app.post('/test-summary', async (req, res) => {
  const { password, type, pastedChat } = req.body;

  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({
      success: false,
      error: 'DASHBOARD_PASSWORD is not configured on the server.'
    });
  }

  if (!isValidDashboardPassword(password)) {
    return res.status(401).json({
      success: false,
      error: 'Incorrect password!'
    });
  }

  const sampleChatLogs = [
    'jebadiahchrist: when will you be continuing the Elden ring run?',
    'motmo_: W dalthecow',
    'dude_theguy: @Motmo_ LUL we have fun here',
    'dalthecow: for gl',
    'nightbot: W dalthecow',
    'coosgoose: W dal',
    'jebadiahchrist: holy shit you almost have 200 on twitch',
    'dude_theguy: W dalthecow',
    'perkinssx: W',
    'heifer54321: WW',
    'dumb_boyy: n opole?',
    'coosgoose: @Motmo_ Hahaha he was a formidable foe, he put in more work than I to be sure'
  ].filter((line) => {
    const username = line.split(':')[0];
    return !isIgnoredUsername(username);
  });

  let logs;
  let source;
  let totalValidMessages;

  if (type === 'stored') {
    if (recentChatLogs.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No stored chat messages are available yet.'
      });
    }

    logs = [...recentChatLogs];
    source = 'stored';
    totalValidMessages = logs.length;
  } else if (type === 'pasted') {
    if (typeof pastedChat !== 'string' || !pastedChat.trim()) {
      return res.status(400).json({
        success: false,
        error: 'No pasted chat logs were provided.'
      });
    }

    const parsed = parsePastedChat(pastedChat);

    if (parsed.logs.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          'No recognizable Twitch chat messages were found. ' +
          'Expected lines such as "<username>: message" or "username: message".'
      });
    }

    logs = parsed.logs;
    source = 'pasted';
    totalValidMessages = parsed.totalValidMessages;
  } else {
    logs = sampleChatLogs;
    source = 'sample';
    totalValidMessages = logs.length;
  }

  try {
    const result = await generateRecap(logs);
    const fullOutput = SUMMARY_PREFIX + result.summary;

    return res.json({
      success: true,
      source,
      messageCount: logs.length,
      totalValidMessages,
      output: fullOutput,
      characterCount: fullOutput.length,
      sanitized: result.sanitization.sanitized,
      censoredCount: result.sanitization.censoredCount,
      affectedMessages: result.sanitization.affectedMessages
    });
  } catch (err) {
    console.error('Summary test error:', err);

    return res.status(500).json({
      success: false,
      error: {
        message: err.message,
        name: err.name,
        details: err.toString(),
        inputBlocked: err.inputBlocked || false
      }
    });
  }
});

// ==========================================
// TWITCH MESSAGE LISTENER
// ==========================================

client.on('message', async (channel, tags, message, self) => {
  if (self) {
    return;
  }

  const rawMessage = (message || '').trim();
  const lowerMsg = rawMessage.toLowerCase();
  const username = (tags.username || '').toLowerCase().trim();
  const displayName = tags['display-name'] || tags.username || 'viewer';
  const now = Date.now();

  if (isIgnoredUsername(username)) {
    return;
  }

  // ==========================================
  // COMMAND: !recap
  // ==========================================

  if (lowerMsg.startsWith('!recap')) {
    const timeElapsed = now - lastRecapUse;

    if (timeElapsed < currentRecapCooldown) {
      const remainingMs = currentRecapCooldown - timeElapsed;
      const minutesLeft = Math.floor(remainingMs / 60000);
      const secondsLeft = Math.floor((remainingMs % 60000) / 1000);

      const timeString = minutesLeft > 0
        ? `${minutesLeft}m ${secondsLeft}s`
        : `${secondsLeft}s`;

      try {
        await client.say(
          channel,
          `@${displayName}, !recap is on cooldown! Try again in ${timeString}.`
        );
      } catch (err) {
        console.error('Failed to send cooldown message:', err);
      }

      return;
    }

    if (recentChatLogs.length < 5) {
      try {
        await client.say(
          channel,
          `@${displayName}, not enough chat history yet to summarize!`
        );
      } catch (err) {
        console.error('Failed to send history warning:', err);
      }

      return;
    }

    lastRecapUse = now;
    currentRecapCooldown = RECAP_SUCCESS_COOLDOWN;

    try {
      const result = await generateRecap(recentChatLogs);
      const twitchMessage = SUMMARY_PREFIX + result.summary;

      console.log(
        `[!recap Output for @${displayName}]:`,
        twitchMessage
      );

      console.log(
        `[!recap Length]: ${twitchMessage.length}/500`
      );

      if (result.sanitization.sanitized) {
        console.log(
          `[!recap Sanitized]: ${result.sanitization.censoredCount} term(s) ` +
          `across ${result.sanitization.affectedMessages} message(s)`
        );
      }

      currentRecapCooldown = RECAP_SUCCESS_COOLDOWN;

      await client.say(channel, twitchMessage);
    } catch (err) {
      console.error('Gemini !recap Error:', err);

      lastRecapUse = Date.now();
      currentRecapCooldown = RECAP_FAILURE_COOLDOWN;

      try {
        if (err.inputBlocked) {
          await client.say(
            channel,
            `@${displayName}, I couldn't summarize that chat because some recent messages were blocked by the AI safety filter. !recap is on a 5-minute cooldown to let chat move on.`
          );
        } else {
          await client.say(
            channel,
            `@${displayName}, failed to generate chat recap. !recap is on a 5-minute cooldown to let chat move on.`
          );
        }
      } catch (sendErr) {
        console.error(
          'Failed to send Gemini error to Twitch:',
          sendErr
        );
      }
    }

    return;
  }

  // ==========================================
  // LOG ORGANIC CHAT MESSAGES
  // ==========================================

  if (rawMessage && !rawMessage.startsWith('!')) {
    recentChatLogs.push(`${displayName}: ${rawMessage}`);

    while (recentChatLogs.length > MAX_LOG_SIZE) {
      recentChatLogs.shift();
    }
  }

  // ==========================================
  // PASSIVE TRIGGERS
  // ==========================================

  if (
    username === 'motmo_' &&
    lowerMsg.includes('hog reveal')
  ) {
    try {
      await client.say(
        channel,
        'Did Motmo_ say.. HOG REVEAL?'
      );
    } catch (err) {
      console.error(
        'Passive trigger error:',
        err
      );
    }
  }
});

// ==========================================
// PROCESS ERROR LOGGING
// ==========================================

process.on('unhandledRejection', (reason) => {
  console.error(
    'Unhandled Promise Rejection:',
    reason
  );
});

process.on('uncaughtException', (err) => {
  console.error(
    'Uncaught Exception:',
    err
  );
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
  console.log('Gemini model: gemini-3.5-flash-lite');

  console.log(
    `Chat recap limit: ${SUMMARY_TEXT_LIMIT} text chars + ` +
    `${SUMMARY_PREFIX.length} prefix chars = ${TWITCH_MESSAGE_LIMIT}`
  );

  console.log('Successful !recap cooldown: 15 minutes');
  console.log('Failed !recap cooldown: 5 minutes');

  if (channelName) {
    console.log(`Twitch channel: #${channelName}`);
  }
});
