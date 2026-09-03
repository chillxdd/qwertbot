const mongoose = require('mongoose');

const lastClipSchema = new mongoose.Schema({
  id: { type: String, default: '' },
  url: { type: String, default: '' },
  title: { type: String, default: '' },
  duration: { type: Number, default: null },
  creatorName: { type: String, default: '' },
  source: { type: String, enum: ['', 'cliplast', 'setlast'], default: '' },
  setByUserId: { type: String, default: '' },
  setByLogin: { type: String, default: '' },
  setByDisplayName: { type: String, default: '' },
  setAt: { type: Date, default: null }
}, { _id: false });

const clipCommandConfigSchema = new mongoose.Schema({
  channelName: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  clip: {
    defaultTitle: { type: String, default: 'Qwert Clip', trim: true },
    defaultDuration: { type: Number, default: 45 }
  },
  cliplast: {
    defaultTitle: { type: String, default: 'Last Notable Run End', trim: true },
    defaultDuration: { type: Number, default: 45 }
  },
  lastClip: { type: lastClipSchema, default: () => ({}) }
}, { timestamps: true });

module.exports = mongoose.models.ClipCommandConfig || mongoose.model('ClipCommandConfig', clipCommandConfigSchema);
