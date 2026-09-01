const mongoose = require('mongoose');

const persistentPinConfigSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
    index: true
  },
  enabled: {
    type: Boolean,
    default: false
  },
  message: {
    type: String,
    default: '',
    maxlength: 500
  },
  startupHoldSeconds: {
    type: Number,
    default: 10,
    min: 0,
    max: 3600
  },
  activeStreamId: {
    type: String,
    default: ''
  },
  activeMessageId: {
    type: String,
    default: ''
  },
  lastPinnedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.models.PersistentPinConfig || mongoose.model('PersistentPinConfig', persistentPinConfigSchema);
