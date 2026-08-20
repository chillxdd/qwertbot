const mongoose = require('mongoose');

const viewerProfileSettingsSchema = new mongoose.Schema({
  channelName: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  automaticLearningEnabled: { type: Boolean, default: true },
  useInTaggedQuestions: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.models.ViewerProfileSettings || mongoose.model('ViewerProfileSettings', viewerProfileSettingsSchema);
