const mongoose = require('mongoose');

const recapEntrySchema = new mongoose.Schema(
  {
    sequence: {
      type: Number,
      required: true
    },
    text: {
      type: String,
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const streamRecapSessionSchema = new mongoose.Schema(
  {
    channelName: {
      type: String,
      required: true,
      index: true
    },
    streamId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    startedAt: {
      type: Date,
      default: null
    },
    recaps: {
      type: [recapEntrySchema],
      default: []
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('StreamRecapSession', streamRecapSessionSchema);
