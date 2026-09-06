const mongoose = require('mongoose');

// Configure Mongoose BEFORE importing any models. With buffering disabled,
// eager autoCreate/autoIndex can run without a connected native DB handle and
// permanently reject the model's cached init promise. Startup initializes the
// collections and indexes explicitly, after connectDatabase() has completed.
mongoose.set('bufferCommands', false);
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);

let connecting = null;
let initializingModels = null;
let listenersInstalled = false;

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1 && Boolean(mongoose.connection.db);
}

async function connectDatabase() {
  if (isDatabaseConnected()) return mongoose.connection;
  if (connecting) return connecting;
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI environment variable is not set.');
  if (!listenersInstalled) {
    listenersInstalled = true;
    mongoose.connection.on('disconnected', () => console.warn('[Database] MongoDB disconnected; bot lease work will stop.'));
    mongoose.connection.on('error', (err) => console.error('[Database] Connection error:', err.message));
  }
  connecting = mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000,
    socketTimeoutMS: 20000, maxPoolSize: 10, autoCreate: false, autoIndex: false });
  try {
    await connecting;
    if (!isDatabaseConnected()) throw new Error('MongoDB connection completed without an available database handle.');
    console.log('[Database] MongoDB connected.');
    return mongoose.connection;
  } finally { connecting = null; }
}

async function initializeDatabaseModels() {
  if (initializingModels) return initializingModels;
  const run = async () => {
    if (!isDatabaseConnected()) throw new Error('MongoDB must be connected before model initialization.');
    const connection = mongoose.connection;
    const nativeDb = connection.db;
    const assertConnected = () => {
      if (!isDatabaseConnected() || mongoose.connection !== connection || connection.db !== nativeDb) {
        throw new Error('MongoDB connection changed during model initialization; startup will retry.');
      }
    };

    // Load all production models, including ones otherwise first used by a
    // later feature. Global autoCreate/autoIndex are off, so importing is safe.
    const fs = require('node:fs');
    const path = require('node:path');
    const modelDirectory = path.join(__dirname, '..', 'models');
    for (const entry of fs.readdirSync(modelDirectory).sort()) {
      if (entry.endsWith('.js')) require(path.join(modelDirectory, entry));
    }

    const names = connection.modelNames().sort();
    for (const name of names) {
      const model = connection.model(name);
      let stage = 'collection';
      try {
        assertConnected();
        // Do not await Model.init(): Mongoose caches that promise, including
        // an earlier rejection. These explicit operations can safely retry.
        // createCollection tolerates an existing collection; createIndexes
        // only ensures schema indexes and does NOT drop existing indexes/data.
        await model.createCollection();
        assertConnected();
        if (model.schema.options.autoIndex !== false) {
          stage = 'indexes';
          await model.createIndexes();
          assertConnected();
        }
        // ViewerProfile deliberately has autoIndex:false. Its legacy identity
        // migration remains owned by ensureViewerProfileIndexes() in server.js.
      } catch (err) {
        throw new Error(`MongoDB initialization failed for ${name} (${stage}): ${err?.message || err}`, { cause: err });
      }
    }
    assertConnected();
    console.log(`[Database] Collections and schema indexes ready (${names.length} models).`);
  };
  const pending = run();
  initializingModels = pending;
  try { await pending; }
  finally { if (initializingModels === pending) initializingModels = null; }
}

async function disconnectDatabase() { if (mongoose.connection.readyState !== 0) await mongoose.disconnect(); }
module.exports = { connectDatabase, disconnectDatabase, isDatabaseConnected, initializeDatabaseModels };
