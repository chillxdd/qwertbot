const mongoose = require('mongoose');

const ACTIVITY_TYPES = ['playing', 'watching', 'listening', 'competing', 'custom', 'none'];

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
  liveActivityType: {
    type: String,
    enum: ACTIVITY_TYPES,
    default: 'watching'
  },
  liveActivityText: {
    type: String,
    trim: true,
    maxlength: 128,
    default: '{category}'
  },
  offlineActivityType: {
    type: String,
    enum: ACTIVITY_TYPES,
    default: 'custom'
  },
  offlineActivityText: {
    type: String,
    trim: true,
    maxlength: 128,
    default: 'GeneralQwert is offline'
  },
  // V34 legacy fields are retained only so an existing saved configuration can
  // be migrated without a manual database change. New saves do not depend on them.
  activityType: {
    type: String,
    enum: ACTIVITY_TYPES,
    required: false
  },
  activityText: {
    type: String,
    trim: true,
    maxlength: 128,
    required: false
  }
}, { timestamps: true });

module.exports = mongoose.models.DiscordPresenceConfig || mongoose.model('DiscordPresenceConfig', discordPresenceConfigSchema);
