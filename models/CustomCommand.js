const mongoose = require('mongoose');

const triggerSchema = new mongoose.Schema({
  triggerType: {
    type: String,
    enum: ['command', 'inline'],
    required: true
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
  }
}, { _id: false });

const customCommandSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },

  name: {
    type: String,
    required: false,
    trim: true,
    maxlength: 80,
    default: ''
  },

  // New multi-trigger representation. Each command can mix !Command and
  // Inline Phrase triggers while sharing responses, cooldown, counter, etc.
  triggers: {
    type: [triggerSchema],
    default: []
  },

  // Legacy single-trigger fields are intentionally retained for backwards
  // compatibility with commands already stored in MongoDB. New saves mirror
  // the first trigger here, while reads automatically upgrade legacy records.
  triggerType: {
    type: String,
    enum: ['command', 'inline'],
    required: false,
    default: 'command'
  },
  trigger: {
    type: String,
    required: false,
    trim: true,
    maxlength: 120
  },
  normalizedTrigger: {
    type: String,
    required: false,
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
  userLevel: {
    type: String,
    enum: ['everyone', 'subscriber', 'twitch_vip', 'moderator', 'owner'],
    default: 'everyone'
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
  cooldownResponse: {
    type: String,
    default: '',
    maxlength: 500
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

// Keep the historical index definition so existing databases remain compatible.
// Cross-command uniqueness for every trigger in the new array is enforced by
// services/customCommands.js before saves.
customCommandSchema.index(
  { channelName: 1, triggerType: 1, normalizedTrigger: 1 },
  { unique: true }
);

module.exports = mongoose.models.CustomCommand || mongoose.model('CustomCommand', customCommandSchema);
