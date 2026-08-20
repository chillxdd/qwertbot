const mongoose = require('mongoose');

const customCommandSettingsSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
    index: true
  },
  globalCooldownSeconds: {
    type: Number,
    min: 0,
    max: 86400,
    default: 5
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.CustomCommandSettings || mongoose.model('CustomCommandSettings', customCommandSettingsSchema);
