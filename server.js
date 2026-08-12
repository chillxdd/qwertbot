const express = require('express');
const tmi = require('tmi.js');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Keep-Alive Endpoint for UptimeRobot
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// 2. Setup Twitch Client Connection
const rawToken = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').trim();
const pass = rawToken.startsWith('oauth:') ? rawToken : `oauth:${rawToken}`;

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim(),
    password: pass
  },
  channels: [(process.env.TWITCH_CHANNEL || '').toLowerCase().trim()]
});

client.connect().catch(console.error);

// 3. Chat Handler
client.on('message', (channel, tags, message, self) => {
  // Ignore messages sent by the bot itself
  if (self) return;

  const lowerMsg = message.trim().toLowerCase();
  const username = tags.username.toLowerCase();

  // Trigger: Listen for "hog reveal" strictly from motmo_
  if (username === 'motmo_' && lowerMsg.includes('hog reveal')) {
    client.say(channel, 'Did Motmo_ say.. HOG REVEAL?');
  }
});
