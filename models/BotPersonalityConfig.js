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
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.BotPersonalityConfig || mongoose.model('BotPersonalityConfig', botPersonalityConfigSchema);
