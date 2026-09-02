const mongoose = require('mongoose');

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
  timestamp: { type: Number, required: true },
  text: { type: String, required: true },
  kind: { type: String, enum: ['viewer', 'bot_context'], default: 'viewer' }
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
  timestamp: { type: Number, required: true },
  type: { type: String, default: '' },
  text: { type: String, required: true }
}, { _id: false });


const sessionMemoryBlockSchema = new mongoose.Schema({
  sequence: { type: Number, required: true },
  startedAtMs: { type: Number, default: null },
  endedAtMs: { type: Number, required: true },
  detailedSummary: { type: String, required: true, maxlength: 3000 },
  compactSummary: { type: String, required: true, maxlength: 550 },
  topics: { type: [String], default: [] },
  people: { type: [String], default: [] },
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
