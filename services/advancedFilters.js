const context = require('./reliability/context');
const { WRITE_OPTIONS } = require('./reliability/store');
const AdvancedFilter = require('../models/AdvancedFilter');
const ChatTimer = require('../models/ChatTimer');
const PersistentPinConfig = require('../models/PersistentPinConfig');

const MAX_ADVANCED_FILTERS = 50;
const MAX_ADVANCED_FILTER_NAME_LENGTH = 80;
const MAX_FILTER_GROUPS = 10;
const MAX_FILTER_RULES_PER_GROUP = 12;
const MAX_FILTER_RULES_TOTAL = 40;
const MAX_FILTER_VALUE_LENGTH = 120;
const FILTER_FIELDS = ['title', 'category'];
const FILTER_MATCHES = ['contains', 'not_contains', 'equals', 'not_equals'];
const FILTER_OPERATORS = ['and', 'or'];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOperator(value, fallback = 'and') {
  const operator = String(value || fallback).trim().toLowerCase();
  return FILTER_OPERATORS.includes(operator) ? operator : fallback;
}

function normalizeRule(raw = {}, index = 0) {
  const field = String(raw.field || '').trim().toLowerCase();
  const match = String(raw.match || '').trim().toLowerCase();
  const value = String(raw.value || '').trim();
  const operator = index === 0 ? 'and' : normalizeOperator(raw.operator || raw.join, 'and');

  if (!FILTER_FIELDS.includes(field)) throw new Error(`Rule ${index + 1} must use Stream Title or Stream Category / Game.`);
  if (!FILTER_MATCHES.includes(match)) throw new Error(`Rule ${index + 1} has an unsupported comparison.`);
  if (!value) throw new Error(`Rule ${index + 1} needs a value, or remove that rule.`);
  if (Array.from(value).length > MAX_FILTER_VALUE_LENGTH) throw new Error(`Rule ${index + 1} value can contain at most ${MAX_FILTER_VALUE_LENGTH} characters.`);
  return { field, match, value, operator };
}

function normalizeGroups(input) {
  if (!Array.isArray(input)) throw new Error('Advanced Filter groups must be an array.');
  if (!input.length) throw new Error('Add at least one rule group.');
  if (input.length > MAX_FILTER_GROUPS) throw new Error(`An Advanced Filter supports at most ${MAX_FILTER_GROUPS} rule groups.`);

  let totalRules = 0;
  const groups = input.map((rawGroup, groupIndex) => {
    const rawRules = Array.isArray(rawGroup?.rules) ? rawGroup.rules : [];
    if (!rawRules.length) throw new Error(`Group ${groupIndex + 1} needs at least one rule.`);
    if (rawRules.length > MAX_FILTER_RULES_PER_GROUP) throw new Error(`Group ${groupIndex + 1} supports at most ${MAX_FILTER_RULES_PER_GROUP} rules.`);
    totalRules += rawRules.length;
    if (totalRules > MAX_FILTER_RULES_TOTAL) throw new Error(`An Advanced Filter supports at most ${MAX_FILTER_RULES_TOTAL} rules total.`);
    return {
      operator: groupIndex === 0 ? 'and' : normalizeOperator(rawGroup?.operator || rawGroup?.join, 'and'),
      rules: rawRules.map((rule, ruleIndex) => normalizeRule(rule, ruleIndex))
    };
  });

  return groups;
}

function normalizeFilterInput(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Filter Name is required.');
  if (Array.from(name).length > MAX_ADVANCED_FILTER_NAME_LENGTH) throw new Error(`Filter Name can contain at most ${MAX_ADVANCED_FILTER_NAME_LENGTH} characters.`);
  return { name, groups: normalizeGroups(input.groups || []) };
}

function streamValue(status, field) {
  if (field === 'category') return String(status?.category ?? status?.currentStreamCategory ?? status?.gameName ?? status?.game ?? '');
  return String(status?.title ?? status?.currentStreamTitle ?? '');
}

function evaluateRule(rule, status) {
  const actual = normalizeText(streamValue(status, rule.field));
  const expected = normalizeText(rule.value);
  // Unknown metadata must never satisfy a rule. This is especially important
  // for negative comparisons such as "does not contain": an empty category
  // during a transient Twitch metadata refresh should not make automation fire.
  if (!actual || !expected) return false;
  if (rule.match === 'contains') return actual.includes(expected);
  if (rule.match === 'not_contains') return !actual.includes(expected);
  if (rule.match === 'equals') return actual === expected;
  if (rule.match === 'not_equals') return actual !== expected;
  return false;
}

function combine(values, items) {
  if (!values.length) return false;
  let result = Boolean(values[0]);
  for (let index = 1; index < values.length; index += 1) {
    result = items[index]?.operator === 'or' ? (result || Boolean(values[index])) : (result && Boolean(values[index]));
  }
  return Boolean(result);
}

function evaluateAdvancedFilter(filter, status = {}) {
  if (!filter) return { exists: false, matched: false, groups: [], groupResults: [] };
  let groups;
  try { groups = normalizeGroups(filter.groups || []); }
  catch (err) { return { exists: true, matched: false, invalid: true, error: err.message, groups: [], groupResults: [] }; }

  const groupResults = groups.map((group) => {
    const ruleResults = group.rules.map((rule) => evaluateRule(rule, status));
    return { matched: combine(ruleResults, group.rules), ruleResults };
  });
  return {
    exists: true,
    matched: combine(groupResults.map((item) => item.matched), groups),
    groups,
    groupResults
  };
}

function fieldLabel(field) { return field === 'category' ? 'Category' : 'Title'; }
function matchLabel(match) {
  return ({ contains: 'contains', not_contains: 'does not contain', equals: 'equals', not_equals: 'does not equal' })[match] || match;
}

function describeAdvancedFilter(filter) {
  let groups;
  try { groups = normalizeGroups(filter?.groups || []); }
  catch (_) { return ''; }
  return groups.map((group, groupIndex) => {
    const body = group.rules.map((rule, ruleIndex) => `${ruleIndex ? `${rule.operator.toUpperCase()} ` : ''}${fieldLabel(rule.field)} ${matchLabel(rule.match)} “${rule.value}”`).join(' ');
    return `${groupIndex ? `${group.operator.toUpperCase()} ` : ''}(${body})`;
  }).join(' ');
}

function createAdvancedFilterManager({ channelName, getStreamStatus = null }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let cache = [];

  function streamStatus() {
    const status = typeof getStreamStatus === 'function' ? (getStreamStatus() || {}) : {};
    return {
      live: status.streamLive !== undefined ? Boolean(status.streamLive) : Boolean(status.live),
      title: String(status.currentStreamTitle || status.title || '').trim(),
      category: String(status.currentStreamCategory || status.category || status.gameName || '').trim()
    };
  }

  function toClient(filter, { includeUsage = false, usage = null } = {}) {
    const evaluation = evaluateAdvancedFilter(filter, streamStatus());
    return {
      id: String(filter._id || filter.id || ''),
      name: String(filter.name || 'Filter'),
      groups: evaluation.groups,
      summary: describeAdvancedFilter(filter),
      currentMatch: evaluation.matched,
      currentStream: streamStatus(),
      createdAt: filter.createdAt || null,
      updatedAt: filter.updatedAt || null,
      ...(includeUsage ? { usage: usage || { timers: [], banners: [] } } : {})
    };
  }

  async function refresh() {
    cache = await AdvancedFilter.find({ channelName: normalizedChannel }).sort({ createdAt: 1, name: 1 }).lean();
    return cache;
  }

  function getFilterById(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return cache.find((filter) => String(filter._id) === key) || null;
  }

  function evaluateById(id, status = streamStatus()) {
    const key = String(id || '').trim();
    if (!key) return { exists: true, matched: true, filterId: '', filterName: '', groups: [], groupResults: [] };
    const filter = getFilterById(key);
    if (!filter) return { exists: false, matched: false, filterId: key, filterName: '', groups: [], groupResults: [] };
    const result = evaluateAdvancedFilter(filter, status);
    return { ...result, filterId: key, filterName: String(filter.name || '') };
  }

  async function usageFor(id) {
    const key = String(id || '').trim();
    if (!key) return { timers: [], banners: [] };
    const [timers, pin] = await Promise.all([
      ChatTimer.find({ channelName: normalizedChannel, advancedFilterId: key }).select({ name: 1 }).lean(),
      PersistentPinConfig.findOne({ channelName: normalizedChannel }).select({ messages: 1, bannerFilterIds: 1 }).lean()
    ]);
    const banners = [];
    const ids = Array.isArray(pin?.bannerFilterIds) ? pin.bannerFilterIds : [];
    const messages = Array.isArray(pin?.messages) ? pin.messages : [];
    ids.forEach((filterId, index) => {
      if (String(filterId || '') === key) banners.push({ index, label: `Banner ${index + 1}`, message: String(messages[index] || '') });
    });
    return { timers: timers.map((timer) => ({ id: String(timer._id), name: String(timer.name || 'Timer') })), banners };
  }

  async function listFilters() {
    await refresh();
    const [timers, pin] = await Promise.all([
      ChatTimer.find({ channelName: normalizedChannel, advancedFilterId: { $ne: '' } }).select({ name: 1, advancedFilterId: 1 }).lean(),
      PersistentPinConfig.findOne({ channelName: normalizedChannel }).select({ messages: 1, bannerFilterIds: 1 }).lean()
    ]);
    const usageMap = new Map(cache.map((filter) => [String(filter._id), { timers: [], banners: [] }]));
    for (const timer of timers) {
      const key = String(timer.advancedFilterId || '').trim();
      if (usageMap.has(key)) usageMap.get(key).timers.push({ id: String(timer._id), name: String(timer.name || 'Timer') });
    }
    const ids = Array.isArray(pin?.bannerFilterIds) ? pin.bannerFilterIds : [];
    const messages = Array.isArray(pin?.messages) ? pin.messages : [];
    ids.forEach((filterId, index) => {
      const key = String(filterId || '').trim();
      if (usageMap.has(key)) usageMap.get(key).banners.push({ index, label: `Banner ${index + 1}`, message: String(messages[index] || '') });
    });
    return cache.map((filter) => toClient(filter, { includeUsage: true, usage: usageMap.get(String(filter._id)) }));
  }

  async function saveFilter(input = {}) {
    await context.assertOperation();
    const normalized = normalizeFilterInput(input);
    const id = String(input.id || '').trim();

    if (!id) {
      const count = await AdvancedFilter.countDocuments({ channelName: normalizedChannel });
      if (count >= MAX_ADVANCED_FILTERS) throw new Error(`Advanced Filters supports at most ${MAX_ADVANCED_FILTERS} filters.`);
    }

    const duplicate = await AdvancedFilter.findOne({
      channelName: normalizedChannel,
      name: { $regex: `^${normalized.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      ...(id ? { _id: { $ne: id } } : {})
    }).lean();
    if (duplicate) throw new Error('Another Advanced Filter already uses that name.');

    let saved;
    if (id) {
      saved = await AdvancedFilter.findOneAndUpdate(
        { _id: id, channelName: normalizedChannel },
        { $set: normalized },
        { ...WRITE_OPTIONS, new: true, runValidators: true }
      ).lean();
      if (!saved) throw new Error('Advanced Filter was not found.');
    } else {
      [saved] = await AdvancedFilter.create([{ channelName: normalizedChannel, ...normalized }], WRITE_OPTIONS);
      saved = saved.toObject();
    }
    await refresh();
    console.log(`[Advanced Filters] ${id ? 'Updated' : 'Created'} filter ${normalized.name}.`);
    return toClient(getFilterById(saved._id) || saved, { includeUsage: true, usage: await usageFor(saved._id) });
  }

  async function deleteFilter(id) {
    await context.assertOperation();
    const key = String(id || '').trim();
    const filter = getFilterById(key) || await AdvancedFilter.findOne({ _id: key, channelName: normalizedChannel }).lean();
    if (!filter) throw new Error('Advanced Filter was not found.');
    const usage = await usageFor(key);
    if (usage.timers.length || usage.banners.length) {
      const parts = [];
      if (usage.timers.length) parts.push(`${usage.timers.length} timer${usage.timers.length === 1 ? '' : 's'}`);
      if (usage.banners.length) parts.push(`${usage.banners.length} pinned banner${usage.banners.length === 1 ? '' : 's'}`);
      throw new Error(`This filter is still used by ${parts.join(' and ')}. Remove or change those assignments first.`);
    }
    await AdvancedFilter.deleteOne({ _id: key, channelName: normalizedChannel }, WRITE_OPTIONS);
    await refresh();
    console.log(`[Advanced Filters] Deleted filter ${filter.name}.`);
  }

  async function initialize() {
    await refresh();
    console.log(`[Advanced Filters] Loaded ${cache.length} filter(s) from MongoDB.`);
  }

  return {
    initialize,
    refresh,
    listFilters,
    saveFilter,
    deleteFilter,
    getFilterById,
    evaluateById,
    getCurrentStreamStatus: streamStatus
  };
}

module.exports = {
  MAX_ADVANCED_FILTERS,
  MAX_ADVANCED_FILTER_NAME_LENGTH,
  MAX_FILTER_GROUPS,
  MAX_FILTER_RULES_PER_GROUP,
  MAX_FILTER_RULES_TOTAL,
  MAX_FILTER_VALUE_LENGTH,
  FILTER_FIELDS,
  FILTER_MATCHES,
  FILTER_OPERATORS,
  normalizeText,
  normalizeGroups,
  normalizeFilterInput,
  evaluateAdvancedFilter,
  describeAdvancedFilter,
  createAdvancedFilterManager
};
