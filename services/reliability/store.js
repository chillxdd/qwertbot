'use strict';
const WRITE_OPTIONS = { writeConcern: { w: 'majority', wtimeoutMS: 5000 }, maxTimeMS: 5000 };
function collection() {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) throw new Error('MongoDB is not connected. Durable operations are unavailable.');
  return mongoose.connection.db.collection('bot_reliability', { readPreference: 'primary', readConcern: { level: 'majority' } });
}
async function initializeStore() {
  const db = collection();
  await db.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0, name: 'reliability_retention' });
  await db.createIndex({ kind: 1, state: 1, availableAt: 1, createdAt: 1 }, { name: 'reliability_work_queue' });
}
function isDuplicate(err) { return Number(err?.code) === 11000; }
module.exports = { collection, initializeStore, WRITE_OPTIONS, isDuplicate };
