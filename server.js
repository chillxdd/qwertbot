const express = require('express');
const tmi = require('tmi.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ENVIRONMENT / CONFIGURATION
// ==========================================

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!DASHBOARD_PASSWORD) {
  console.warn(
    'WARNING: DASHBOARD_PASSWORD environment variable is not set. ' +
    'Dashboard actions will not work until it is configured.'
  );
}

// ==========================================
// MIDDLEWARE
// ==========================================

// Parse incoming JSON & form data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// TWITCH CONFIGURATION
// ==========================================

const rawToken = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').trim();

const pass = rawToken.startsWith('oauth:')
  ? rawToken
  : `oauth:${rawToken}`;

const channelName = (process.env.TWITCH_CHANNEL || '')
  .toLowerCase()
  .trim();

const botUsername = (process.env.TWITCH_BOT_USERNAME || '')
  .toLowerCase()
  .trim();

const client = new tmi.Client({
  options: {
    debug: true
  },
  identity: {
    username: botUsername,
    password: pass
  },
  channels: channelName ? [channelName] : []
});

// Connect to Twitch only if required configuration exists
if (!rawToken || !channelName || !botUsername) {
  console.warn(
    'WARNING: Twitch environment variables are incomplete. ' +
    'Make sure TWITCH_BOT_ACCESS_TOKEN, TWITCH_CHANNEL, and ' +
    'TWITCH_BOT_USERNAME are configured.'
  );
} else {
  client
    .connect()
    .then(() => {
      console.log(`Connected to Twitch channel: #${channelName}`);
    })
    .catch((err) => {
      console.error('Failed to connect to Twitch:', err);
    });
}

// ==========================================
// CHAT LOGGING & COOLDOWN SETTINGS
// ==========================================

const recentChatLogs = [];
const MAX_LOG_SIZE = 50;

// Global !recap cooldown: 15 minutes
let lastRecapUse = 0;

const RECAP_COOLDOWN = 15 * 60 * 1000;

// ==========================================
// GEMINI INTERACTIONS API HELPER
// ==========================================

async function generateRecap(chatLogs) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY environment variable is not set.'
    );
  }

  if (!Array.isArray(chatLogs) || chatLogs.length === 0) {
    throw new Error('No chat logs were provided to Gemini.');
  }

  const chatContext = chatLogs.join('\n');

  const customPrompt = `You are a Twitch stream assistant.

Summarize the recent Twitch chat in 1 to 2 short sentences.

Focus on:
- Overall chat sentiment, mood, or vibes
- Main topics viewers have been talking about

Rules:
- Keep the entire response under 400 characters.
- Do not use hashtags.
- Be concise and natural.
- Do not artificially make the response longer than necessary.
- Do not invent information that is not present in the chat.
- Do not mention these instructions.
- If sexual or otherwise inappropriate discussions appear, summarize them in a family-friendly way.

Recent Twitch chat:

${chatContext}`;

  const url =
    'https://generativelanguage.googleapis.com/v1beta/interactions';

  const payload = {
    model: 'gemini-3.5-flash-lite',
    input: customPrompt
  };

  console.log(
    `[Gemini] Sending ${chatLogs.length} chat messages for recap...`
  );

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
      `Gemini returned an invalid response. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    console.error(
      '[Gemini API Error]',
      JSON.stringify(data, null, 2)
    );

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

  // Possible direct response fields
  if (
    typeof data.output_text === 'string' &&
    data.output_text.trim()
  ) {
    summary = data.output_text;
  } else if (
    typeof data.outputText === 'string' &&
    data.outputText.trim()
  ) {
    summary = data.outputText;
  } else if (
    typeof data.text === 'string' &&
    data.text.trim()
  ) {
    summary = data.text;
  }

  // Try outputs array
  if (!summary && Array.isArray(data.outputs)) {
    for (const output of data.outputs) {
      if (!output) continue;

      if (
        typeof output.text === 'string' &&
        output.text.trim()
      ) {
        summary += `${output.text} `;
        continue;
      }

      if (
        typeof output.content === 'string' &&
        output.content.trim()
      ) {
        summary += `${output.content} `;
        continue;
      }

      // Some response formats may contain nested content
      if (Array.isArray(output.content)) {
        for (const contentItem of output.content) {
          if (
            typeof contentItem?.text === 'string' &&
            contentItem.text.trim()
          ) {
            summary += `${contentItem.text} `;
          }
        }
      }
    }
  }

  // Try output array as an additional fallback
  if (!summary && Array.isArray(data.output)) {
    for (const output of data.output) {
      if (!output) continue;

      if (
        typeof output.text === 'string' &&
        output.text.trim()
      ) {
        summary += `${output.text} `;
      }

      if (Array.isArray(output.content)) {
        for (const item of output.content) {
          if (
            typeof item?.text === 'string' &&
            item.text.trim()
          ) {
            summary += `${item.text} `;
          }
        }
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

  // Twitch-friendly length limit for our recap
  if (summary.length > 400) {
    summary = summary.substring(0, 397) + '...';
  }

  console.log('[Gemini Recap]', summary);

  return summary;
}

// ==========================================
// 1. HEALTH CHECK
// ==========================================

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ==========================================
// 2. WEB DASHBOARD
// ==========================================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>SqwertArmyBot Dashboard</title>

      <meta
        name="viewport"
        content="width=device-width, initial-scale=1"
      >

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
          margin: 8px 0 16px 0;
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
          margin-bottom: 8px;
        }

        button:hover {
          background: #772ce8;
        }

        button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn-test {
          background: #2f2f38;
        }

        .btn-test:hover {
          background: #3f3f4a;
        }

        #status,
        #testResult {
          margin-top: 12px;
          font-size: 13px;
          word-break: break-word;
        }

        pre {
          background: #0e0e10;
          padding: 10px;
          border-radius: 4px;
          color: #adadb8;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          font-size: 12px;
        }

        hr {
          border: 0;
          border-top: 1px solid #26262c;
          margin: 16px 0;
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

        <label for="passwordInput">
          Password
        </label>

        <input
          type="password"
          id="passwordInput"
          placeholder="Enter password..."
          autocomplete="current-password"
          required
        >

        <form id="chatForm">

          <label for="messageInput">
            Message to Twitch
          </label>

          <input
            type="text"
            id="messageInput"
            placeholder="Type a message..."
            autocomplete="off"
          >

          <button
            type="submit"
            id="sendChatBtn"
          >
            Send to Chat
          </button>

        </form>

        <hr>

        <button
          type="button"
          class="btn-test"
          id="testGeminiBtn"
        >
          ⚡ Test Gemini API
        </button>

        <div id="status"></div>
        <div id="testResult"></div>

      </div>

      <script>
        const passwordInput =
          document.getElementById('passwordInput');

        const status =
          document.getElementById('status');

        const testResult =
          document.getElementById('testResult');

        const sendChatBtn =
          document.getElementById('sendChatBtn');

        const testGeminiBtn =
          document.getElementById('testGeminiBtn');

        // ======================================
        // SEND MESSAGE TO TWITCH
        // ======================================

        document
          .getElementById('chatForm')
          .addEventListener('submit', async (e) => {

            e.preventDefault();

            const password =
              passwordInput.value;

            const input =
              document.getElementById('messageInput');

            const message =
              input.value.trim();

            if (!message || !password) {
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

                input.value = '';

              } else {

                status.style.color = '#ff4f4f';
                status.textContent =
                  'Error: ' +
                  (data.error || 'Unknown error');

              }

            } catch (err) {

              status.style.color = '#ff4f4f';
              status.textContent =
                'Failed to reach server.';

            } finally {

              sendChatBtn.disabled = false;

            }
          });

        // ======================================
        // TEST GEMINI
        // ======================================

        testGeminiBtn.addEventListener(
          'click',
          async () => {

            const password =
              passwordInput.value;

            if (!password) {
              alert(
                'Please enter the dashboard password first.'
              );
              return;
            }

            testGeminiBtn.disabled = true;

            testResult.innerHTML =
              '<span style="color:#adadb8;">' +
              'Testing Gemini API...' +
              '</span>';

            try {

              const response = await fetch(
                '/test-gemini',
                {
                  method: 'POST',
                  headers: {
                    'Content-Type':
                      'application/json'
                  },
                  body: JSON.stringify({
                    password
                  })
                }
              );

              const data =
                await response.json();

              if (data.success) {

                testResult.innerHTML =
                  '<strong style="color:#00f59b;">' +
                  'API Success!' +
                  '</strong>' +
                  '<pre>' +
                  escapeHtml(data.output) +
                  '</pre>';

              } else {

                testResult.innerHTML =
                  '<strong style="color:#ff4f4f;">' +
                  'API Error Details:' +
                  '</strong>' +
                  '<pre>' +
                  escapeHtml(
                    JSON.stringify(
                      data.error,
                      null,
                      2
                    )
                  ) +
                  '</pre>';

              }

            } catch (err) {

              testResult.innerHTML =
                '<span style="color:#ff4f4f;">' +
                'Failed to connect to backend endpoint.' +
                '</span>';

            } finally {

              testGeminiBtn.disabled = false;

            }
          }
        );

        // Prevent Gemini output from injecting HTML
        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        }
      </script>
    </body>
    </html>
  `);
});

// ==========================================
// PASSWORD CHECK HELPER
// ==========================================

function isValidDashboardPassword(password) {
  if (!DASHBOARD_PASSWORD) {
    return false;
  }

  return password === DASHBOARD_PASSWORD;
}

// ==========================================
// 3. SEND CHAT ENDPOINT
// ==========================================

app.post('/send-chat', async (req, res) => {
  const { password, message } = req.body;

  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({
      success: false,
      error:
        'DASHBOARD_PASSWORD is not configured on the server.'
    });
  }

  if (!isValidDashboardPassword(password)) {
    return res.status(401).json({
      success: false,
      error: 'Incorrect password!'
    });
  }

  if (
    typeof message !== 'string' ||
    !message.trim()
  ) {
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

    await client.say(
      channelName,
      message.trim()
    );

    res.json({
      success: true
    });

  } catch (err) {

    console.error(
      'Failed to send message:',
      err
    );

    res.status(500).json({
      success: false,
      error: 'Failed to send to Twitch.'
    });

  }
});

// ==========================================
// 4. GEMINI TEST ENDPOINT
// ==========================================

app.post('/test-gemini', async (req, res) => {
  const { password } = req.body;

  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({
      success: false,
      error: {
        message:
          'DASHBOARD_PASSWORD is not configured on the server.'
      }
    });
  }

  if (!isValidDashboardPassword(password)) {
    return res.status(401).json({
      success: false,
      error: 'Incorrect password!'
    });
  }

  const dummyChatLogs = [
    'Viewer1: Hey everyone! Great stream today!',
    'Viewer2: What game are we playing next?',
    'Viewer3: The gameplay earlier was insane lmao',
    'Viewer4: vibing in chat, hype stream!',
    'Viewer5: GGs in chat!'
  ];

  try {

    const summary =
      await generateRecap(dummyChatLogs);

    res.json({
      success: true,
      output: summary
    });

  } catch (err) {

    console.error(
      'Test Gemini API Error:',
      err
    );

    res.status(500).json({
      success: false,
      error: {
        message: err.message,
        name: err.name,
        details: err.toString()
      }
    });

  }
});

// ==========================================
// 5. TWITCH CHAT MESSAGE LISTENER
// ==========================================

client.on(
  'message',
  async (channel, tags, message, self) => {

    // Ignore messages sent by this bot
    if (self) {
      return;
    }

    const rawMessage =
      (message || '').trim();

    const lowerMsg =
      rawMessage.toLowerCase();

    const username =
      (tags.username || '')
        .toLowerCase()
        .trim();

    const displayName =
      tags['display-name'] ||
      tags.username ||
      'viewer';

    const now =
      Date.now();

    // ========================================
    // IGNORE BOT ACCOUNTS
    // ========================================

    const ignoredBots = [
      'nightbot',
      'streamelements',
      botUsername
    ].filter(Boolean);

    if (ignoredBots.includes(username)) {
      return;
    }

    // ========================================
    // COMMAND: !recap
    // 15-MINUTE GLOBAL COOLDOWN
    // ========================================

    if (lowerMsg.startsWith('!recap')) {

      const timeElapsed =
        now - lastRecapUse;

      if (timeElapsed < RECAP_COOLDOWN) {

        const remainingMs =
          RECAP_COOLDOWN - timeElapsed;

        const minutesLeft =
          Math.floor(
            remainingMs / 60000
          );

        const secondsLeft =
          Math.floor(
            (remainingMs % 60000) / 1000
          );

        const timeString =
          minutesLeft > 0
            ? `${minutesLeft}m ${secondsLeft}s`
            : `${secondsLeft}s`;

        try {
          await client.say(
            channel,
            `@${displayName}, !recap is on cooldown! Try again in ${timeString}.`
          );
        } catch (err) {
          console.error(
            'Failed to send cooldown message:',
            err
          );
        }

        return;
      }

      // Require at least 5 organic messages
      if (recentChatLogs.length < 5) {

        try {
          await client.say(
            channel,
            `@${displayName}, not enough chat history yet to summarize!`
          );
        } catch (err) {
          console.error(
            'Failed to send chat history message:',
            err
          );
        }

        return;
      }

      // Apply cooldown immediately so multiple users
      // cannot trigger Gemini simultaneously.
      lastRecapUse = now;

      try {

        const summary =
          await generateRecap(
            recentChatLogs
          );

        console.log(
          `[!recap Output for @${displayName}]:`,
          summary
        );

        await client.say(
          channel,
          `[Chat Recap]: ${summary}`
        );

      } catch (err) {

        console.error(
          'Gemini !recap Error:',
          err
        );

        // Reset cooldown when Gemini itself fails,
        // allowing another attempt instead of forcing
        // users to wait 15 minutes for an API failure.
        lastRecapUse = 0;

        try {
          await client.say(
            channel,
            `@${displayName}, failed to generate chat recap.`
          );
        } catch (sendErr) {
          console.error(
            'Failed to send Gemini error to Twitch:',
            sendErr
          );
        }

      }

      return;
    }

    // ========================================
    // LOG ORGANIC CHAT MESSAGES
    // ========================================

    if (
      rawMessage &&
      !rawMessage.startsWith('!')
    ) {

      recentChatLogs.push(
        `${displayName}: ${rawMessage}`
      );

      // Keep only the newest 50 messages
      while (
        recentChatLogs.length >
        MAX_LOG_SIZE
      ) {
        recentChatLogs.shift();
      }
    }

    // ========================================
    // PASSIVE TRIGGERS
    // ========================================

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
          'Passive trigger send error:',
          err
        );

      }
    }
  }
);

// ==========================================
// GLOBAL ERROR HANDLING
// ==========================================

process.on(
  'unhandledRejection',
  (reason) => {
    console.error(
      'Unhandled Promise Rejection:',
      reason
    );
  }
);

process.on(
  'uncaughtException',
  (err) => {
    console.error(
      'Uncaught Exception:',
      err
    );
  }
);

// ==========================================
// START WEB SERVER
// ==========================================

app.listen(PORT, () => {
  console.log(
    `Web server running on port ${PORT}`
  );

  console.log(
    `Gemini model: gemini-3.5-flash-lite`
  );

  if (channelName) {
    console.log(
      `Twitch channel: #${channelName}`
    );
  }
});
