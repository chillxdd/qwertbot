const mongoose = require('mongoose');

const viewerFactRevisionSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 400 },
  kind: { type: String, enum: ['fact', 'preference', 'habit', 'behavior'], default: 'fact' },
  relation: { type: String, enum: ['refine', 'contradict'], default: 'refine' },
  confidence: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  evidenceCount: { type: Number, min: 1, default: 1 },
  supportingWindowCount: { type: Number, min: 1, default: 1 },
  evidenceSummary: { type: String, default: '', maxlength: 500 },
  reason: { type: String, default: '', maxlength: 300 },
  firstProposedAt: { type: Date, default: Date.now },
  lastProposedAt: { type: Date, default: Date.now }
}, { _id: false });

const viewerFactSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 400 },
  confidence: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  evidenceCount: { type: Number, min: 1, default: 1 },
  supportingWindowCount: { type: Number, min: 1, default: 1 },
  contradictionCount: { type: Number, min: 0, default: 0 },
  revisionCount: { type: Number, min: 0, default: 0 },
  kind: { type: String, enum: ['fact', 'preference', 'habit', 'behavior'], default: 'fact' },
  source: { type: String, enum: ['ai', 'deterministic'], default: 'ai' },
  approvalStatus: { type: String, enum: ['pending', 'approved'], default: undefined },
  evidenceSummary: { type: String, default: '', maxlength: 500 },
  firstObservedAt: { type: Date, default: Date.now },
  lastObservedAt: { type: Date, default: Date.now },
  lastRefinedAt: { type: Date, default: null },
  lastContradictedAt: { type: Date, default: null },
  revisionProposal: { type: viewerFactRevisionSchema, default: null },
  enabled: { type: Boolean, default: true }
}, { _id: true });


const viewerCommandUsageSchema = new mongoose.Schema({
  command: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
  count: { type: Number, min: 1, default: 1 },
  offlineCount: { type: Number, min: 0, default: 0 },
  recognizedCount: { type: Number, min: 0, default: 0 },
  unrecognizedCount: { type: Number, min: 0, default: 0 },
  firstUsedAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: Date.now }
}, { _id: false });

const viewerProfileSchema = new mongoose.Schema({
  channelName: { type: String, required: true, lowercase: true, trim: true, index: true },
  username: { type: String, required: true, lowercase: true, trim: true },
  displayName: { type: String, default: '', trim: true, maxlength: 80 },
  twitchUserId: { type: String, default: undefined, trim: true },
  optedOut: { type: Boolean, default: false },
  optedOutAt: { type: Date, default: null },
  profileDataPurgedAt: { type: Date, default: null },
  profileRetainedOnOptOut: { type: Boolean, default: false },
  preOptOutEnabled: { type: Boolean, default: true },
  preOptOutLearningEnabled: { type: Boolean, default: true },
  aliases: { type: [String], default: [] },
  pinnedNotes: { type: String, default: '', maxlength: 4000 },
  facts: { type: [viewerFactSchema], default: [] },
  commandUsage: { type: [viewerCommandUsageSchema], default: [] },
  enabled: { type: Boolean, default: true },
  learningEnabled: { type: Boolean, default: true },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

viewerProfileSchema.index({ channelName: 1, username: 1 }, { unique: true });
viewerProfileSchema.index({ channelName: 1, twitchUserId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.ViewerProfile || mongoose.model('ViewerProfile', viewerProfileSchema);
