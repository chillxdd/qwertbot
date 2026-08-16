const mongoose = require('mongoose');

let connected = false;

async function connectDatabase() {
  if (connected && mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  const uri = (process.env.MONGODB_URI || '').trim();

  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not set.');
  }

  console.log('[Database] Connecting to MongoDB...');

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000
  });

  connected = true;
  console.log('[Database] MongoDB connected.');

  mongoose.connection.on('disconnected', () => {
    connected = false;
    console.warn('[Database] MongoDB disconnected.');
  });

  mongoose.connection.on('error', (err) => {
    console.error('[Database] MongoDB connection error:', err);
  });

  return mongoose.connection;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  connected = false;
}

module.exports = {
  connectDatabase,
  disconnectDatabase
};
