const mongoose = require('mongoose');

const twitchBroadcasterAuthSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      default: 'twitch-broadcaster',
      unique: true,
      required: true
    },
    twitchUserId: {
      type: String,
      default: ''
    },
    username: {
      type: String,
      default: ''
    },
    accessToken: {
      type: String,
      required: true
    },
    refreshToken: {
      type: String,
      required: true
    },
    scopes: {
      type: [String],
      default: []
    },
    expiresAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('TwitchBroadcasterAuth', twitchBroadcasterAuthSchema);
