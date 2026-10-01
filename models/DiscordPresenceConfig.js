const mongoose = require('mongoose');

const discordPresenceConfigSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
    index: true
  },
  status: {
    type: String,
    enum: ['online', 'idle', 'dnd', 'invisible'],
    default: 'online'
  },
  activityType: {
    type: String,
    enum: ['playing', 'watching', 'listening', 'competing', 'none'],
    default: 'watching'
  },
  activityText: {
    type: String,
    trim: true,
    maxlength: 128,
    default: 'GeneralQwert'
  }
}, { timestamps: true });

module.exports = mongoose.models.DiscordPresenceConfig || mongoose.model('DiscordPresenceConfig', discordPresenceConfigSchema);
