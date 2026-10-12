import assert from 'node:assert/strict';
import test from 'node:test';
import { createWalkDissolve } from '../dist/walk-dissolve.js';

function harness(options = {}) {
  const events = [];
  let opacity = 0;
  const controller = createWalkDissolve({
    ...options,
    onBusy: value => events.push(['busy', value]),
    onOpacity: value => { opacity = value; events.push(['opacity', value]); },
    onComplete: () => events.push(['complete']),
  });
  const swap = () => {
    assert.equal(opacity, 1, 'the camera changes only under a fully opaque veil');
    events.push(['swap']);
  };
  return { controller, events, swap, get opacity() { return opacity; } };
}

const count = (events, type) => events.filter(event => event[0] === type).length;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('normal transition uses smooth fade, black hold and a single covered camera change', () => {
  const h = harness();
  assert.equal(h.controller.active, false);
  assert.equal(h.controller.start(h.swap), true);
  assert.equal(h.controller.active, true);
  assert.deepEqual(h.events.slice(0, 2), [['busy', true], ['opacity', 0]]);

  h.controller.update(.08);
  near(h.opacity, .15625);
  assert.equal(count(h.events, 'swap'), 0);
  h.controller.update(.08);
  near(h.opacity, .5);
  h.controller.update(.16);
  assert.equal(h.opacity, 1);
  assert.equal(count(h.events, 'swap'), 1);
  h.controller.update(.06);
  assert.equal(h.opacity, 1);
  h.controller.update(.06);
  assert.equal(h.opacity, 1);
  h.controller.update(.23);
  near(h.opacity, .5);
  assert.equal(h.controller.active, true);
  h.controller.update(.24);

  assert.equal(h.controller.active, false);
  assert.equal(h.opacity, 0);
  assert.equal(count(h.events, 'swap'), 1);
  assert.deepEqual(h.events.slice(-3), [['opacity', 0], ['busy', false], ['complete']]);
  h.controller.update(1);
  assert.equal(count(h.events, 'complete'), 1);
});

test('repeated clicks are ignored without replacing the pending destination', () => {
  const h = harness();
  let ignoredSwaps = 0;
  h.controller.start(h.swap);
  h.controller.update(.2);
  assert.equal(h.controller.start(() => { ignoredSwaps++; }), false);
  h.controller.update(.15);
  assert.equal(h.controller.start(() => { ignoredSwaps++; }), false);
  h.controller.update(1);
  assert.equal(ignoredSwaps, 0);
  assert.equal(count(h.events, 'swap'), 1);
  assert.equal(count(h.events, 'busy'), 2);
});

test('cancel before the camera change clears the veil and prevents any later change', () => {
  const h = harness();
  h.controller.start(h.swap);
  h.controller.update(.16);
  h.controller.cancel();
  assert.equal(h.controller.active, false);
  assert.equal(h.opacity, 0);
  h.controller.update(100);
  assert.equal(count(h.events, 'swap'), 0);
  assert.equal(count(h.events, 'complete'), 0);
  assert.deepEqual(h.events.slice(-2), [['opacity', 0], ['busy', false]]);
});

test('cancel after the camera change prevents completion and a second camera change', () => {
  const h = harness();
  h.controller.start(h.swap);
  h.controller.update(.5);
  assert.ok(h.opacity > 0 && h.opacity < 1);
  h.controller.cancel();
  h.controller.update(100);
  assert.equal(h.controller.active, false);
  assert.equal(h.opacity, 0);
  assert.equal(count(h.events, 'swap'), 1);
  assert.equal(count(h.events, 'complete'), 0);
  assert.deepEqual(h.events.slice(-2), [['opacity', 0], ['busy', false]]);
});

test('reduced motion keeps the covered change with shorter .08/.04/.10 phases', () => {
  const h = harness({ reducedMotion: true });
  h.controller.start(h.swap);
  h.controller.update(.04);
  near(h.opacity, .5);
  assert.equal(count(h.events, 'swap'), 0);
  h.controller.update(.04);
  assert.equal(count(h.events, 'swap'), 1);
  assert.equal(h.opacity, 1);
  h.controller.update(.02);
  assert.equal(h.opacity, 1);
  h.controller.update(.07);
  near(h.opacity, .5);
  h.controller.update(.051);
  assert.equal(h.controller.active, false);
  assert.equal(count(h.events, 'complete'), 1);
});

test('a large frame emits full black before changing the camera and finishing', () => {
  const h = harness();
  h.controller.start(h.swap);
  h.controller.update(Number.MAX_VALUE);
  assert.deepEqual(h.events, [
    ['busy', true], ['opacity', 0], ['opacity', 1], ['swap'],
    ['opacity', 0], ['busy', false], ['complete'],
  ]);
  assert.equal(h.controller.active, false);
});

test('invalid or nonpositive frame deltas do not advance or corrupt the transition', () => {
  const h = harness();
  h.controller.start(h.swap);
  for (const delta of [NaN, Infinity, -Infinity, -.1, 0, undefined, '1']) h.controller.update(delta);
  assert.equal(h.opacity, 0);
  assert.equal(count(h.events, 'swap'), 0);
  h.controller.update(.16);
  near(h.opacity, .5);
  h.controller.update(1);
  assert.equal(count(h.events, 'swap'), 1);
  assert.equal(count(h.events, 'complete'), 1);
});

test('the controller can be reused after finishing or cancelling', () => {
  const h = harness();
  h.controller.start(h.swap);
  h.controller.update(1);
  assert.equal(h.controller.start(h.swap), true);
  h.controller.update(.1);
  h.controller.cancel();
  assert.equal(h.controller.start(h.swap), true);
  h.controller.update(1);
  assert.equal(count(h.events, 'swap'), 2);
  assert.equal(count(h.events, 'complete'), 2);
  assert.equal(h.controller.active, false);
});

test('a camera-change error resets busy and opacity before being rethrown', () => {
  const h = harness();
  const error = new Error('camera change failed');
  h.controller.start(() => { h.swap(); throw error; });
  assert.throws(() => h.controller.update(.4), value => value === error);
  assert.equal(h.controller.active, false);
  assert.equal(h.opacity, 0);
  assert.deepEqual(h.events.slice(-2), [['opacity', 0], ['busy', false]]);
  h.controller.update(1);
  assert.equal(count(h.events, 'swap'), 1);
  assert.equal(count(h.events, 'complete'), 0);
  assert.equal(h.controller.start(h.swap), true);
  h.controller.update(1);
  assert.equal(count(h.events, 'complete'), 1);
});

test('cancelling within the camera change does not finish or restore a stale fade', () => {
  const h = harness();
  h.controller.start(() => { h.swap(); h.controller.cancel(); });
  h.controller.update(1);
  assert.equal(h.controller.active, false);
  assert.equal(h.opacity, 0);
  assert.equal(count(h.events, 'swap'), 1);
  assert.equal(count(h.events, 'complete'), 0);
  assert.deepEqual(h.events.slice(-2), [['opacity', 0], ['busy', false]]);
});
