const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  channelKey: { type: String, required: true, unique: true, lowercase: true, trim: true },
  commandsEnabled: { type: Boolean, default: true },
  commandsResponse: { type: String, default: '', maxlength: 200 }
}, { timestamps: true });
module.exports = mongoose.models.YouTubeNativeCommandConfig || mongoose.model('YouTubeNativeCommandConfig', schema);
