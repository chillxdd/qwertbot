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
const RECAP_COOLDOWN = 15 * 60 * 1000; // 15 minutes (in milliseconds)

// 1. Health check endpoint for UptimeRobot
app.get('/health', (req, res) => res.status(200).send('OK'));

// 2. Web UI (Dashboard)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>SqwertArmyBot Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: Arial, sans-serif; background: #0f0f12; color: #fff; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; margin: 0; }
        .card { background: #18181b; border: 1px solid #26262c; border-radius: 8px; padding: 24px; width: 100%; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
        h2 { margin-top: 0; color: #9146ff; }
        p { color: #adadb8; font-size: 14px; }
        input { width: 100%; padding: 12px; margin: 8px 0 16px 0; border-radius: 4px; border: 1px solid #3a3a44; background: #0e0e10; color: #fff; box-sizing: border-box; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #9146ff; border: none; color: white; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 14px; }
        button:hover { background: #772ce8; }
        #status { margin-top: 12px; font-size: 13px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Chat as SqwertArmyBot</h2>
        <p>Sending to channel: <strong>#${channelName}</strong></p>
        <form id="chatForm">
          <label style="font-size: 12px; color: #adadb8;">Password</label>
          <input type="password" id="passwordInput" placeholder="Enter password..." required />
          
          <label style="font-size: 12px; color: #adadb8;">Message</label>
          <input type="text" id="messageInput" placeholder="Type a message..." required autocomplete="off" />
          
          <button type="submit">Send Message</button>
        </form>
        <div id="status"></div>
      </div>

      <script>
        document.getElementById('chatForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const password = document.getElementById('passwordInput').value;
          const input = document.getElementById('messageInput');
          const status = document.getElementById('status');
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
      </script>
    </body>
    </html>
  `);
});

// 3. Protected Dashboard API Endpoint
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

// 4. Twitch Chat Message Listener
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
    // Silent exit if triggered within 15 minutes of last use
    if (now - lastRecapUse < RECAP_COOLDOWN) return;

    if (recentChatLogs.length < 5) {
      //client.say(channel, `@${displayName}, not enough chat history yet to summarize!`);
      return;
    }

    lastRecapUse = now;

    try {
      const chatContext = recentChatLogs.join('\n');
      const customPrompt = `You are a Twitch stream assistant. Summarize chat sentiment/mood/vibes and what chat has been talking about in 1 to 2 short sentences based on these recent viewer messages. Do not use hashtags. If topics are broad, keep it concise and under 400 characters. Otherwise, try not to add unnecessary details and avoid artificially making it longer than it needs to be. If any sexual discussions are included, make it a family-friendly version:\n\n${chatContext}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: customPrompt
      });

      let summary = response.text ? response.text.trim() : 'Could not generate recap.';
      if (summary.length > 400) {
        summary = summary.substring(0, 397) + '...';
      }

      // 🔍 TEST LOG: Print output to Render logs
      console.log(`[TEST !recap Output for @${displayName}]:`, summary);

      // Send output to Twitch
      //client.say(channel, `[Chat Recap]: ${summary}`);
    } catch (err) {
      console.error('Gemini !recap Error:', err);
    }
    return;
  }

  // ==========================================
  // LOG ORGANIC CHAT MESSAGES
  // ==========================================
  // Store non-command messages into the rolling buffer for !recap
  if (!rawMessage.startsWith('!')) {
    recentChatLogs.push(`${displayName}: ${rawMessage}`);

    if (recentChatLogs.length > MAX_LOG_SIZE) {
      recentChatLogs.shift();
    }
  }
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
