const mongoose = require('mongoose');

const youtubeQuotaUsageSchema = new mongoose.Schema({
  projectKey: { type: String, default: 'youtube', required: true },
  dayKey: { type: String, required: true },
  mainUnits: { type: Number, default: 0, min: 0 },
  searchCalls: { type: Number, default: 0, min: 0 },
  commandMessages: { type: Number, default: 0, min: 0 },
  timerMessages: { type: Number, default: 0, min: 0 },
  discoveryCalls: { type: Number, default: 0, min: 0 },
  streamConnections: { type: Number, default: 0, min: 0 },
  authCalls: { type: Number, default: 0, min: 0 }
}, { timestamps: true });
youtubeQuotaUsageSchema.index({ projectKey: 1, dayKey: 1 }, { unique: true });

module.exports = mongoose.models.YouTubeQuotaUsage || mongoose.model('YouTubeQuotaUsage', youtubeQuotaUsageSchema);
