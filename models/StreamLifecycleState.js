const mongoose = require('mongoose');

const streamLifecycleStateSchema = new mongoose.Schema(
  {
    channelName: { type: String, required: true, unique: true, index: true },
    lastStreamStartedAt: { type: Date, default: null },
    lastStreamEndedAt: { type: Date, default: null },
    lastKnownStreamId: { type: String, default: '' },
    lastLifecycleEventType: { type: String, enum: ['', 'online', 'offline'], default: '' },
    lastLifecycleEventAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.models.StreamLifecycleState || mongoose.model('StreamLifecycleState', streamLifecycleStateSchema);
