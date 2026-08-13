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

let botConnected = false;

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
// MOD / BROADCASTER CHECK
// ==========================================

function isModOrBroadcaster(
  tags
) {
  const badges =
    tags.badges || {};

  const isBroadcaster =
    badges.broadcaster === '1';

  const isModerator =
    tags.mod === true ||
    badges.moderator === '1';

  return (
    isBroadcaster ||
    isModerator
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

client.on(
  'connected',
  () => {
    botConnected = true;

    console.log(
      '[Bot] Twitch chat connection is online.'
    );
  }
);

client.on(
  'disconnected',
  (reason) => {
    botConnected = false;

    console.log(
      '[Bot] Twitch chat disconnected:',
      reason
    );
  }
);

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
    .then(
      async () => {
        botConnected = true;

        console.log(
          `Connected to Twitch channel: #${channelName}`
        );

        await recapManager.start();
      }
    )
    .catch(
      (err) => {
        botConnected = false;

        console.error(
          'Failed to connect to Twitch:',
          err
        );
      }
    );
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
// PUBLIC STATUS ENDPOINT
// ==========================================

app.get(
  '/status',
  (req, res) => {
    const recapStatus =
      recapManager.getStatus();

    res.json({
      success: true,

      qwert: {
        live:
          recapStatus.streamLive,

        statusKnown:
          recapStatus
            .streamStateInitialized,

        twitchUrl:
          `https://www.twitch.tv/${channelName}`
      },

      bot: {
        online:
          botConnected,

        loggingMessages:
          recapStatus
            .loggingMessages,

        recapPaused:
          recapStatus
            .recapPaused,

        messagesInWindow:
          recapStatus
            .messagesInWindow,

        recapInProgress:
          recapStatus
            .recapInProgress,

        nextRecapAt:
          recapStatus
            .nextRecapAt,

        pausedRemainingMs:
          recapStatus
            .pausedRemainingMs
      }
    });
  }
);

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
// MOD LOGIN ENDPOINT
// ==========================================

app.post(
  '/mod-login',
  (req, res) => {
    const {
      password
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

    return res.json({
      success: true
    });
  }
);

// ==========================================
// WEB DASHBOARD
// ==========================================

app.get(
  '/',
  (req, res) => {
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
      align-items: flex-start;
      min-height: 100vh;
      margin: 0;
      box-sizing: border-box;
    }

    .card {
      background: #18181b;
      border: 1px solid #26262c;
      border-radius: 8px;
      padding: 24px;
      width: 100%;
      max-width: 700px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      margin-top: 30px;
    }

    h2 {
      margin-top: 0;
      color: #9146ff;
    }

    p {
      color: #adadb8;
      font-size: 14px;
    }

    a {
      color: #bf94ff;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
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
      margin-bottom: 10px;
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

    .status-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin: 20px 0;
    }

    .status-box {
      background: #0e0e10;
      border: 1px solid #26262c;
      border-radius: 6px;
      padding: 14px;
    }

    .status-title {
      color: #777783;
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
      margin-bottom: 7px;
    }

    .status-value {
      font-size: 17px;
      font-weight: bold;
      margin-bottom: 5px;
    }

    .status-detail {
      color: #adadb8;
      font-size: 12px;
      line-height: 1.4;
    }

    .online {
      color: #00f59b;
    }

    .offline {
      color: #ff4f4f;
    }

    .unknown {
      color: #f5c542;
    }

    .logging {
      color: #00f59b;
    }

    .paused {
      color: #f5c542;
    }

    .not-logging {
      color: #adadb8;
    }

    .login-box {
      margin-top: 20px;
      padding: 18px;
      border-radius: 6px;
      border: 1px solid #3a3a44;
      background: #121216;
    }

    .login-title {
      font-weight: bold;
      margin-bottom: 12px;
    }

    #loginStatus,
    #chatStatus,
    #testResult {
      margin-top: 10px;
      font-size: 13px;
      word-break: break-word;
    }

    #protectedControls {
      display: none;
    }

    .divider {
      border: 0;
      border-top: 1px solid #26262c;
      margin: 22px 0;
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

    .logged-in {
      color: #00f59b;
      font-size: 12px;
      margin-bottom: 14px;
    }

    @media (max-width: 600px) {
      .status-grid {
        grid-template-columns: 1fr;
      }

      .test-buttons {
        flex-direction: column;
        gap: 0;
      }
    }
  </style>
</head>

<body>
  <div class="card">
    <h2>SqwertArmyBot</h2>

    <div class="status-grid">
      <div class="status-box">
        <div class="status-title">
          Qwert Status
        </div>

        <div
          id="qwertStatus"
          class="status-value unknown"
        >
          Checking...
        </div>

        <div
          id="qwertStatusDetail"
          class="status-detail"
        >
          Checking Twitch...
        </div>
      </div>

      <div class="status-box">
        <div class="status-title">
          Bot Status
        </div>

        <div
          id="botStatus"
          class="status-value unknown"
        >
          Checking...
        </div>

        <div
          id="botStatusDetail"
          class="status-detail"
        >
          Checking bot...
        </div>
      </div>
    </div>

    <div
      class="login-box"
      id="loginBox"
    >
      <div class="login-title">
        MOD Login
      </div>

      <label for="passwordInput">
        MOD Password
      </label>

      <input
        type="password"
        id="passwordInput"
        placeholder="Enter mod password..."
        autocomplete="current-password"
      >

      <button
        type="button"
        id="loginBtn"
      >
        Login
      </button>

      <div id="loginStatus"></div>
    </div>

    <div id="protectedControls">
      <hr class="divider">

      <div class="logged-in">
        ✓ MOD controls unlocked
      </div>

      <div class="section-title">
        Send Message to Twitch
      </div>

      <form id="chatForm">
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

      <div id="chatStatus"></div>

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
  </div>

  <script>
    let modLoggedIn = false;
    let modPassword = '';
    let autoRefreshTimer = null;

    const passwordInput =
      document.getElementById(
        'passwordInput'
      );

    const loginBtn =
      document.getElementById(
        'loginBtn'
      );

    const loginStatus =
      document.getElementById(
        'loginStatus'
      );

    const loginBox =
      document.getElementById(
        'loginBox'
      );

    const protectedControls =
      document.getElementById(
        'protectedControls'
      );

    const qwertStatus =
      document.getElementById(
        'qwertStatus'
      );

    const qwertStatusDetail =
      document.getElementById(
        'qwertStatusDetail'
      );

    const botStatus =
      document.getElementById(
        'botStatus'
      );

    const botStatusDetail =
      document.getElementById(
        'botStatusDetail'
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

    const chatStatus =
      document.getElementById(
        'chatStatus'
      );

    const testResult =
      document.getElementById(
        'testResult'
      );

    async function updateStatus() {
      try {
        const response =
          await fetch('/status');

        const data =
          await response.json();

        if (!data.success) {
          throw new Error(
            'Status request failed.'
          );
        }

        if (!data.qwert.statusKnown) {
          qwertStatus.textContent =
            'CHECKING';

          qwertStatus.className =
            'status-value unknown';

          qwertStatusDetail.innerHTML =
            '<a href="' +
            escapeHtml(
              data.qwert.twitchUrl
            ) +
            '" target="_blank" rel="noopener noreferrer">' +
            'Open Qwert on Twitch' +
            '</a>';
        } else if (
          data.qwert.live
        ) {
          qwertStatus.textContent =
            'LIVE';

          qwertStatus.className =
            'status-value online';

          qwertStatusDetail.innerHTML =
            '<a href="' +
            escapeHtml(
              data.qwert.twitchUrl
            ) +
            '" target="_blank" rel="noopener noreferrer">' +
            'Watch Qwert on Twitch' +
            '</a>';
        } else {
          qwertStatus.textContent =
            'OFFLINE';

          qwertStatus.className =
            'status-value offline';

          qwertStatusDetail.innerHTML =
            '<a href="' +
            escapeHtml(
              data.qwert.twitchUrl
            ) +
            '" target="_blank" rel="noopener noreferrer">' +
            'Open Qwert on Twitch' +
            '</a>';
        }

        if (data.bot.online) {
          botStatus.textContent =
            'ONLINE';

          botStatus.className =
            'status-value online';
        } else {
          botStatus.textContent =
            'OFFLINE';

          botStatus.className =
            'status-value offline';
        }

        let botDetails = '';

        if (
          data.bot.recapPaused
        ) {
          botDetails =
            '<span class="paused">' +
            'Automatic recaps PAUSED' +
            '</span>' +
            '<br>' +
            data.bot.messagesInWindow +
            ' message(s) preserved';

          if (
            data.bot.pausedRemainingMs !==
            null
          ) {
            botDetails +=
              '<br>Frozen timer: ' +
              formatCountdown(
                data.bot
                  .pausedRemainingMs
              ) +
              ' remaining';
          }
        } else if (
          data.bot.loggingMessages
        ) {
          botDetails =
            '<span class="logging">' +
            'Logging chat for recap' +
            '</span>' +
            '<br>' +
            data.bot.messagesInWindow +
            ' message(s) in current window';

          if (
            data.bot.recapInProgress
          ) {
            botDetails +=
              '<br>Recap is being generated now';
          } else if (
            data.bot.nextRecapAt
          ) {
            botDetails +=
              '<br>Next recap in ' +
              formatCountdown(
                data.bot.nextRecapAt -
                Date.now()
              );
          }
        } else if (
          data.qwert.live
        ) {
          botDetails =
            '<span class="not-logging">' +
            'Not currently logging recap messages' +
            '</span>';
        } else {
          botDetails =
            '<span class="not-logging">' +
            'Waiting for Qwert to go live' +
            '</span>';
        }

        botStatusDetail.innerHTML =
          botDetails;
      } catch (err) {
        qwertStatus.textContent =
          'UNKNOWN';

        qwertStatus.className =
          'status-value unknown';

        qwertStatusDetail.textContent =
          'Could not load Twitch status.';

        botStatus.textContent =
          'UNKNOWN';

        botStatus.className =
          'status-value unknown';

        botStatusDetail.textContent =
          'Could not load bot status.';
      }
    }

    function formatCountdown(
      milliseconds
    ) {
      const totalSeconds =
        Math.max(
          0,
          Math.ceil(
            milliseconds /
            1000
          )
        );

      const minutes =
        Math.floor(
          totalSeconds /
          60
        );

      const seconds =
        totalSeconds %
        60;

      if (minutes > 0) {
        return (
          minutes +
          'min ' +
          seconds +
          's'
        );
      }

      return (
        seconds +
        's'
      );
    }

    function startLoggedOutAutoRefresh() {
      if (
        autoRefreshTimer
      ) {
        clearTimeout(
          autoRefreshTimer
        );
      }

      autoRefreshTimer =
        setTimeout(
          () => {
            if (
              !modLoggedIn
            ) {
              window.location.reload();
            }
          },
          60000
        );
    }

    function stopLoggedOutAutoRefresh() {
      if (
        autoRefreshTimer
      ) {
        clearTimeout(
          autoRefreshTimer
        );

        autoRefreshTimer =
          null;
      }
    }

    async function attemptLogin() {
      const password =
        passwordInput.value;

      if (!password) {
        loginStatus.style.color =
          '#ff4f4f';

        loginStatus.textContent =
          'Enter the MOD password.';

        return;
      }

      loginBtn.disabled =
        true;

      loginStatus.style.color =
        '#adadb8';

      loginStatus.textContent =
        'Logging in...';

      try {
        const response =
          await fetch(
            '/mod-login',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json'
              },
              body:
                JSON.stringify({
                  password
                })
            }
          );

        const data =
          await response.json();

        if (!data.success) {
          loginStatus.style.color =
            '#ff4f4f';

          loginStatus.textContent =
            getErrorMessage(
              data.error
            );

          return;
        }

        modLoggedIn = true;
        modPassword = password;

        passwordInput.value =
          '';

        loginBox.style.display =
          'none';

        protectedControls.style.display =
          'block';

        stopLoggedOutAutoRefresh();

        await updateStatus();
      } catch (err) {
        loginStatus.style.color =
          '#ff4f4f';

        loginStatus.textContent =
          'Failed to reach server.';
      } finally {
        loginBtn.disabled =
          false;
      }
    }

    loginBtn.addEventListener(
      'click',
      attemptLogin
    );

    passwordInput.addEventListener(
      'keydown',
      (event) => {
        if (
          event.key ===
          'Enter'
        ) {
          attemptLogin();
        }
      }
    );

    document
      .getElementById(
        'chatForm'
      )
      .addEventListener(
        'submit',
        async (e) => {
          e.preventDefault();

          if (!modLoggedIn) {
            return;
          }

          const message =
            messageInput.value.trim();

          if (!message) {
            return;
          }

          sendChatBtn.disabled =
            true;

          chatStatus.style.color =
            '#adadb8';

          chatStatus.textContent =
            'Sending...';

          try {
            const response =
              await fetch(
                '/send-chat',
                {
                  method:
                    'POST',

                  headers: {
                    'Content-Type':
                      'application/json'
                  },

                  body:
                    JSON.stringify({
                      password:
                        modPassword,

                      message
                    })
                }
              );

            const data =
              await response.json();

            if (
              data.success
            ) {
              chatStatus.style.color =
                '#00f59b';

              chatStatus.textContent =
                'Sent to chat!';

              messageInput.value =
                '';
            } else {
              chatStatus.style.color =
                '#ff4f4f';

              chatStatus.textContent =
                'Error: ' +
                getErrorMessage(
                  data.error
                );
            }
          } catch (err) {
            chatStatus.style.color =
              '#ff4f4f';

            chatStatus.textContent =
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
      if (!modLoggedIn) {
        return;
      }

      if (
        type ===
          'pasted' &&
        !pastedChatInput
          .value
          .trim()
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

      if (
        type === 'sample'
      ) {
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
          password:
            modPassword,

          type
        };

        if (
          type ===
          'pasted'
        ) {
          body.pastedChat =
            pastedChatInput.value;
        }

        const response =
          await fetch(
            '/test-summary',
            {
              method:
                'POST',

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

        if (
          data.success
        ) {
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

            sourceText +=
              ')';
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
        JSON.stringify(
          error
        )
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

    testSampleBtn.addEventListener(
      'click',
      () =>
        runSummaryTest(
          'sample'
        )
    );

    testStoredBtn.addEventListener(
      'click',
      () =>
        runSummaryTest(
          'stored'
        )
    );

    testPastedBtn.addEventListener(
      'click',
      () =>
        runSummaryTest(
          'pasted'
        )
    );

    updateStatus();

    startLoggedOutAutoRefresh();
  </script>
</body>
</html>
    `);
  }
);

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

    if (
      !DASHBOARD_PASSWORD
    ) {
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

    if (
      !DASHBOARD_PASSWORD
    ) {
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
    ].filter(
      (line) => {
        const username =
          line.split(':')[0];

        return !isIgnoredUsername(
          username
        );
      }
    );

    let logs;
    let source;
    let totalValidMessages;

    if (
      type === 'stored'
    ) {
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

      source =
        'stored';

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
          result
            .sanitization
            .sanitized,

        censoredCount:
          result
            .sanitization
            .censoredCount,

        affectedMessages:
          result
            .sanitization
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
      (message || '')
        .trim();

    const lowerMsg =
      rawMessage
        .toLowerCase();

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
    // MOD: !STOPRECAP
    // ========================================

    if (
      lowerMsg ===
        '!stoprecap'
    ) {
      if (
        !isModOrBroadcaster(
          tags
        )
      ) {
        return;
      }

      await recapManager
        .stopRecap({
          channel,
          displayName
        });

      return;
    }

    // ========================================
    // MOD: !STARTRECAP
    // ========================================

    if (
      lowerMsg ===
        '!startrecap'
    ) {
      if (
        !isModOrBroadcaster(
          tags
        )
      ) {
        return;
      }

      await recapManager
        .startRecap({
          channel,
          displayName
        });

      return;
    }

    // ========================================
    // !RECAP = NEXT AUTO RECAP STATUS
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
      '!recap status cooldown: 5 minutes.'
    );

    console.log(
      '!stoprecap / !startrecap: moderators and broadcaster only.'
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
