const express = require('express');
const tmi = require('tmi.js');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Secret Password Configuration
const DASHBOARD_PASSWORD = 'Cf19fdfa34s';

// Middleware to parse incoming JSON & form data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Setup Twitch Client
const rawToken = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').trim();
const pass = rawToken.startsWith('oauth:') ? rawToken : `oauth:${rawToken}`;
const channelName = (process.env.TWITCH_CHANNEL || '').toLowerCase().trim();

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim(),
    password: pass
  },
  channels: [channelName]
});

client.connect().catch(console.error);

// ==========================================
// CHAT LOGGING & COOLDOWN SETTINGS
// ==========================================
const recentChatLogs = [];
const MAX_LOG_SIZE = 50;

// Cooldown tracking for !recap (15 minutes global)
let lastRecapUse = 0;
const RECAP_COOLDOWN = 15 * 60 * 1000; // 15 minutes in milliseconds

// Helper Function for Gemini Recap
async function generateRecap(chatLogs) {
  const chatContext = chatLogs.join('\n');
  const customPrompt = `You are a Twitch stream assistant. Summarize chat sentiment/mood/vibes and what chat has been talking about in 1 to 2 short sentences based on these recent viewer messages. Do not use hashtags. If topics are broad, keep it concise and under 400 characters. Otherwise, try not to add unnecessary details and avoid artificially making it longer than it needs to be. If any sexual discussions are included, make it a family-friendly version:\n\n${chatContext}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: customPrompt
  });

  let summary = response.text ? response.text.trim() : 'Could not generate recap.';
  if (summary.length > 400) {
    summary = summary.substring(0, 397) + '...';
  }
  return summary;
}

// 1. Health check endpoint for UptimeRobot
app.get('/health', (req, res) => res.status(200).send('OK'));

// 2. Web UI (Dashboard with Gemini Test Button)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>SqwertArmyBot Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: Arial, sans-serif; background: #0f0f12; color: #fff; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; margin: 0; }
        .card { background: #18181b; border: 1px solid #26262c; border-radius: 8px; padding: 24px; width: 100%; max-width: 450px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
        h2 { margin-top: 0; color: #9146ff; }
        p { color: #adadb8; font-size: 14px; }
        input { width: 100%; padding: 12px; margin: 8px 0 16px 0; border-radius: 4px; border: 1px solid #3a3a44; background: #0e0e10; color: #fff; box-sizing: border-box; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #9146ff; border: none; color: white; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 14px; margin-bottom: 8px; }
        button:hover { background: #772ce8; }
        .btn-test { background: #2f2f38; }
        .btn-test:hover { background: #3f3f4a; }
        #status, #testResult { margin-top: 12px; font-size: 13px; word-break: break-word; }
        pre { background: #0e0e10; padding: 10px; border-radius: 4px; color: #adadb8; white-space: pre-wrap; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>SqwertArmyBot Control</h2>
        <p>Sending to channel: <strong>#${channelName}</strong></p>
        
        <label style="font-size: 12px; color: #adadb8;">Password</label>
        <input type="password" id="passwordInput" placeholder="Enter password..." required />

        <form id="chatForm">
          <label style="font-size: 12px; color: #adadb8;">Message to Twitch</label>
          <input type="text" id="messageInput" placeholder="Type a message..." autocomplete="off" />
          <button type="submit">Send to Chat</button>
        </form>

        <hr style="border: 0; border-top: 1px solid #26262c; margin: 16px 0;">

        <button type="button" class="btn-test" id="testGeminiBtn">⚡ Test Gemini API Connection</button>

        <div id="status"></div>
        <div id="testResult"></div>
      </div>

      <script>
        const passwordInput = document.getElementById('passwordInput');
        const status = document.getElementById('status');
        const testResult = document.getElementById('testResult');

        document.getElementById('chatForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const password = passwordInput.value;
          const input = document.getElementById('messageInput');
          const message = input.value.trim();
          
          if (!message || !password) return;

          status.style.color = '#adadb8';
          status.textContent = 'Sending...';

          try {
            const res = await fetch('/send-chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password, message })
            });
            const data = await res.json();
            
            if (data.success) {
              status.style.color = '#00f59b';
              status.textContent = 'Sent to chat!';
              input.value = '';
            } else {
              status.style.color = '#ff4f4f';
              status.textContent = 'Error: ' + data.error;
            }
          } catch (err) {
            status.style.color = '#ff4f4f';
            status.textContent = 'Failed to reach server.';
          }
        });

        document.getElementById('testGeminiBtn').addEventListener('click', async () => {
          const password = passwordInput.value;
          if (!password) {
            alert('Please enter the password first.');
            return;
          }

          testResult.innerHTML = '<span style="color: #adadb8;">Testing Gemini API...</span>';

          try {
            const res = await fetch('/test-gemini', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password })
            });
            const data = await res.json();

            if (data.success) {
              testResult.innerHTML = '<strong style="color: #00f59b;">API Success!</strong><pre>' + data.output + '</pre>';
            } else {
              testResult.innerHTML = '<strong style="color: #ff4f4f;">API Error Details:</strong><pre>' + JSON.stringify(data.error, null, 2) + '</pre>';
            }
          } catch (err) {
            testResult.innerHTML = '<span style="color: #ff4f4f;">Failed to connect to backend endpoint.</span>';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// 3. Protected Dashboard API Endpoint: Send Chat
app.post('/send-chat', (req, res) => {
  const { password, message } = req.body;

  if (password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

  if (!message) {
    return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
  }

  client.say(channelName, message)
    .then(() => res.json({ success: true }))
    .catch((err) => {
      console.error('Failed to send message:', err);
      res.status(500).json({ success: false, error: 'Failed to send to Twitch.' });
    });
});

// 4. Protected Dashboard API Endpoint: Test Gemini Directly
app.post('/test-gemini', async (req, res) => {
  const { password } = req.body;

  if (password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

  const dummyChatLogs = [
    'Viewer1: Hey everyone! Great stream today!',
    'Viewer2: What game are we playing next?',
    'Viewer3: The gameplay earlier was insane lmao',
    'Viewer4: vibing in chat, hype stream!',
    'Viewer5: GGs in chat!'
  ];

  try {
    const summary = await generateRecap(dummyChatLogs);
    res.json({ success: true, output: summary });
  } catch (err) {
    console.error('Test Gemini Error:', err);
    res.status(500).json({ 
      success: false, 
      error: {
        message: err.message,
        name: err.name,
        status: err.status || undefined,
        details: err.toString()
      }
    });
  }
});

// 5. Twitch Chat Message Listener
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const rawMessage = message.trim();
  const lowerMsg = rawMessage.toLowerCase();
  const username = tags.username.toLowerCase();
  const displayName = tags['display-name'] || tags.username;
  const now = Date.now();

  // Ignore Nightbot, StreamElements, or your own bot account
  const ignoredBots = [
    'nightbot', 
    'streamelements', 
    (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim()
  ];
  if (ignoredBots.includes(username)) return;

  // ==========================================
  // COMMAND: !recap (15 MIN COOLDOWN)
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

      client.say(channel, `@${displayName}, !recap is on cooldown! Try again in ${timeString}.`);
      return;
    }

    if (recentChatLogs.length < 5) {
      client.say(channel, `@${displayName}, not enough chat history yet to summarize!`);
      return;
    }

    lastRecapUse = now;

    try {
      const summary = await generateRecap(recentChatLogs);

      console.log(`[!recap Output for @${displayName}]:`, summary);
      client.say(channel, `[Chat Recap]: ${summary}`);
    } catch (err) {
      console.error('Gemini !recap Error:', err);
      client.say(channel, `@${displayName}, failed to generate chat recap.`);
    }
    return;
  }

  // ==========================================
  // LOG ORGANIC CHAT MESSAGES
  // ==========================================
  if (!rawMessage.startsWith('!')) {
    recentChatLogs.push(`${displayName}: ${rawMessage}`);

    if (recentChatLogs.length > MAX_LOG_SIZE) {
      recentChatLogs.shift();
    }
  }

  // ==========================================
  // PASSIVE TRIGGERS
  // ==========================================
  if (username === 'motmo_' && lowerMsg.includes('hog reveal')) {
    client.say(channel, 'Did Motmo_ say.. HOG REVEAL?');
  }
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
