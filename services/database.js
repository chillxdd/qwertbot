const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
let connecting = null;
let listenersInstalled = false;
function isDatabaseConnected() { return mongoose.connection.readyState === 1; }
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
    socketTimeoutMS: 20000, maxPoolSize: 10 });
  try { await connecting; console.log('[Database] MongoDB connected.'); return mongoose.connection; }
  finally { connecting = null; }
}
async function disconnectDatabase() { if (mongoose.connection.readyState !== 0) await mongoose.disconnect(); }
module.exports = { connectDatabase, disconnectDatabase, isDatabaseConnected };
