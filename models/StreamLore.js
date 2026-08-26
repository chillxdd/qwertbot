const mongoose = require('mongoose');

const learnedLoreRevisionSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 400 },
  relation: { type: String, enum: ['refine', 'contradict'], default: 'refine' },
  confidence: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  evidenceCount: { type: Number, min: 1, default: 1 },
  supportingWindowCount: { type: Number, min: 1, default: 1 },
  evidenceSummary: { type: String, default: '', maxlength: 500 },
  reason: { type: String, default: '', maxlength: 300 },
  firstProposedAt: { type: Date, default: Date.now },
  lastProposedAt: { type: Date, default: Date.now }
}, { _id: false });

const learnedLoreObservationSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 400 },
  confidence: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  evidenceCount: { type: Number, min: 1, default: 1 },
  supportingWindowCount: { type: Number, min: 1, default: 1 },
  contradictionCount: { type: Number, min: 0, default: 0 },
  revisionCount: { type: Number, min: 0, default: 0 },
  evidenceSummary: { type: String, default: '', maxlength: 500 },
  firstObservedAt: { type: Date, default: Date.now },
  lastObservedAt: { type: Date, default: Date.now },
  lastRefinedAt: { type: Date, default: null },
  lastContradictedAt: { type: Date, default: null },
  revisionProposal: { type: learnedLoreRevisionSchema, default: null },
  approvalStatus: { type: String, enum: ['pending', 'approved'], default: undefined },
  enabled: { type: Boolean, default: false }
}, { _id: true });


const manualLoreEntrySchema = new mongoose.Schema({
  scope: { type: String, enum: ['global', 'subject'], default: 'global' },
  subject: { type: String, default: '', trim: true, maxlength: 80 },
  aliases: { type: [String], default: [] },
  text: { type: String, required: true, maxlength: 2400 },
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { _id: true });

const streamLoreSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    unique: true,
    index: true,
    lowercase: true,
    trim: true
  },
  text: {
    type: String,
    default: '',
    maxlength: 12000
  },
  manualEntries: { type: [manualLoreEntrySchema], default: [] },
  learnedObservations: { type: [learnedLoreObservationSchema], default: [] }
}, {
  timestamps: true
});

module.exports = mongoose.models.StreamLore || mongoose.model('StreamLore', streamLoreSchema);
