'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createInitializationController } = require('../startup');

test('concurrent initialization requests share one active attempt', async () => {
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const controller = createInitializationController(async () => {
    calls += 1;
    await pending;
    return 'ready';
  });

  const startup = controller.run('startup');
  const endpoint = controller.run('endpoint');

  assert.equal(controller.isInitializing(), true);
  assert.equal(controller.getAttempt(), 1);
  assert.equal(calls, 0);

  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([startup, endpoint]), ['ready', 'ready']);
  assert.equal(controller.isInitializing(), false);
});

test('a failed attempt clears the guard and allows a deliberate retry', async () => {
  let calls = 0;
  const controller = createInitializationController(async () => {
    calls += 1;
    if (calls === 1) throw new Error('target closed');
    return 'ready';
  });

  await assert.rejects(controller.run('startup'), /target closed/);
  assert.equal(controller.isInitializing(), false);
  assert.equal(await controller.run('endpoint'), 'ready');
  assert.equal(controller.getAttempt(), 2);
});
