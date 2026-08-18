const mongoose = require('mongoose');

const recapPromptConfigSchema = new mongoose.Schema({
  channelName: { type: String, required: true, unique: true, index: true },
  primaryInstructions: { type: String, default: '' },
  expansionInstructions: { type: String, default: '' }
}, {
  timestamps: true
});

module.exports = mongoose.models.RecapPromptConfig || mongoose.model('RecapPromptConfig', recapPromptConfigSchema);
