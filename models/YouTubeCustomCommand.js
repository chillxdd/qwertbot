const mongoose = require('mongoose');

const youtubeCustomCommandSchema = new mongoose.Schema({
  channelKey: { type: String, required: true, lowercase: true, trim: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  publicDescription: { type: String, default: '', trim: true, maxlength: 300 },
  // Multi-trigger representation. YouTube supports !Command triggers only; all
  // triggers on one record share responses, cooldown, counter, and permissions.
  triggers: {
    type: [String],
    default: [],
    validate: {
      validator: (values) => Array.isArray(values) && values.length <= 25 && values.every((v) => typeof v === 'string' && v.trim().length >= 1 && v.length <= 120),
      message: 'A YouTube command can have up to 25 triggers.'
    }
  },
  // Legacy first-trigger fields remain for backwards compatibility and for the
  // historical unique index. New saves mirror triggers[0] into these fields.
  trigger: { type: String, required: true, trim: true, maxlength: 120 },
  normalizedTrigger: { type: String, required: true, trim: true, maxlength: 120 },
  responses: {
    type: [String], required: true,
    validate: { validator: (values) => Array.isArray(values) && values.length >= 1 && values.length <= 25 && values.every((v) => typeof v === 'string' && v.trim().length && v.length <= 200), message: 'A command needs 1-25 non-empty responses up to 200 characters each.' }
  },
  responseMode: { type: String, enum: ['equal', 'weighted'], default: 'equal' },
  responseWeights: { type: [Number], default: [] },
  responseConditions: { type: [String], default: [] },
  avoidImmediateRepeat: { type: Boolean, default: false },
  lastResponseIndex: { type: Number, default: -1 },
  userLevel: { type: String, enum: ['everyone', 'member', 'moderator', 'owner'], default: 'everyone' },
  probability: { type: Number, min: 0, max: 100, default: 100 },
  cooldownSeconds: { type: Number, min: 0, max: 86400, default: 5 },
  cooldownResponse: { type: String, default: '', maxlength: 200 },
  responseDelaySeconds: { type: Number, min: 0, max: 30, default: 0 },
  enabled: { type: Boolean, default: true },
  counter: { type: Number, min: 0, default: 0 }
}, { timestamps: true });
youtubeCustomCommandSchema.index({ channelKey: 1, normalizedTrigger: 1 }, { unique: true });

module.exports = mongoose.models.YouTubeCustomCommand || mongoose.model('YouTubeCustomCommand', youtubeCustomCommandSchema);
