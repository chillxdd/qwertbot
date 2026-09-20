'use strict';

const DEFAULT_PUBLIC_BASE_URL = 'https://sqwertarmybot.onrender.com';
const PUBLIC_BASE_URL = String(process.env.QWERTBOT_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
const STREAM_TIME_ZONE = 'America/Los_Angeles';
const ADMIN_PATH = '/hailfatcloud';
const COMMANDS_URL = `${PUBLIC_BASE_URL}/commands`;
const TWITCH_REDIRECT_URI = `${PUBLIC_BASE_URL}/auth/twitch/callback`;
const TWITCH_EVENTSUB_CALLBACK_URL = `${PUBLIC_BASE_URL}/eventsub/twitch`;

function normalizeChannelName(value) {
  return String(value || '').replace(/^#/, '').toLowerCase().trim();
}

module.exports = {
  DEFAULT_PUBLIC_BASE_URL,
  PUBLIC_BASE_URL,
  STREAM_TIME_ZONE,
  ADMIN_PATH,
  COMMANDS_URL,
  TWITCH_REDIRECT_URI,
  TWITCH_EVENTSUB_CALLBACK_URL,
  normalizeChannelName
};
