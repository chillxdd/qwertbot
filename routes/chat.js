function registerChatRoutes(app, { requireModSession, channelName, chatClientProxy }) {
  app.post('/send-chat', requireModSession, async (req, res) => {
    const { message } = req.body;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
    }
    try {
      const sendResult = await chatClientProxy.say(channelName, message.trim());
      return res.json({ success: true, method: sendResult?.method || 'unknown', fallback: Boolean(sendResult?.fallback) });
    } catch (err) {
      console.error('[Chat] Failed to send message:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to send to Twitch.' });
    }
  });
}

module.exports = { registerChatRoutes };
