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
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.BotPersonalityConfig || mongoose.model('BotPersonalityConfig', botPersonalityConfigSchema);
