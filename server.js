const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1. Keep-Alive Endpoint for UptimeRobot
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 2. OAuth Callback Endpoint (Catches redirect from Twitch setup)
app.get('/auth/callback', (req, res) => {
  res.send('Authorization received! You can close this tab.');
});

// 3. Main Command Endpoint for !hump
app.get('/hump', async (req, res) => {
  res.send(' '); // Keeps Nightbot completely silent in chat
  
  const chatterId = req.query.user_id;
  if (!chatterId) return;

  // Roll 1% chance (1 in 100)
  if (Math.random() < 0.01) {
    try {
      // Direct Twitch Helix API call for moderation timeout
      await fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${process.env.TWITCH_BROADCASTER_ID}&moderator_id=${process.env.TWITCH_BOT_USER_ID}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TWITCH_BOT_ACCESS_TOKEN}`,
          'Client-Id': process.env.TWITCH_CLIENT_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: {
            user_id: chatterId,
            duration: 180,
            reason: "pissed me off with !hump"
          }
        })
      });
    } catch (err) {
      console.error('Error executing timeout:', err);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
});
