const express = require('express');
const tmi = require('tmi.js');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Keep-Alive Endpoint for UptimeRobot
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

// Clean up token formatting for Twitch IRC
const rawToken = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').trim();
const pass = rawToken.startsWith('oauth:') ? rawToken : `oauth:${rawToken}`;

// 2. Direct Twitch Chat Connection
const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim(),
    password: pass
  },
  channels: [(process.env.TWITCH_CHANNEL || '').toLowerCase().trim()]
});

// Connect and catch connection errors explicitly
client.connect()
  .then(() => console.log('Successfully connected to Twitch chat!'))
  .catch((err) => console.error('Twitch connection failed:', err));

// 3. Independent Chat Listener
client.on('message', (channel, tags, message, self) => {
  if (self) return;

  const msg = message.trim().toLowerCase();
  const username = tags.username.toLowerCase();

  // Command: !hump (Restricted to motmo_)
  if (msg === '!hump') {
    if (username !== 'motmo_') return;

    const roll = Math.random();
    if (roll < 0.5) {
      client.say(channel, 'hump');
    } else {
      client.say(channel, 'no hump');
    }
  }
});
