const { createRecapManager } = require('../services/recapManager');
const { generateRecap, SUMMARY_PREFIX, TWITCH_MESSAGE_LIMIT, SUMMARY_TEXT_LIMIT } = require('../services/recapGenerator');

module.exports = {
  createRecapManager,
  generateRecap,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT,
  SUMMARY_TEXT_LIMIT
};
