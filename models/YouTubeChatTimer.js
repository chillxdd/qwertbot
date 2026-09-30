const mongoose = require('mongoose');
const { createTimerSchema } = require('./timerSchema');
module.exports = mongoose.models.YouTubeChatTimer || mongoose.model('YouTubeChatTimer', createTimerSchema({ channelField: 'channelKey', maxLength: 200 }));
