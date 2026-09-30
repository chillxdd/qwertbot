const mongoose = require('mongoose');
const { createTimerSchema } = require('./timerSchema');
module.exports = mongoose.models.ChatTimer || mongoose.model('ChatTimer', createTimerSchema());
