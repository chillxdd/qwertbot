'use strict';

const DEFAULT_SESSION_MEMORY_CONFIG = Object.freeze({
  enabled: true,
  recentDetailedHours: 2,
  maxContextCharacters: 18000,
  recentChatMessages: 30,
  relevantOlderBlocks: 2,
  promptInstructions: ''
});

const MIN_RECENT_DETAILED_HOURS = 1;
const MAX_RECENT_DETAILED_HOURS = 8;
const MIN_MAX_CONTEXT_CHARACTERS = 4000;
const MAX_MAX_CONTEXT_CHARACTERS = 40000;
const MIN_RECENT_CHAT_MESSAGES = 0;
const MAX_RECENT_CHAT_MESSAGES = 100;
const MIN_RELEVANT_OLDER_BLOCKS = 0;
const MAX_RELEVANT_OLDER_BLOCKS = 6;
const MAX_SESSION_MEMORY_PROMPT_LENGTH = 6000;

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeSessionMemoryConfig(value = {}) {
  return {
    enabled: value?.enabled !== false,
    recentDetailedHours: clampNumber(value?.recentDetailedHours, MIN_RECENT_DETAILED_HOURS, MAX_RECENT_DETAILED_HOURS, DEFAULT_SESSION_MEMORY_CONFIG.recentDetailedHours),
    maxContextCharacters: clampNumber(value?.maxContextCharacters, MIN_MAX_CONTEXT_CHARACTERS, MAX_MAX_CONTEXT_CHARACTERS, DEFAULT_SESSION_MEMORY_CONFIG.maxContextCharacters),
    recentChatMessages: clampNumber(value?.recentChatMessages, MIN_RECENT_CHAT_MESSAGES, MAX_RECENT_CHAT_MESSAGES, DEFAULT_SESSION_MEMORY_CONFIG.recentChatMessages),
    relevantOlderBlocks: clampNumber(value?.relevantOlderBlocks, MIN_RELEVANT_OLDER_BLOCKS, MAX_RELEVANT_OLDER_BLOCKS, DEFAULT_SESSION_MEMORY_CONFIG.relevantOlderBlocks),
    promptInstructions: String(value?.promptInstructions || '').trim().slice(0, MAX_SESSION_MEMORY_PROMPT_LENGTH)
  };
}

module.exports = {
  DEFAULT_SESSION_MEMORY_CONFIG,
  MIN_RECENT_DETAILED_HOURS,
  MAX_RECENT_DETAILED_HOURS,
  MIN_MAX_CONTEXT_CHARACTERS,
  MAX_MAX_CONTEXT_CHARACTERS,
  MIN_RECENT_CHAT_MESSAGES,
  MAX_RECENT_CHAT_MESSAGES,
  MIN_RELEVANT_OLDER_BLOCKS,
  MAX_RELEVANT_OLDER_BLOCKS,
  MAX_SESSION_MEMORY_PROMPT_LENGTH,
  normalizeSessionMemoryConfig
};
