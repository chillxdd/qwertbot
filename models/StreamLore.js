const mongoose = require('mongoose');

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
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.StreamLore || mongoose.model('StreamLore', streamLoreSchema);
