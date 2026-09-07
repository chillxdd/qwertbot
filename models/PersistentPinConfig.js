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
  // Legacy single-message field retained for backwards compatibility. The first
  // configured banner is mirrored here so older deployments can still read it.
  message: {
    type: String,
    default: '',
    maxlength: 500
  },
  messages: {
    type: [String],
    default: []
  },
  // Per-banner controls are parallel to messages so existing message IDs stay
  // aligned when a banner is temporarily disabled. Missing legacy values mean
  // enabled + global duration.
  bannerEnabled: {
    type: [Boolean],
    default: []
  },
  bannerDurations: {
    type: [Number],
    default: []
  },
  rotationSeconds: {
    type: Number,
    default: 180,
    min: 30,
    max: 1800
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
  activeMessageIds: {
    type: [String],
    default: []
  },
  activeBannerIndex: {
    type: Number,
    default: 0,
    min: 0
  },
  bannerEndsAt: {
    type: Date,
    default: null
  },
  schedulerFence: { type: Number, default: 0 },
  postGeneration: { type: Number, default: 0 },
  deliveryKey: { type: String, default: '' },
  recoveryRequired: { type: Boolean, default: false },
  recoveryReason: { type: String, default: '' },
  skipStreamId: { type: String, default: '' },
  lastPinnedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.models.PersistentPinConfig || mongoose.model('PersistentPinConfig', persistentPinConfigSchema);
