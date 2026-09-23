const mongoose = require('mongoose');

const youtubeChatTimerSchema = new mongoose.Schema({
  channelKey: { type: String, required: true, lowercase: true, trim: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  intervalSeconds: { type: Number, required: true, min: 30, max: 86400 },
  startDelaySeconds: { type: Number, default: null, min: 0, max: 86400 },
  jitterSeconds: { type: Number, default: 0, min: 0, max: 86400 },
  priority: { type: String, enum: ['high', 'normal', 'low'], default: 'normal' },
  minimumChatMessages: { type: Number, default: 0, min: 0, max: 100000 },
  minimumViewers: { type: Number, default: 0, min: 0, max: 1000000 },
  advancedFilterId: { type: String, default: '', trim: true },
  responses: {
    type: [String], required: true,
    validate: { validator: (values) => Array.isArray(values) && values.length >= 1 && values.length <= 25 && values.every((v) => typeof v === 'string' && v.trim().length && v.length <= 200), message: 'A timer needs 1-25 non-empty responses up to 200 characters each.' }
  },
  responseMode: { type: String, enum: ['equal', 'weighted'], default: 'equal' },
  responseWeights: { type: [Number], default: [] },
  avoidImmediateRepeat: { type: Boolean, default: false },
  lastResponseIndex: { type: Number, default: -1 },
  enabled: { type: Boolean, default: true },
  lastFiredAt: { type: Date, default: null },
  timesFired: { type: Number, default: 0, min: 0 },
  lastResponse: { type: String, default: '' }
}, { timestamps: true });
youtubeChatTimerSchema.index({ channelKey: 1, name: 1 });

module.exports = mongoose.models.YouTubeChatTimer || mongoose.model('YouTubeChatTimer', youtubeChatTimerSchema);
