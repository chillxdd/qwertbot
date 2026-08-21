const mongoose = require('mongoose');

const automationConfigSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
    index: true
  },
  minimumSpacingSeconds: {
    type: Number,
    default: 30,
    min: 0,
    max: 3600
  },
  lastAutomationAt: {
    type: Date,
    default: null
  },
  lastEngine: {
    type: String,
    enum: ['', 'recap', 'timer', 'eventsub'],
    default: ''
  }
}, { timestamps: true });

module.exports = mongoose.models.AutomationConfig || mongoose.model('AutomationConfig', automationConfigSchema);
