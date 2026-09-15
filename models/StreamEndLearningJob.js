const mongoose = require('mongoose');

const finalLearningSegmentSchema = new mongoose.Schema({
  segmentId: { type: String, required: true },
  messageSnapshot: { type: [mongoose.Schema.Types.Mixed], default: [] },
  viewerLearningDone: { type: Boolean, default: false },
  streamLoreDone: { type: Boolean, default: false },
  createdAt: { type: Number, default: 0 }
}, { _id: false });

const streamEndLearningJobSchema = new mongoose.Schema({
  channelName: { type: String, required: true, index: true },
  streamId: { type: String, required: true, unique: true, index: true },
  writerFence: { type: Number, default: 0 },
  segments: { type: [finalLearningSegmentSchema], default: [] },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Number, default: 0 },
  lastError: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.models.StreamEndLearningJob || mongoose.model('StreamEndLearningJob', streamEndLearningJobSchema);
