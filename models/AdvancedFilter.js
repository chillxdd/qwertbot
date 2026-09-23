const mongoose = require('mongoose');

const advancedFilterSchema = new mongoose.Schema({
  channelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  // Stored as normalized rule groups. Mixed keeps the format flexible while the
  // service owns strict validation and evaluation semantics.
  groups: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  }
}, { timestamps: true });

advancedFilterSchema.index({ channelName: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.AdvancedFilter || mongoose.model('AdvancedFilter', advancedFilterSchema);
