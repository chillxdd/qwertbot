'use strict';

const mongoose = require('mongoose');

const streamListProbeAttemptSchema = new mongoose.Schema({
  runId: { type: String, required: true, index: true },
  dayKey: { type: String, required: true, index: true },
  clientKey: { type: String, required: true, enum: ['qwertbot-node', 'minimal-node', 'python-grpcio'], index: true },
  liveChatId: { type: String, required: true, index: true },
  targetLabel: { type: String, default: '' },
  startedAt: { type: Date, required: true, default: Date.now },
  endedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
  responseCount: { type: Number, default: 0 },
  messageCount: { type: Number, default: 0 },
  pageTokenCount: { type: Number, default: 0 },
  firstResponseAt: { type: Date, default: null },
  lastResponseAt: { type: Date, default: null },
  terminalEvent: { type: String, default: '' },
  grpcStatusCode: { type: Number, default: null },
  grpcStatusName: { type: String, default: '' },
  grpcStatusDetails: { type: String, default: '' },
  grpcMetadataKeys: { type: [String], default: [] },
  terminationReason: { type: String, default: '' },
  excludedFromStats: { type: Boolean, default: false },
  expireAt: { type: Date, required: true }
}, { timestamps: true });

streamListProbeAttemptSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
streamListProbeAttemptSchema.index({ runId: 1, clientKey: 1, liveChatId: 1, startedAt: -1 });
streamListProbeAttemptSchema.index({ dayKey: 1, clientKey: 1, startedAt: -1 });

module.exports = mongoose.models.StreamListProbeAttempt || mongoose.model('StreamListProbeAttempt', streamListProbeAttemptSchema);
