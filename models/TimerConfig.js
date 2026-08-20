const mongoose = require('mongoose');

const timerConfigSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
    index: true
  },
  globalStartDelaySeconds: {
    type: Number,
    default: 0,
    min: 0,
    max: 86400
  },
  minimumSpacingSeconds: {
    type: Number,
    default: 60,
    min: 0,
    max: 3600
  },
  lastTimerMessageAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.models.TimerConfig || mongoose.model('TimerConfig', timerConfigSchema);
