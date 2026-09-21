const mongoose = require('mongoose');

const youtubeAuthSchema = new mongoose.Schema({
  provider: { type: String, default: 'youtube-bot', unique: true, required: true },
  channelId: { type: String, default: '', trim: true },
  displayName: { type: String, default: '', trim: true },
  accessTokenBox: { type: mongoose.Schema.Types.Mixed, required: true },
  refreshTokenBox: { type: mongoose.Schema.Types.Mixed, required: true },
  scopes: { type: [String], default: [] },
  expiresAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.models.YouTubeAuth || mongoose.model('YouTubeAuth', youtubeAuthSchema);
