const mongoose = require('mongoose');

const learnedLoreObservationSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 400 },
  confidence: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  evidenceCount: { type: Number, min: 1, default: 1 },
  firstObservedAt: { type: Date, default: Date.now },
  lastObservedAt: { type: Date, default: Date.now },
  enabled: { type: Boolean, default: false }
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
  learnedObservations: { type: [learnedLoreObservationSchema], default: [] }
}, {
  timestamps: true
});

module.exports = mongoose.models.StreamLore || mongoose.model('StreamLore', streamLoreSchema);
