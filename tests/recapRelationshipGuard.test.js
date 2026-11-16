'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRecapEvidence } = require('../services/attributionAudit');

function supportedResult(evidenceIds) {
  return new Map([['S1', {
    supported: true,
    reason: '',
    replacement: '',
    evidenceIds
  }]]);
}

test('rejects a while-relationship assembled from two independent supported facts', () => {
  const sentence = 'Heatmor had Adaptability while Beldum evolved.';
  const events = [
    { sourceEventId: 'heatmor', type: 'gameplay', text: 'Heatmor had Adaptability.' },
    { sourceEventId: 'beldum', type: 'gameplay', text: 'Beldum evolved.' }
  ];
  const results = validateRecapEvidence(
    [sentence],
    supportedResult(['EHEATMOR', 'EBELDUM']),
    [],
    events,
    [],
    'recap'
  );
  const result = results.get('S1');

  assert.equal(result.supported, false);
  assert.match(result.reason, /temporal\/associative connector/i);
  assert.equal(result.replacement, 'Heatmor had Adaptability. Beldum evolved.');
});

test('does not accept an unrelated cited source merely because it contains a timeline word', () => {
  const sentence = 'Heatmor had Adaptability while Beldum evolved.';
  const events = [
    { sourceEventId: 'heatmor', type: 'gameplay', text: 'Heatmor had Adaptability after the ability check.' },
    { sourceEventId: 'beldum', type: 'gameplay', text: 'Beldum evolved.' }
  ];
  const results = validateRecapEvidence(
    [sentence],
    supportedResult(['EHEATMOR', 'EBELDUM']),
    [],
    events,
    [],
    'recap'
  );

  assert.equal(results.get('S1').supported, false);
});

test('keeps a relationship when one cited source explicitly states it', () => {
  const sentence = 'Beldum evolved while Heatmor had Adaptability.';
  const events = [
    { sourceEventId: 'relation', type: 'gameplay', text: 'Beldum evolved while Heatmor had Adaptability.' }
  ];
  const results = validateRecapEvidence(
    [sentence],
    supportedResult(['ERELATION']),
    [],
    events,
    [],
    'recap'
  );

  assert.equal(results.get('S1').supported, true);
});

test('does not treat ordinary grammatical "as" as an unsupported sequence connector', () => {
  const sentence = 'Heatmor was described as a strong option.';
  const events = [
    { sourceEventId: 'heatmor', type: 'gameplay', text: 'Heatmor was described as a strong option.' }
  ];
  const results = validateRecapEvidence(
    [sentence],
    supportedResult(['EHEATMOR']),
    [],
    events,
    [],
    'recap'
  );

  assert.equal(results.get('S1').supported, true);
});

test('does not turn a prediction result into unsupported Channel Point betting activity', () => {
  const sentence = "Chat discussed Heatmor's moveset while placing Channel Point bets on the gym prediction after a Beldum evolution run.";
  const events = [
    { sourceEventId: 'heatmor', type: 'gameplay', text: "Heatmor's moveset and Adaptability were discussed." },
    { sourceEventId: 'prediction', type: 'channel.prediction.end', text: 'The gym prediction resolved as a loss.' },
    { sourceEventId: 'beldum', type: 'gameplay', text: 'Beldum evolved.' }
  ];
  const results = validateRecapEvidence(
    [sentence],
    supportedResult(['EHEATMOR', 'EPREDICTION', 'EBELDUM']),
    [],
    events,
    [],
    'recap'
  );
  const result = results.get('S1');

  assert.equal(result.supported, false);
  assert.match(result.reason, /does not establish that viewers placed bets/i);
  assert.equal(result.replacement, "Chat discussed Heatmor's moveset.");
});
