const mongoose = require('mongoose');

const identitySchema = new mongoose.Schema({
  userId: { type: String, default: '' },
  login: { type: String, default: '' },
  displayName: { type: String, default: '' },
  role: { type: String, enum: ['viewer', 'moderator', 'broadcaster', 'bot', 'system', 'unknown'], default: 'unknown' },
  aliases: { type: [String], default: [] }
}, { _id: false });

const replyReferenceSchema = new mongoose.Schema({
  messageId: { type: String, default: '' },
  text: { type: String, default: '' },
  author: { type: identitySchema, default: null }
}, { _id: false });

const recapEntrySchema = new mongoose.Schema(
  {
    sequence: { type: Number, required: true },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const recapMessageSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  twitchMessageId: { type: String, default: '' },
  sourceMessageId: { type: String, default: '' },
  timestamp: { type: Number, required: true },
  // Kept for backwards compatibility with persisted pre-structured sessions.
  text: { type: String, required: true },
  body: { type: String, default: '' },
  kind: { type: String, enum: ['viewer', 'bot_context', 'moderator_announcement'], default: 'viewer' },
  author: { type: identitySchema, default: null },
  replyTo: { type: replyReferenceSchema, default: null },
  sharedChat: { type: mongoose.Schema.Types.Mixed, default: {} },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const recapContextSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  timestamp: { type: Number, required: true },
  title: { type: String, default: '' },
  category: { type: String, default: '' },
  gameId: { type: String, default: '' }
}, { _id: false });

const recapEventSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  sourceEventId: { type: String, default: '' },
  timestamp: { type: Number, required: true },
  type: { type: String, default: '' },
  text: { type: String, required: true },
  actor: { type: identitySchema, default: null },
  target: { type: identitySchema, default: null },
  anonymous: { type: Boolean, default: false },
  amount: { type: Number, default: null },
  quantity: { type: Number, default: null },
  rewardId: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const sharedChatGuestSchema = new mongoose.Schema({
  userId: { type: String, default: '' },
  login: { type: String, default: '' },
  displayName: { type: String, default: '' },
  originType: { type: String, enum: ['shared_guest', 'shared_unknown'], default: 'shared_guest' },
  sourceBroadcasterUserId: { type: String, default: '' },
  sourceBroadcasterLogin: { type: String, default: '' },
  sourceBroadcasterDisplayName: { type: String, default: '' }
}, { _id: false });

const sessionMemoryClaimSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 700 },
  sourceIds: { type: [String], default: [] },
  people: { type: [String], default: [] }
}, { _id: false });

const sessionMemoryBlockSchema = new mongoose.Schema({
  sequence: { type: Number, required: true },
  startedAtMs: { type: Number, default: null },
  endedAtMs: { type: Number, required: true },
  detailedSummary: { type: String, required: true, maxlength: 3000 },
  compactSummary: { type: String, required: true, maxlength: 550 },
  topics: { type: [String], default: [] },
  people: { type: [String], default: [] },
  sharedChatGuests: { type: [sharedChatGuestSchema], default: [] },
  claims: { type: [sessionMemoryClaimSchema], default: [] },
  sourceMessageIds: { type: [String], default: [] },
  sourceEventIds: { type: [String], default: [] },
  attributionAudited: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const activeStateSchema = new mongoose.Schema({
  recapMessages: { type: [recapMessageSchema], default: [] },
  messageSequence: { type: Number, default: 0 },
  streamContexts: { type: [recapContextSchema], default: [] },
  contextSequence: { type: Number, default: 0 },
  twitchEvents: { type: [recapEventSchema], default: [] },
  eventSequence: { type: Number, default: 0 },
  firstRecapSent: { type: Boolean, default: false },
  streamSessionStartedAt: { type: Number, default: 0 },
  twitchStreamStartedAt: { type: Number, default: 0 },
  nextRecapAt: { type: Number, default: 0 },
  recapPaused: { type: Boolean, default: false },
  pausedRemainingMs: { type: Number, default: 0 },
  savedAt: { type: Date, default: Date.now }
}, { _id: false });

const streamRecapSessionSchema = new mongoose.Schema(
  {
    channelName: { type: String, required: true, index: true },
    streamId: { type: String, required: true, unique: true, index: true },
    startedAt: { type: Date, default: null },
    recaps: { type: [recapEntrySchema], default: [] },
    sessionMemoryBlocks: { type: [sessionMemoryBlockSchema], default: [] },
    activeState: { type: activeStateSchema, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.models.StreamRecapSession || mongoose.model('StreamRecapSession', streamRecapSessionSchema);
