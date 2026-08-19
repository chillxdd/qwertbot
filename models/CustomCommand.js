const mongoose = require('mongoose');

const customCommandSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  triggerType: {
    type: String,
    enum: ['command', 'inline'],
    required: true,
    default: 'command'
  },
  trigger: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },
  normalizedTrigger: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },
  responses: {
    type: [String],
    required: true,
    validate: {
      validator(values) {
        return Array.isArray(values) && values.length >= 1 && values.length <= 25 && values.every((value) => typeof value === 'string' && value.trim().length >= 1 && value.length <= 500);
      },
      message: 'A command must have 1-25 responses, each between 1 and 500 characters.'
    }
  },
  probability: {
    type: Number,
    min: 0,
    max: 100,
    default: 100
  },
  cooldownSeconds: {
    type: Number,
    min: 0,
    max: 86400,
    default: 0
  },
  enabled: {
    type: Boolean,
    default: true
  },
  counter: {
    type: Number,
    min: 0,
    default: 0
  }
}, {
  timestamps: true
});

customCommandSchema.index(
  { channelName: 1, triggerType: 1, normalizedTrigger: 1 },
  { unique: true }
);

module.exports = mongoose.models.CustomCommand || mongoose.model('CustomCommand', customCommandSchema);
