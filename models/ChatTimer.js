const mongoose = require('mongoose');

const timerHistorySchema = new mongoose.Schema({
  firedAt: { type: Date, required: true },
  responseIndex: { type: Number, default: -1 },
  response: { type: String, default: '' },
  actionType: { type: String, enum: ['chat_message', 'twitch_announcement'], default: 'chat_message' },
  actionColor: { type: String, enum: ['primary', 'purple', 'blue', 'green', 'orange'], default: 'primary' },
  reason: { type: String, enum: ['scheduled', 'manual'], default: 'scheduled' }
}, { _id: false });

const chatTimerSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  intervalSeconds: {
    type: Number,
    required: true,
    min: 30,
    max: 86400
  },
  startDelaySeconds: {
    type: Number,
    default: null,
    min: 0,
    max: 86400
  },
  minimumChatMessages: {
    type: Number,
    default: 0,
    min: 0,
    max: 100000
  },
  minimumViewers: {
    type: Number,
    default: 0,
    min: 0,
    max: 1000000
  },
  priority: {
    type: String,
    enum: ['high', 'normal', 'low'],
    default: 'normal'
  },
  jitterSeconds: {
    type: Number,
    default: 0,
    min: 0,
    max: 86400
  },
  responses: {
    type: [String],
    required: true,
    validate: {
      validator(values) {
        return Array.isArray(values) && values.length >= 1 && values.length <= 25 && values.every((value) => typeof value === 'string' && value.trim().length >= 1 && value.length <= 500);
      },
      message: 'A timer must have 1-25 actions, each with a message between 1 and 500 characters.'
    }
  },
  responseMode: {
    type: String,
    enum: ['equal', 'weighted'],
    default: 'equal'
  },
  responseWeights: {
    type: [Number],
    default: []
  },
  avoidImmediateRepeat: {
    type: Boolean,
    default: false
  },
  actionTypes: {
    type: [String],
    default: []
  },
  actionColors: {
    type: [String],
    default: []
  },
  enabled: {
    type: Boolean,
    default: true
  },
  scheduleStreamId: { type: String, default: '' },
  lastFiredAt: { type: Date, default: null },
  nextDueAt: { type: Date, default: null },
  timesFired: { type: Number, default: 0, min: 0 },
  lastResponse: { type: String, default: '' },
  lastResponseIndex: { type: Number, default: -1 },
  messagesSinceLastFire: { type: Number, default: 0, min: 0 },
  lastAttemptAt: { type: Date, default: null },
  retryCount: { type: Number, default: 0, min: 0 },
  nextRetryAt: { type: Date, default: null },
  history: { type: [timerHistorySchema], default: [] }
}, { timestamps: true });

chatTimerSchema.index({ channelName: 1, name: 1 });

module.exports = mongoose.models.ChatTimer || mongoose.model('ChatTimer', chatTimerSchema);
