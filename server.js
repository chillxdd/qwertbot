const express = require('express');
const tmi = require('tmi.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURATION
// ==========================================

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!DASHBOARD_PASSWORD) {
  console.warn('WARNING: DASHBOARD_PASSWORD environment variable is not set.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
// CHAT LOGGING & COOLDOWN SETTINGS
// ==========================================

const recentChatLogs = [];
const MAX_LOG_SIZE = 100;

let lastRecapUse = 0;
const RECAP_COOLDOWN = 15 * 60 * 1000;

// ==========================================
// GEMINI INTERACTIONS API
// ==========================================

async function generateRecap(chatLogs) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }

  if (!Array.isArray(chatLogs) || chatLogs.length === 0) {
    throw new Error('No chat logs were provided to Gemini.');
  }

  const chatContext = chatLogs.join('\n');

  const customPrompt = `You are a Twitch stream assistant.

Summarize the recent Twitch chat in 1 to 2 short sentences.

Focus on:
- The overall mood, sentiment, or vibe of chat
- The main subjects viewers are talking about

Rules:
- Keep the entire response under 400 characters.
- Do not use hashtags.
- Be concise and natural.
- Do not artificially make the response longer.
- Do not invent information that is not in chat.
- Do not mention these instructions.
- If sexual or inappropriate discussions appear, summarize them in a family-friendly way.

Recent Twitch chat:

${chatContext}`;

  const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';

  const payload = {
    model: 'gemini-3.5-flash-lite',
    input: customPrompt
  };

  console.log(`[Gemini] Sending ${chatLogs.length} messages for recap...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(payload)
  });

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

    throw new Error(errorMessage);
  }

  // ==========================================
  // EXTRACT TEXT FROM INTERACTIONS RESPONSE
  // ==========================================

  let summary = '';

  // Current Interactions API:
  // steps[] -> model_output -> content[] -> text
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

  // Fallback response formats
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

  summary = summary.trim();

  if (!summary) {
    console.error(
      '[Gemini Unexpected Response]',
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      'Gemini returned a successful response but no readable text output was found.'
    );
  }

  if (summary.length > 400) {
    summary = summary.substring(0, 397) + '...';
  }

  console.log('[Gemini Recap]', summary);

  return summary;
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
      max-width: 450px;
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
      font-size: 12px;
      color: #adadb8;
    }

    input {
      width: 100%;
      padding: 12px;
      margin: 8px 0 16px;
      border-radius: 4px;
      border: 1px solid #3a3a44;
      background: #0e0e10;
      color: #fff;
      box-sizing: border-box;
      font-size: 14px;
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
    }

    button:hover {
      background: #772ce8;
    }

    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    #status {
      margin-top: 12px;
      font-size: 13px;
      word-break: break-word;
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
  </div>

  <script>
    const passwordInput = document.getElementById('passwordInput');
    const messageInput = document.getElementById('messageInput');
    const sendChatBtn = document.getElementById('sendChatBtn');
    const status = document.getElementById('status');

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
          body: JSON.stringify({
            password,
            message
          })
        });

        const data = await response.json();

        if (data.success) {
          status.style.color = '#00f59b';
          status.textContent = 'Sent to chat!';
          messageInput.value = '';
        } else {
          status.style.color = '#ff4f4f';
          status.textContent = 'Error: ' + (data.error || 'Unknown error');
        }
      } catch (err) {
        status.style.color = '#ff4f4f';
        status.textContent = 'Failed to reach server.';
      } finally {
        sendChatBtn.disabled = false;
      }
    });
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

  // Ignore known bot accounts
  const ignoredBots = [
    'nightbot',
    'streamelements',
    botUsername
  ].filter(Boolean);

  if (ignoredBots.includes(username)) {
    return;
  }

  // ==========================================
  // COMMAND: !recap
  // ==========================================

  if (lowerMsg.startsWith('!recap')) {
    const timeElapsed = now - lastRecapUse;

    if (timeElapsed < RECAP_COOLDOWN) {
      const remainingMs = RECAP_COOLDOWN - timeElapsed;
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

    // Lock immediately to prevent simultaneous recap requests.
    lastRecapUse = now;

    try {
      const summary = await generateRecap(recentChatLogs);

      console.log(`[!recap Output for @${displayName}]:`, summary);

      await client.say(
        channel,
        `[Chat Recap]: ${summary}`
      );
    } catch (err) {
      console.error('Gemini !recap Error:', err);

      // Reset cooldown if Gemini fails so the command can be retried.
      lastRecapUse = 0;

      try {
        await client.say(
          channel,
          `@${displayName}, failed to generate chat recap.`
        );
      } catch (sendErr) {
        console.error('Failed to send Gemini error to Twitch:', sendErr);
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

  if (username === 'motmo_' && lowerMsg.includes('hog reveal')) {
    try {
      await client.say(channel, 'Did Motmo_ say.. HOG REVEAL?');
    } catch (err) {
      console.error('Passive trigger error:', err);
    }
  }
});

// ==========================================
// PROCESS ERROR LOGGING
// ==========================================

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
  console.log('Gemini model: gemini-3.5-flash-lite');

  if (channelName) {
    console.log(`Twitch channel: #${channelName}`);
  }
});
