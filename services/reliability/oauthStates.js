'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { collection, WRITE_OPTIONS } = require('./store');
function createOAuthStateStore(lifetimeMs, namespace, getCollection = collection) {
  const id = (value) => `oauth-state:${namespace}:${createHash('sha256').update(String(value)).digest('hex')}`;
  return {
    async create() {
      const state = randomBytes(32).toString('hex');
      await getCollection().insertOne({ _id: id(state), kind: 'oauth-state', createdAt: new Date(),
        expiresAt: new Date(Date.now() + lifetimeMs), purgeAt: new Date(Date.now() + lifetimeMs) }, WRITE_OPTIONS);
      return state;
    },
    async consume(state) {
      if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) return false;
      const result = await getCollection().findOneAndDelete({ _id: id(state),
        $expr: { $gt: ['$expiresAt', '$$NOW'] } }, { ...WRITE_OPTIONS, includeResultMetadata: false });
      return Boolean(result);
    }
  };
}
module.exports = { createOAuthStateStore };
