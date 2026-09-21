const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  channelKey: { type: String, required: true, unique: true, lowercase: true, trim: true },
  globalCooldownSeconds: { type: Number, min: 0, max: 86400, default: 5 }
}, { timestamps: true });
module.exports = mongoose.models.YouTubeCustomCommandSettings || mongoose.model('YouTubeCustomCommandSettings', schema);
