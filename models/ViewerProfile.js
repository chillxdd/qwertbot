const mongoose = require('mongoose');

const viewerFactSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 400 },
  confidence: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  evidenceCount: { type: Number, min: 1, default: 1 },
  firstObservedAt: { type: Date, default: Date.now },
  lastObservedAt: { type: Date, default: Date.now },
  enabled: { type: Boolean, default: true }
}, { _id: true });

const viewerProfileSchema = new mongoose.Schema({
  channelName: { type: String, required: true, lowercase: true, trim: true, index: true },
  username: { type: String, required: true, lowercase: true, trim: true },
  displayName: { type: String, default: '', trim: true, maxlength: 80 },
  aliases: { type: [String], default: [] },
  pinnedNotes: { type: String, default: '', maxlength: 4000 },
  facts: { type: [viewerFactSchema], default: [] },
  enabled: { type: Boolean, default: true },
  learningEnabled: { type: Boolean, default: true },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

viewerProfileSchema.index({ channelName: 1, username: 1 }, { unique: true });

module.exports = mongoose.models.ViewerProfile || mongoose.model('ViewerProfile', viewerProfileSchema);
