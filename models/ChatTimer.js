const mongoose = require('mongoose');

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
  responses: {
    type: [String],
    required: true,
    validate: {
      validator(values) {
        return Array.isArray(values) && values.length >= 1 && values.length <= 25 && values.every((value) => typeof value === 'string' && value.trim().length >= 1 && value.length <= 500);
      },
      message: 'A timer must have 1-25 responses, each between 1 and 500 characters.'
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
  enabled: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

chatTimerSchema.index({ channelName: 1, name: 1 });

module.exports = mongoose.models.ChatTimer || mongoose.model('ChatTimer', chatTimerSchema);
