const mongoose = require('mongoose');

const botPersonalityConfigSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    unique: true,
    index: true,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    default: '',
    maxlength: 80,
    trim: true
  },
  personality: {
    type: String,
    default: '',
    maxlength: 12000
  },
  audience: {
    type: String,
    enum: ['everyone', 'mods'],
    default: 'mods'
  },
  cooldownSeconds: {
    type: Number,
    min: 5,
    max: 86400,
    default: 5
  },
  modsBypassCooldown: {
    type: Boolean,
    default: true
  },
  cooldownResponse: {
    type: String,
    default: '',
    maxlength: 500
  },
  sessionMemory: {
    enabled: { type: Boolean, default: true },
    recentDetailedHours: { type: Number, min: 1, max: 8, default: 2 },
    maxContextCharacters: { type: Number, min: 4000, max: 40000, default: 18000 },
    recentChatMessages: { type: Number, min: 0, max: 100, default: 30 },
    relevantOlderBlocks: { type: Number, min: 0, max: 6, default: 2 },
    promptInstructions: { type: String, default: '', maxlength: 6000 }
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.BotPersonalityConfig || mongoose.model('BotPersonalityConfig', botPersonalityConfigSchema);
