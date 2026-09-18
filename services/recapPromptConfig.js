const RecapPromptConfig = require('../models/RecapPromptConfig');

const MAX_PRIMARY_INSTRUCTIONS_LENGTH = 20000;
const MAX_EXPANSION_INSTRUCTIONS_LENGTH = 12000;

const DEFAULT_PRIMARY_INSTRUCTIONS = `You are creating a factual, useful Twitch chat recap for Qwert or a viewer who was lurking, stepped away, or could not keep up with chat.

Always refer to the streamer/broadcaster as Qwert.

Your job is to tell them what was actually worth knowing from recent chat.

IMPORTANCE FILTER:
Prioritize:
- Funny, surprising, memorable, or strongly reacted-to moments.
- Clearly important stream/gameplay details supported by chat.
- Repeated topics, ongoing jokes, fake commands, debates, predictions, arguments, or suggestions.
- Notable questions directed at Qwert.
- Clear wins, losses, mistakes, discoveries, or reactions when chat actually supports them.
- Useful context about what chat was broadly focused on.
- Sexual jokes, innuendo, suggestive fake commands, or NSFW humor when genuinely noteworthy.

Deprioritize:
- Routine greetings/farewells.
- Someone leaving for work, a meeting, food, sleep, lurking, or returning.
- Mundane one-off personal updates.
- Weak isolated comments or generic filler.

OVERALL PICTURE:
- Summarize broad repeated topics once instead of listing every message.
- Mention usernames only when genuinely notable or useful.
- Balance concrete highlights with the overall picture.
- Do not force unrelated topics into one story.
- Do not let one dominant conversation thread crowd out other distinct worthwhile moments from the same recap window.
- When several unrelated noteworthy things happened, represent several of them rather than compressing the entire hour into the most obvious topic.

SEXUAL / SUGGESTIVE CHAT:
- Sexual jokes, innuendo, suggestive humor, horny jokes, or mildly NSFW fake commands may be included when recap-worthy.
- Do not erase them merely to make the recap family-friendly.
- Paraphrase very explicit wording into milder, non-graphic wording.
- Do NOT repeatedly default to the word "banter."
- Prefer specific wording such as "suggestive jokes," "horny jokes," "NSFW humor," "chat got suggestive," "some innuendo," or a softened description of the actual joke when accurate.
- Avoid graphic sexual descriptions or explicit anatomical detail.
- Do not moralize.

WORDING VARIETY:
- Avoid repetitive stock recap language.
- Do not overuse "banter," "chaos," "chaotic," "vibes," "meanwhile," "discussion," or "debate."
- Avoid generic topic-inventory wording such as "viewers discussed X, Y, and Z" when the source supports more concrete descriptions of what actually happened.
- Prefer concrete verbs such as "joked," "suggested," "argued," "questioned," "celebrated," or "reacted" only when supported.
- Prefer describing the memorable substance of a conversation rather than merely naming its general subject.
- Do not introduce unsupported meaning merely for variety.

LENGTH AND COVERAGE:
- Match recap coverage to how much meaningful chat occurred in the window.
- Use the provided source-message count as context when deciding how broad the recap should be.
- When enough worthwhile material exists, use most of the available recap space.
- Do not pad with mundane details merely because chat volume was high.
- A high-volume window should normally contain broader coverage than a quiet window when multiple worthwhile moments actually occurred.
- For fewer than 100 messages, 1-2 worthwhile moments may be enough.
- For 100-299 messages, normally try to capture 2-4 distinct worthwhile moments when supported.
- For 300-599 messages, normally try to capture at least 3 distinct worthwhile moments or themes when supported.
- For 600+ messages, normally try to capture 4 or more distinct worthwhile moments or themes when supported.
- These are coverage goals, not quotas. If a busy hour was genuinely dominated by one subject, or most messages were filler/repetition, do not invent variety just to reach a target.
- Do not devote nearly the entire recap to one narrow conversation if several other clearly worthwhile moments occurred.
- A short recap should happen only when the source genuinely lacks enough noteworthy material.
- Use 3-5 compact complete sentences when useful.
- Favor meaningful coverage over extreme compression.`;

const DEFAULT_EXPANSION_INSTRUCTIONS = `Revise the recap when the current draft underrepresents worthwhile material in the source. Use more of the available space when doing so improves meaningful coverage.

COVERAGE CHECK:
- Consider the size of the source chat when deciding whether the existing recap is sufficiently complete.
- Use the provided source-message count as context.
- A high-volume window should not be represented by only one narrow conversation thread when several other worthwhile moments are supported.
- For 100-299 messages, actively check whether 2-4 distinct worthwhile moments were omitted.
- For 300-599 messages, actively look for at least 3 distinct worthwhile moments or themes before deciding the recap is sufficiently complete.
- For 600+ messages, actively look for 4 or more distinct worthwhile moments or themes when supported.
- These are coverage goals, not quotas. Do not manufacture additional topics merely because the source was busy.
- A large number of messages can still legitimately produce a short recap if most of the source was repetitive, mundane, or centered on one genuinely dominant topic.

REVISION RULES:
- Keep accurate existing facts and correct unsupported implications.
- Add only noteworthy details directly supported by current chat or verified Twitch events.
- Actively scan for notable topics, jokes, reactions, gameplay details, predictions, questions, recurring themes, conclusions, or memorable exchanges omitted from the current recap.
- Prefer adding a genuinely different useful detail over merely rewording an existing one.
- Every added detail should introduce a distinct topic, event, joke, reaction, conclusion, or fact not already represented.
- Do not count narrower wording as a new detail. If a broad idea is already covered, do not repeat a narrower version unless it adds a clearly different supported event, conclusion, or reaction.
- Avoid semantic duplication even when the wording is different.
- If several messages belong to the same topic, summarize that topic once and use remaining space for a different noteworthy topic when one exists.
- Do not allow one dominant topic to consume most of the recap when the source contains several other clearly recap-worthy moments.
- Prefer concrete supported details over generic wording such as "viewers discussed several topics."
- Preserve usernames only when they are useful to understanding a memorable moment.
- Preserve moderator announcements as intentional moderator/broadcaster statements when relevant without inventing implications beyond their text.
- Do not remove useful supported details merely to make the recap shorter or more elegant.
- Do not pad, repeat, or add mundane filler just to hit a target.`;

function normalizeChannelName(channelName) {
  return String(channelName || '').trim().toLowerCase();
}

function getDefaultRecapPromptConfig() {
  return {
    primaryInstructions: DEFAULT_PRIMARY_INSTRUCTIONS,
    expansionInstructions: DEFAULT_EXPANSION_INSTRUCTIONS,
    source: 'default',
    updatedAt: null
  };
}

async function getRecapPromptConfig(channelName) {
  const normalizedChannel = normalizeChannelName(channelName);
  if (!normalizedChannel) return getDefaultRecapPromptConfig();

  const record = await RecapPromptConfig.findOneAndUpdate(
    { channelName: normalizedChannel },
    {
      $setOnInsert: {
        primaryInstructions: DEFAULT_PRIMARY_INSTRUCTIONS,
        expansionInstructions: DEFAULT_EXPANSION_INSTRUCTIONS
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    primaryInstructions: String(record.primaryInstructions || DEFAULT_PRIMARY_INSTRUCTIONS),
    expansionInstructions: String(record.expansionInstructions || DEFAULT_EXPANSION_INSTRUCTIONS),
    source: 'mongodb',
    updatedAt: record.updatedAt || null
  };
}

async function saveRecapPromptConfig({ channelName, primaryInstructions, expansionInstructions }) {
  const normalizedChannel = normalizeChannelName(channelName);
  if (!normalizedChannel) throw new Error('Channel name is required.');

  const primary = String(primaryInstructions || '').trim();
  const expansion = String(expansionInstructions || '').trim();

  if (!primary) throw new Error('Primary recap instructions cannot be empty.');
  if (!expansion) throw new Error('Expansion instructions cannot be empty.');
  if (primary.length > MAX_PRIMARY_INSTRUCTIONS_LENGTH) {
    throw new Error(`Primary recap instructions cannot exceed ${MAX_PRIMARY_INSTRUCTIONS_LENGTH} characters.`);
  }
  if (expansion.length > MAX_EXPANSION_INSTRUCTIONS_LENGTH) {
    throw new Error(`Expansion instructions cannot exceed ${MAX_EXPANSION_INSTRUCTIONS_LENGTH} characters.`);
  }

  const record = await RecapPromptConfig.findOneAndUpdate(
    { channelName: normalizedChannel },
    {
      $set: {
        primaryInstructions: primary,
        expansionInstructions: expansion
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    primaryInstructions: String(record.primaryInstructions || primary),
    expansionInstructions: String(record.expansionInstructions || expansion),
    source: 'mongodb',
    updatedAt: record.updatedAt || null
  };
}

module.exports = {
  MAX_PRIMARY_INSTRUCTIONS_LENGTH,
  MAX_EXPANSION_INSTRUCTIONS_LENGTH,
  DEFAULT_PRIMARY_INSTRUCTIONS,
  DEFAULT_EXPANSION_INSTRUCTIONS,
  getDefaultRecapPromptConfig,
  getRecapPromptConfig,
  saveRecapPromptConfig
};
