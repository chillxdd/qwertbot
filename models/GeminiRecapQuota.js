const mongoose = require('mongoose');

const geminiRecapQuotaSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  model: { type: String, required: true, trim: true },
  pacificDay: { type: String, required: true, trim: true },
  used: { type: Number, default: 0, min: 0 },
  limit: { type: Number, default: 20, min: 1 },
  lastStartedAt: { type: Date, default: null }
}, {
  timestamps: true
});

module.exports = mongoose.models.GeminiRecapQuota || mongoose.model('GeminiRecapQuota', geminiRecapQuotaSchema);
