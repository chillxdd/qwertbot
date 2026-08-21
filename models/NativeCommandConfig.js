const mongoose = require('mongoose');

const nativeCommandConfigSchema = new mongoose.Schema({
  channelName: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  responses: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.models.NativeCommandConfig || mongoose.model('NativeCommandConfig', nativeCommandConfigSchema);
