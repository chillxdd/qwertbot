const express = require('express');
const tmi = require('tmi.js');

const {
  createRecapManager,
  generateRecap,
  parsePastedChat,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT,
  MAX_PASTED_MESSAGES
} = require('./commands/recap');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURATION
// ==========================================

const DASHBOARD_PASSWORD =
  process.env.DASHBOARD_PASSWORD;

if (!DASHBOARD_PASSWORD) {
  console.warn(
    'WARNING: DASHBOARD_PASSWORD environment variable is not set.'
  );
}

app.use(
  express.json({
    limit: '1mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '1mb'
  })
);

// ==========================================
// TWITCH CONFIGURATION
// ==========================================

const rawToken =
  (
    process.env
      .TWITCH_BOT_ACCESS_TOKEN ||
    ''
  ).trim();

const pass =
  rawToken.startsWith('oauth:')
    ? rawToken
    : `oauth:${rawToken}`;

const channelName =
  (
    process.env.TWITCH_CHANNEL ||
    ''
  )
    .toLowerCase()
    .trim();

const botUsername =
  (
    process.env
      .TWITCH_BOT_USERNAME ||
    ''
  )
    .toLowerCase()
    .trim();

const client =
  new tmi.Client({
    options: {
      debug: true
    },
    identity: {
      username: botUsername,
      password: pass
    },
    channels: channelName
      ? [channelName]
      : []
  });

// ==========================================
// IGNORED CHAT USERS
// ==========================================

function isIgnoredUsername(
  username
) {
  const ignoredUsers = [
    'nightbot',
    'streamelements',
    botUsername
  ].filter(Boolean);

  return ignoredUsers.includes(
    (username || '')
      .toLowerCase()
      .trim()
  );
}

// ==========================================
// AUTOMATIC RECAP MANAGER
// ==========================================

const recapManager =
  createRecapManager({
    client,
    channelName,
    botUsername,
    twitchAccessToken:
      rawToken
  });

// ==========================================
// TWITCH CONNECTION
// ==========================================

if (
  !rawToken ||
  !channelName ||
  !botUsername
) {
  console.warn(
    'WARNING: Twitch configuration is incomplete.'
  );

  console.warn(
    'Required variables: TWITCH_BOT_ACCESS_TOKEN, TWITCH_CHANNEL, TWITCH_BOT_USERNAME'
  );
} else {
  client
    .connect()
    .then(async () => {
      console.log(
        `Connected to Twitch channel: #${channelName}`
      );

      await recapManager.start();
    })
    .catch((err) => {
      console.error(
        'Failed to connect to Twitch:',
        err
      );
    });
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get(
  '/health',
  (req, res) => {
    res
      .status(200)
      .send('OK');
  }
);

// ==========================================
// WEB DASHBOARD
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

    input,
    textarea {
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

    #status,
    #testResult {
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
      <strong>
        #${channelName || 'Not configured'}
      </strong>
    </p>

    <p>
      Automatic recaps:
      <strong>
        60 min / 150 messages for first recap,
        then every 45 min while Qwert is live.
      </strong>
    </p>

    <label for="passwordInput">
      Password
    </label>

    <input
      type="password"
      id="passwordInput"
      placeholder="Enter password..."
      autocomplete="current-password"
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

    <div id="status"></div>

    <hr class="divider">

    <div class="section-title">
      AI Summary Testing
    </div>

    <div class="test-buttons">
      <button
        type="button"
        id="testSampleBtn"
      >
        Test Sample Chat
      </button>

      <button
        type="button"
        id="testStoredBtn"
      >
        Test Current Recap Window
      </button>
    </div>

    <hr class="divider">

    <div class="section-title">
      Test Pasted Render Logs
    </div>

    <p class="hint">
      Paste Twitch chat lines from Render here.
      Nightbot, StreamElements, and
      ${botUsername || 'TWITCH_BOT_USERNAME'}
      are ignored automatically.
      Pasted tests use the
      ${MAX_PASTED_MESSAGES}
      most recent valid messages.
    </p>

    <textarea
      id="pastedChatInput"
      placeholder="Paste Render / Twitch chat logs here..."
    ></textarea>

    <button
      type="button"
      id="testPastedBtn"
    >
      Test Pasted Chat
    </button>

    <div id="testResult"></div>
  </div>

  <script>
    const passwordInput =
      document.getElementById(
        'passwordInput'
      );

    const messageInput =
      document.getElementById(
        'messageInput'
      );

    const pastedChatInput =
      document.getElementById(
        'pastedChatInput'
      );

    const sendChatBtn =
      document.getElementById(
        'sendChatBtn'
      );

    const testSampleBtn =
      document.getElementById(
        'testSampleBtn'
      );

    const testStoredBtn =
      document.getElementById(
        'testStoredBtn'
      );

    const testPastedBtn =
      document.getElementById(
        'testPastedBtn'
      );

    const status =
      document.getElementById(
        'status'
      );

    const testResult =
      document.getElementById(
        'testResult'
      );

    document
      .getElementById(
        'chatForm'
      )
      .addEventListener(
        'submit',
        async (e) => {
          e.preventDefault();

          const password =
            passwordInput.value;

          const message =
            messageInput.value.trim();

          if (
            !password ||
            !message
          ) {
            return;
          }

          status.style.color =
            '#adadb8';

          status.textContent =
            'Sending...';

          sendChatBtn.disabled =
            true;

          try {
            const response =
              await fetch(
                '/send-chat',
                {
                  method: 'POST',
                  headers: {
                    'Content-Type':
                      'application/json'
                  },
                  body:
                    JSON.stringify({
                      password,
                      message
                    })
                }
              );

            const data =
              await response.json();

            if (data.success) {
              status.style.color =
                '#00f59b';

              status.textContent =
                'Sent to chat!';

              messageInput.value =
                '';
            } else {
              status.style.color =
                '#ff4f4f';

              status.textContent =
                'Error: ' +
                getErrorMessage(
                  data.error
                );
            }
          } catch (err) {
            status.style.color =
              '#ff4f4f';

            status.textContent =
              'Failed to reach server.';
          } finally {
            sendChatBtn.disabled =
              false;
          }
        }
      );

    async function runSummaryTest(
      type
    ) {
      const password =
        passwordInput.value;

      if (!password) {
        alert(
          'Please enter the dashboard password first.'
        );

        return;
      }

      if (
        type === 'pasted' &&
        !pastedChatInput.value.trim()
      ) {
        alert(
          'Paste some Render chat logs first.'
        );

        return;
      }

      setTestButtonsDisabled(
        true
      );

      testResult.style.display =
        'block';

      testResult.style.color =
        '#adadb8';

      if (type === 'sample') {
        testResult.textContent =
          'Generating summary from sample chat...';
      } else if (
        type === 'stored'
      ) {
        testResult.textContent =
          'Generating summary from current automatic recap window...';
      } else {
        testResult.textContent =
          'Parsing logs and generating summary...';
      }

      try {
        const body = {
          password,
          type
        };

        if (
          type === 'pasted'
        ) {
          body.pastedChat =
            pastedChatInput.value;
        }

        const response =
          await fetch(
            '/test-summary',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json'
              },
              body:
                JSON.stringify(
                  body
                )
            }
          );

        const data =
          await response.json();

        if (data.success) {
          testResult.style.color =
            '#fff';

          let sourceText =
            'Sample chat';

          if (
            data.source ===
            'stored'
          ) {
            sourceText =
              'Current recap window (' +
              data.messageCount +
              ' messages)';
          }

          if (
            data.source ===
            'pasted'
          ) {
            sourceText =
              'Pasted chat (' +
              data.messageCount +
              ' messages used';

            if (
              data.totalValidMessages >
              data.messageCount
            ) {
              sourceText +=
                ' of ' +
                data.totalValidMessages +
                ' valid messages';
            }

            sourceText += ')';
          }

          let sanitizationText =
            '';

          if (
            data.sanitized
          ) {
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
            escapeHtml(
              sourceText
            ) +
            '</strong><br><br>' +
            escapeHtml(
              data.output
            ) +
            '<span class="char-count">' +
            data.characterCount +
            ' / 500 characters' +
            '</span>' +
            sanitizationText;
        } else {
          testResult.style.color =
            '#ff4f4f';

          testResult.textContent =
            'Error: ' +
            getErrorMessage(
              data.error
            );
        }
      } catch (err) {
        testResult.style.color =
          '#ff4f4f';

        testResult.textContent =
          'Failed to reach server.';
      } finally {
        setTestButtonsDisabled(
          false
        );
      }
    }

    function setTestButtonsDisabled(
      disabled
    ) {
      testSampleBtn.disabled =
        disabled;

      testStoredBtn.disabled =
        disabled;

      testPastedBtn.disabled =
        disabled;
    }

    function getErrorMessage(
      error
    ) {
      if (!error) {
        return 'Unknown error';
      }

      if (
        typeof error ===
        'string'
      ) {
        return error;
      }

      return (
        error.message ||
        JSON.stringify(error)
      );
    }

    function escapeHtml(
      value
    ) {
      return String(value)
        .replace(
          /&/g,
          '&amp;'
        )
        .replace(
          /</g,
          '&lt;'
        )
        .replace(
          />/g,
          '&gt;'
        )
        .replace(
          /"/g,
          '&quot;'
        )
        .replace(
          /'/g,
          '&#039;'
        );
    }

    testSampleBtn
      .addEventListener(
        'click',
        () =>
          runSummaryTest(
            'sample'
          )
      );

    testStoredBtn
      .addEventListener(
        'click',
        () =>
          runSummaryTest(
            'stored'
          )
      );

    testPastedBtn
      .addEventListener(
        'click',
        () =>
          runSummaryTest(
            'pasted'
          )
      );
  </script>
</body>
</html>
  `);
});

// ==========================================
// PASSWORD HELPER
// ==========================================

function isValidDashboardPassword(
  password
) {
  if (!DASHBOARD_PASSWORD) {
    return false;
  }

  return (
    password ===
    DASHBOARD_PASSWORD
  );
}

// ==========================================
// SEND CHAT ENDPOINT
// ==========================================

app.post(
  '/send-chat',
  async (req, res) => {
    const {
      password,
      message
    } = req.body;

    if (!DASHBOARD_PASSWORD) {
      return res
        .status(500)
        .json({
          success: false,
          error:
            'DASHBOARD_PASSWORD is not configured on the server.'
        });
    }

    if (
      !isValidDashboardPassword(
        password
      )
    ) {
      return res
        .status(401)
        .json({
          success: false,
          error:
            'Incorrect password!'
        });
    }

    if (
      typeof message !==
        'string' ||
      !message.trim()
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            'Message cannot be empty.'
        });
    }

    if (!channelName) {
      return res
        .status(500)
        .json({
          success: false,
          error:
            'TWITCH_CHANNEL is not configured.'
        });
    }

    try {
      await client.say(
        channelName,
        message.trim()
      );

      return res.json({
        success: true
      });
    } catch (err) {
      console.error(
        'Failed to send message:',
        err
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            'Failed to send to Twitch.'
        });
    }
  }
);

// ==========================================
// SUMMARY TEST ENDPOINT
// ==========================================

app.post(
  '/test-summary',
  async (req, res) => {
    const {
      password,
      type,
      pastedChat
    } = req.body;

    if (!DASHBOARD_PASSWORD) {
      return res
        .status(500)
        .json({
          success: false,
          error:
            'DASHBOARD_PASSWORD is not configured on the server.'
        });
    }

    if (
      !isValidDashboardPassword(
        password
      )
    ) {
      return res
        .status(401)
        .json({
          success: false,
          error:
            'Incorrect password!'
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
      const username =
        line.split(':')[0];

      return !isIgnoredUsername(
        username
      );
    });

    let logs;
    let source;
    let totalValidMessages;

    if (type === 'stored') {
      logs =
        recapManager
          .getCurrentWindowLogs();

      if (
        logs.length === 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              'There are currently no messages in the active automatic recap window.'
          });
      }

      source = 'stored';

      totalValidMessages =
        logs.length;
    } else if (
      type === 'pasted'
    ) {
      if (
        typeof pastedChat !==
          'string' ||
        !pastedChat.trim()
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              'No pasted chat logs were provided.'
          });
      }

      const parsed =
        parsePastedChat(
          pastedChat,
          [
            'nightbot',
            'streamelements',
            botUsername
          ]
        );

      if (
        parsed.logs.length ===
        0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              'No recognizable Twitch chat messages were found.'
          });
      }

      logs =
        parsed.logs;

      source =
        'pasted';

      totalValidMessages =
        parsed.totalValidMessages;
    } else {
      logs =
        sampleChatLogs;

      source =
        'sample';

      totalValidMessages =
        logs.length;
    }

    try {
      const result =
        await generateRecap(
          logs
        );

      const fullOutput =
        SUMMARY_PREFIX +
        result.summary;

      return res.json({
        success: true,
        source,
        messageCount:
          logs.length,
        totalValidMessages,
        output:
          fullOutput,
        characterCount:
          fullOutput.length,
        sanitized:
          result.sanitization
            .sanitized,
        censoredCount:
          result.sanitization
            .censoredCount,
        affectedMessages:
          result.sanitization
            .affectedMessages
      });
    } catch (err) {
      console.error(
        'Summary test error:',
        err
      );

      return res
        .status(500)
        .json({
          success: false,
          error: {
            message:
              err.message,
            name:
              err.name,
            details:
              err.toString(),
            inputBlocked:
              err.inputBlocked ||
              false
          }
        });
    }
  }
);

// ==========================================
// TWITCH MESSAGE LISTENER
// ==========================================

client.on(
  'message',
  async (
    channel,
    tags,
    message,
    self
  ) => {
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

    if (
      isIgnoredUsername(
        username
      )
    ) {
      return;
    }

    // ========================================
    // !RECAP NOW REPORTS NEXT AUTO RECAP
    // ========================================

    if (
      lowerMsg ===
        '!recap' ||
      lowerMsg.startsWith(
        '!recap '
      )
    ) {
      await recapManager
        .handleRecapCommand({
          channel,
          displayName
        });

      return;
    }

    // ========================================
    // ORGANIC CHAT
    // ========================================

    recapManager
      .recordChatMessage({
        displayName,
        rawMessage
      });
  }
);

// ==========================================
// PROCESS ERROR LOGGING
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
// START SERVER
// ==========================================

app.listen(
  PORT,
  () => {
    console.log(
      `Web server running on port ${PORT}`
    );

    console.log(
      'Gemini model: gemini-3.5-flash-lite'
    );

    console.log(
      `Twitch chat message limit: ${TWITCH_MESSAGE_LIMIT}`
    );

    console.log(
      'Automatic recap mode enabled.'
    );

    console.log(
      'First recap: 60 minutes or 150 messages.'
    );

    console.log(
      'Recurring recap: every 45 minutes.'
    );

    console.log(
      'Stream detection: Twitch API every 30 seconds.'
    );

    if (channelName) {
      console.log(
        `Twitch channel: #${channelName}`
      );
    }
  }
);
