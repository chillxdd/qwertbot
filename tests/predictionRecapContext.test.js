'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyGymPredictionResult,
  extractPredictionResults,
  buildPredictionTrendEvent,
  withPredictionTrendEvent,
  buildPredictionEventMetadata
} = require('../services/predictionRecapContext');

function predictionEvent({ id, timestamp, title = 'Will we beat the next gym?', outcome }) {
  const gymResult = classifyGymPredictionResult(title, outcome);
  return {
    sourceEventId: id,
    timestamp,
    type: 'channel.prediction.end',
    text: `Gym prediction "${title}" resolved as a gym ${gymResult || 'result'} (winning outcome: ${outcome}).`,
    metadata: {
      predictionId: id,
      predictionTitle: title,
      winningOutcome: outcome,
      status: 'resolved',
      gymResult
    }
  };
}

function storedResult({ id, timestamp, outcome, title = 'Will we beat the next gym?' }) {
  return {
    predictionId: id,
    sourceEventId: id,
    timestamp,
    title,
    outcome,
    status: 'resolved'
  };
}

test('interprets positive gym questions instead of repeating bare Yes/No outcomes', () => {
  assert.equal(classifyGymPredictionResult('Will we beat the next gym?', 'Yes'), 'win');
  assert.equal(classifyGymPredictionResult('Will we beat the next gym?', 'No'), 'loss');
});

test('inverts Yes/No meaning for negative gym questions', () => {
  assert.equal(classifyGymPredictionResult('Will we lose to the next gym?', 'Yes'), 'loss');
  assert.equal(classifyGymPredictionResult('Will we wipe at the next gym?', 'No'), 'win');
});

test('does not mistake a Pokemon-casualty prediction for a gym win/loss result', () => {
  assert.equal(classifyGymPredictionResult('Will we lose a Pokemon in the next gym?', 'No'), '');
  assert.equal(classifyGymPredictionResult('Will we beat the next gym without losing anyone?', 'Yes'), 'win');
});

test('does not misclassify a direct Defeat outcome as a win', () => {
  assert.equal(classifyGymPredictionResult('Next gym result', 'Defeat'), 'loss');
});

test('classifies the raw Twitch EventSub winning outcome metadata', () => {
  const metadata = buildPredictionEventMetadata({
    id: 'prediction-1',
    title: 'Will we beat the next gym?',
    winning_outcome_id: 'outcome-no',
    outcomes: [
      { id: 'outcome-yes', title: 'Yes', channel_points: 500 },
      { id: 'outcome-no', title: 'No', channel_points: 900 }
    ]
  });

  assert.equal(metadata.predictionId, 'prediction-1');
  assert.equal(metadata.winningOutcome, 'No');
  assert.equal(metadata.gymResult, 'loss');
});

test('extracts structured gym results from current EventSub records', () => {
  const results = extractPredictionResults([
    predictionEvent({ id: 'p1', timestamp: 1000, outcome: 'No' })
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].gymResult, 'loss');
  assert.equal(results[0].predictionId, 'p1');
});

test('derives an exact gym losing streak across previous recap windows', () => {
  const previousRecaps = [
    { predictionResults: [storedResult({ id: 'p1', timestamp: 1000, outcome: 'No' })] },
    { predictionResults: [storedResult({ id: 'p2', timestamp: 2000, outcome: 'No' })] }
  ];
  const current = [predictionEvent({ id: 'p3', timestamp: 3000, outcome: 'No' })];
  const derived = buildPredictionTrendEvent(current, previousRecaps);

  assert.ok(derived);
  assert.equal(derived.type, 'derived.prediction.gym_streak');
  assert.equal(derived.metadata.transition, 'extended_streak');
  assert.equal(derived.metadata.gymResult, 'loss');
  assert.equal(derived.metadata.streakLength, 3);
  assert.match(derived.text, /three gym predictions all resolved as losses/i);
  assert.match(derived.text, /losing streak to 3/i);
});

test('identifies when a gym win snaps a prior losing streak', () => {
  const previousRecaps = [
    {
      predictionResults: [
        storedResult({ id: 'p1', timestamp: 1000, outcome: 'No' }),
        storedResult({ id: 'p2', timestamp: 2000, outcome: 'No' }),
        storedResult({ id: 'p3', timestamp: 3000, outcome: 'No' })
      ]
    }
  ];
  const current = [predictionEvent({ id: 'p4', timestamp: 4000, outcome: 'Yes' })];
  const events = withPredictionTrendEvent(current, previousRecaps);
  const derived = events.find((event) => event.type === 'derived.prediction.gym_streak');

  assert.ok(derived);
  assert.equal(events.some((event) => event.type === 'channel.prediction.end'), false);
  assert.equal(derived.metadata.transition, 'snapped_streak');
  assert.equal(derived.metadata.gymResult, 'win');
  assert.equal(derived.metadata.priorStreakLength, 3);
  assert.match(derived.text, /snapping a 3-loss streak/i);
});

test('does not create a gym streak from unrelated predictions', () => {
  const current = [predictionEvent({
    id: 'p1',
    timestamp: 1000,
    title: 'Will we catch the shiny today?',
    outcome: 'Yes'
  })];
  assert.equal(buildPredictionTrendEvent(current, []), null);
});
