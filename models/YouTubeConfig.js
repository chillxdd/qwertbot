const mongoose = require('mongoose');

const youtubeConfigSchema = new mongoose.Schema({
  channelKey: { type: String, default: 'generalqwert', unique: true, required: true, lowercase: true, trim: true },
  enabled: { type: Boolean, default: true },
  commandsEnabled: { type: Boolean, default: true },
  timersEnabled: { type: Boolean, default: true },
  timerSafetyStopUnits: { type: Number, min: 0, max: 10000, default: 7500 },
  hardSafetyStopUnits: { type: Number, min: 100, max: 10000, default: 9000 },
  searchSafetyStopCalls: { type: Number, min: 1, max: 100, default: 90 }
}, { timestamps: true });

module.exports = mongoose.models.YouTubeConfig || mongoose.model('YouTubeConfig', youtubeConfigSchema);
