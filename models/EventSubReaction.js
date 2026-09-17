const mongoose = require('mongoose');

const encryptedSecretSchema = new mongoose.Schema({
  version: { type: String, required: true },
  source: { type: String, default: '' },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  data: { type: String, required: true }
}, { _id: false });

const actionSchema = new mongoose.Schema({
  type: { type: String, enum: ['chat_message', 'custom_command', 'twitch_announcement', 'twitch_shoutout', 'discord_notification'], required: true },
  value: { type: String, default: '' },
  color: { type: String, enum: ['primary', 'blue', 'green', 'orange', 'purple'], default: 'primary' },
  delaySeconds: { type: Number, default: 0, min: 0, max: 300 },
  enabled: { type: Boolean, default: true },
  discordWebhookId: { type: String, default: '', maxlength: 80 },
  discordWebhookSecret: { type: encryptedSecretSchema, default: undefined },
  discordMentionMode: { type: String, enum: ['none', 'everyone', 'roles', 'all'], default: 'none' }
}, { _id: false });

const eventSubReactionSchema = new mongoose.Schema({
  channelName: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  eventType: { type: String, required: true, index: true },
  enabled: { type: Boolean, default: true },
  minimumValue: { type: Number, default: 0, min: 0 },
  holdSeconds: { type: Number, default: null, min: 0, max: 3600 },
  actions: { type: [actionSchema], default: [] }
}, { timestamps: true });

eventSubReactionSchema.index({ channelName: 1, eventType: 1 });

module.exports = mongoose.model('EventSubReaction', eventSubReactionSchema);
