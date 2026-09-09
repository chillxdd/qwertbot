'use strict';

const { fetchWithTimeout } = require('./httpClient');

const EXA_SEARCH_ENDPOINT = 'https://api.exa.ai/search';
const DEFAULT_EXA_TIMEOUT_MS = 7000;
const DEFAULT_EXA_NUM_RESULTS = 5;
const MAX_EXA_RESULTS = 8;
const MAX_EXA_HIGHLIGHT_CHARS_PER_RESULT = 1200;
const MAX_EXA_PROMPT_CHARS = 6500;

function exaApiKey() {
  return String(process.env.EXA_API_KEY || '').trim();
}

function isExaConfigured() {
  return Boolean(exaApiKey());
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function parseRetryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now());
}

function createExaError(message, { status = 0, data = null, retryAfterMs = 0, code = '' } = {}) {
  const err = new Error(message || 'Exa search failed.');
  err.name = 'ExaSearchError';
  err.status = Number(status || 0) || null;
  err.exaData = data;
  err.retryAfterMs = Math.max(0, Number(retryAfterMs || 0));
  err.code = code || data?.tag || '';
  err.retryable = err.status === 429 || err.status >= 500 || err.status === null;
  return err;
}

function normalizeResult(result = {}) {
  const highlights = Array.isArray(result.highlights)
    ? result.highlights.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  return {
    title: String(result.title || '').trim(),
    url: String(result.url || result.id || '').trim(),
    publishedDate: String(result.publishedDate || '').trim(),
    author: String(result.author || '').trim(),
    highlights
  };
}

async function searchExa(query, options = {}) {
  const key = exaApiKey();
  if (!key) {
    throw createExaError('EXA_API_KEY is not configured.', { code: 'EXA_NOT_CONFIGURED' });
  }

  const normalizedQuery = String(query || '').replace(/\s+/g, ' ').trim();
  if (!normalizedQuery) {
    throw createExaError('Exa search query is empty.', { status: 400, code: 'EXA_EMPTY_QUERY' });
  }

  const numResults = clampInteger(options.numResults, 1, MAX_EXA_RESULTS, DEFAULT_EXA_NUM_RESULTS);
  const timeoutMs = clampInteger(options.timeoutMs, 1000, 20000, DEFAULT_EXA_TIMEOUT_MS);
  let response;
  try {
    response = await fetchWithTimeout(EXA_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key
      },
      body: JSON.stringify({
        query: normalizedQuery,
        type: 'instant',
        numResults,
        moderation: true,
        contents: {
          highlights: {
            query: normalizedQuery,
            maxCharacters: MAX_EXA_HIGHLIGHT_CHARS_PER_RESULT
          }
        }
      }),
      timeoutMs,
      maxResponseBytes: 2 * 1024 * 1024
    });
  } catch (cause) {
    const err = createExaError(cause?.message || 'Exa search network request failed.', {
      code: cause?.timedOut ? 'EXA_TIMEOUT' : 'EXA_NETWORK_ERROR'
    });
    err.timedOut = Boolean(cause?.timedOut);
    err.cancelled = Boolean(cause?.cancelled);
    if (err.cancelled) err.retryable = false;
    throw err;
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  if (!response.ok) {
    const message = String(data?.error || data?.message || `Exa search returned HTTP ${response.status}.`).trim();
    throw createExaError(message, {
      status: response.status,
      data,
      retryAfterMs: parseRetryAfterMs(response),
      code: data?.tag || ''
    });
  }

  const results = Array.isArray(data?.results)
    ? data.results.map(normalizeResult).filter((result) => result.url || result.title || result.highlights.length)
    : [];

  return {
    query: normalizedQuery,
    requestId: String(data?.requestId || '').trim(),
    results
  };
}

function formatExaResultsForPrompt(searchResult, maxChars = MAX_EXA_PROMPT_CHARS) {
  const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
  if (!results.length) return '';

  const parts = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const metadata = [
      result.title ? `Title: ${result.title}` : '',
      result.url ? `URL: ${result.url}` : '',
      result.publishedDate ? `Published: ${result.publishedDate}` : '',
      result.author ? `Author: ${result.author}` : ''
    ].filter(Boolean).join('\n');
    const excerpts = result.highlights.length
      ? `Relevant excerpts:\n${result.highlights.map((value) => `- ${value}`).join('\n')}`
      : 'Relevant excerpts: (none returned)';
    parts.push(`Result ${index + 1}\n${metadata}\n${excerpts}`);
  }

  return parts.join('\n\n').slice(0, Math.max(1000, Number(maxChars) || MAX_EXA_PROMPT_CHARS));
}

module.exports = {
  EXA_SEARCH_ENDPOINT,
  DEFAULT_EXA_TIMEOUT_MS,
  DEFAULT_EXA_NUM_RESULTS,
  isExaConfigured,
  searchExa,
  formatExaResultsForPrompt
};
