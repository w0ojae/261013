import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {CodropsPhysics, MAX_RADIUS} from '../dist/rain/codrops-physics.js';
import {HeartfeltRain} from '../dist/rain/heartfelt-rain.js';
import {headPosition, HeartfeltField} from '../dist/rain/heartfelt-field.js';
import {BeadField} from '../dist/rain/bead-field.js';
import {TrailMemory} from '../dist/rain/trail-memory.js';
import {createRainPane, SIMULATION_STEP} from '../dist/rain/simulation.js';
import {glassPanes} from '../dist/glass-panes.js';

const random = (seed = 761) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const near = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const context = () => ({
  createImageData: (w, h) => ({data: new Uint8ClampedArray(w * h * 4)}),
  getImageData: (x, y, w, h) => ({data: new Uint8ClampedArray(w * h * 4)}),
  save() {}, restore() {}, clearRect() {}, fillRect() {}, putImageData() {}, drawImage() {},
  setTransform() {}, translate() {}, rotate() {}, beginPath() {}, moveTo() {},
  quadraticCurveTo() {}, lineTo() {}, ellipse() {}, arc() {}, fill() {}, stroke() {},
});
const canvas = (width, height) => {
  const ctx = context();
  return {width, height, getContext: () => ctx};
};

test('moving droplets coalesce through the real collision grid and retain 80% of absorbed area', () => {
  const p = new CodropsPhysics(850, 346, random());
  p.setRainIntensity(0); p.setPathNoise(0);
  const a = p.drop(300, 100, 7, true), b = p.drop(301, 100, 4);
  a.nextSpawn = b.nextSpawn = 1e9; p.drops = [a, b];
  p.step(SIMULATION_STEP);
  assert.equal(p.drops.length, 1);
  assert.equal(p.merges, 1);
  near(a.r ** 2, 49 + 16 * .8);
  assert.ok(a.shape.pulseVelocity < 0, 'a merge should pulse the shared droplet shape');
  assert.ok(a.flowing && a.y > 100);
});

test('microbead contact adds proportional momentum and caps ordinary merged radii', () => {
  const p = new CodropsPhysics(850, 346, random());
  const d = p.drop(100, 100, 8);
  p.absorbMicro(d, [{x: 102, y: 100, r: 1}]);
  assert.ok(d.slide > 0 && d.slide < .02);
  assert.ok(d.vy > 0 && d.vy < d.fallSpeed * .02);
  p.absorbMicro(d, [{x: 100, y: 100, r: 100}]);
  assert.equal(d.r, MAX_RADIUS);
});

test('adhesion stops both axes, pause freezes the hold, and expiration restarts runoff', () => {
  const p = new CodropsPhysics(2000, 2000, () => .99);
  p.setRainIntensity(0);
  const d = p.drop(400, 100, 8, true); d.nextSpawn = 1e9; p.drops = [d];
  for (let i = 0; i < 600 && d.flowing; i++) p.step(1 / 60);
  assert.equal(d.flowing, false);
  assert.equal(d.vx, 0); assert.equal(d.vy, 0);
  assert.ok(d.restTime >= .5 && d.restTime <= 1);
  const stopped = [d.x, d.y, d.restTime]; p.active = false;
  for (let i = 0; i < 120; i++) p.step(1 / 60);
  assert.deepEqual([d.x, d.y, d.restTime], stopped);
  p.active = true;
  for (let i = 0; i < 65 && !d.flowing; i++) p.step(1 / 60);
  assert.ok(d.flowing && d.y > stopped[1]);
});

test('the adapted calculation never reads air-force or music state', async () => {
  const p = new CodropsPhysics(850, 346, random());
  for (const name of ['wind', 'windTarget', 'music']) Object.defineProperty(p, name, {
    get() { throw new Error(`Unexpected ${name} calculation`); },
    set() { throw new Error(`Unexpected ${name} calculation`); },
  });
  const rain = new HeartfeltRain();
  for (const name of ['wind', 'drift']) Object.defineProperty(rain, name, {
    get() { throw new Error(`Unexpected ${name} calculation`); },
  });
  const field = new HeartfeltField({canvasFactory: canvas});
  const map = {physics: p, massScale: .1, beads: new BeadField(22200), coalesce() { return false; }};
  field.seed(850, 346, map);
  for (let i = 0; i < 60; i++) {
    rain.update(SIMULATION_STEP); field.step(rain, p, map); p.step(SIMULATION_STEP);
  }
  near(rain.time, 12.4); near(rain.staticTime, 12.4); assert.equal(rain.amount, .65);
  assert.ok(Number.isFinite(headPosition(0, 0, 1, rain, 850, 346).x));
  assert.ok(p.drops.some(d => d.heartfelt), 'the original Heartfelt heads should be present');
  const directory = new URL('../dist/rain/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.js'))) {
    const code = (await readFile(new URL(name, directory), 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /\b(?:wind|windVx|windTarget|music|takeWind|releaseWind)\b/, name);
  }
});

test('five production pane sizes remain finite and within the quiet population budget', () => {
  for (const [width, height] of glassPanes.map(({size})=>size.map(value=>Math.round(value*256)))) {
    const p = new CodropsPhysics(width, height, random(width));
    const limit = Math.round(Math.max(120, Math.min(280, width * height / 3000)));
    for (let tick = 0; tick < 900; tick++) {
      p.step(SIMULATION_STEP);
      assert.ok(p.drops.length <= limit);
      for (const d of p.drops) {
        assert.ok([d.x, d.y, d.r, d.vx, d.vy, d.mass].every(Number.isFinite));
        assert.ok(d.r > 0 && d.r <= MAX_RADIUS && d.vy >= 0);
      }
    }
  }
});

test('trail age affects only touched pixels and fully clears after recovery', () => {
  const memory = new TrailMemory(20, 20), pixels = new Uint8ClampedArray(20 * 20 * 4);
  memory.stamp(4, 4, 4, 10, 2); memory.stamp(15, 4, 15, 10, 2);
  memory.advance(2); memory.stamp(4, 4, 4, 10, 2); memory.advance(.5); memory.render(pixels);
  assert.equal(pixels[(6 * 20 + 4) * 4 + 3], 255);
  assert.equal(pixels[(6 * 20 + 15) * 4 + 3], 0);
  memory.advance(2.5); memory.render(pixels);
  assert.ok(pixels.every((v, i) => i % 4 !== 3 || v === 0));
});

test('the pane wrapper accumulates at 60 FPS, freezes, bounds catch-up, and releases maps', async () => {
  const oldDocument = globalThis.document, oldImage = globalThis.Image;
  globalThis.document = {createElement: () => canvas(1, 1)};
  globalThis.Image = class {
    set src(value) { queueMicrotask(() => this.onload()); }
  };
  let pane;
  try {
    pane = await createRainPane({width: 166, height: 256});
    const mapCanvas = pane.map.canvas;
    for (let frame = 0; frame < 60; frame++) { pane.setActive(true); pane.update(1 / 60); }
    near(pane.rain.time, 12.2);
    assert.equal(pane.map.canvas, mapCanvas, 'texture canvases must remain stable');
    pane.setActive(false);
    const paused = [pane.rain.time, pane.map.revision, pane.map.maskRevision];
    for (let frame = 0; frame < 60; frame++) pane.update(1 / 60);
    assert.deepEqual([pane.rain.time, pane.map.revision, pane.map.maskRevision], paused);
    pane.setActive(true); pane.update(10);
    near(pane.rain.time - paused[0], SIMULATION_STEP * 2 * .2);
    const resumed = pane.rain.time;
    pane.update(1 / 60); pane.setActive(true); pane.update(1 / 60);
    near(pane.rain.time - resumed, SIMULATION_STEP * .2);
    pane.dispose(); pane.dispose();
    assert.equal(pane.update(1), false);
    assert.equal(mapCanvas.width, 1); assert.equal(mapCanvas.height, 1);
    assert.equal(pane.physics.drops.length, 0); assert.equal(pane.map.beads.count, 0);
  } finally {
    pane?.dispose();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldImage === undefined) delete globalThis.Image; else globalThis.Image = oldImage;
  }
});
