import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rooms } from '../dist/rooms-building2.js';

// Use the shipped Three.js module without installing a package or changing dist.
const controllerUrl = new URL('../dist/first-person-dissolve.js', import.meta.url);
const threeUrl = new URL('../dist/vendor/three.module.js', import.meta.url).href;
const source = await readFile(controllerUrl, 'utf8');
assert.match(source, /from ['"]three['"]/u, 'The controller must still import Three.js.');
const rewritten = source.replace(/from ['"]three['"]/u, `from ${JSON.stringify(threeUrl)}`);
const { PLAYER_RADIUS, clampToBounds, cylinderIntersectsObstacle, moveWithCollisions, createFirstPerson } =
  await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`);

const tolerance = 1e-7;
const near = (actual, expected, message, error = tolerance) =>
  assert.ok(Math.abs(actual - expected) <= error, `${message}: expected ${expected}, got ${actual}`);

// Independent geometric oracle: distance from the player center to each obstacle.
function assertSafe(position, room, label) {
  const { bounds, obstacles = [] } = room;
  assert.ok(Number.isFinite(position.x) && Number.isFinite(position.z), `${label}: finite position`);
  assert.ok(position.x >= bounds.minX + PLAYER_RADIUS - tolerance, `${label}: left edge`);
  assert.ok(position.x <= bounds.maxX - PLAYER_RADIUS + tolerance, `${label}: right edge`);
  assert.ok(position.z >= bounds.minZ + PLAYER_RADIUS - tolerance, `${label}: rear edge`);
  assert.ok(position.z <= bounds.maxZ - PLAYER_RADIUS + tolerance, `${label}: front edge`);
  for (const [index, obstacle] of obstacles.entries()) {
    const gapX = Math.max(obstacle.minX - position.x, 0, position.x - obstacle.maxX);
    const gapZ = Math.max(obstacle.minZ - position.z, 0, position.z - obstacle.maxZ);
    assert.ok(Math.hypot(gapX, gapZ) >= PLAYER_RADIUS - tolerance,
      `${label}: penetrated obstacle ${index}`);
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

let randomStepCount = 0;
for (const [floor, room] of Object.entries(rooms)) {
  assertSafe(room.spawn, room, `${floor}F spawn`);
  assert.deepEqual(clampToBounds(room.spawn, room.bounds), { x: room.spawn.x, z: room.spawn.z },
    `${floor}F spawn must not be silently repositioned`);
  for (const obstacle of room.obstacles) {
    assert.equal(cylinderIntersectsObstacle(room.spawn.x, room.spawn.z, PLAYER_RADIUS, obstacle), false,
      `${floor}F spawn intersects furniture`);
  }

  // Use clear rear/right aisles so furniture cannot mask a perimeter failure.
  const rear = room.bounds.minZ + PLAYER_RADIUS + 0.025;
  const right = room.bounds.maxX - PLAYER_RADIUS - 0.025;
  const perimeterCases = [
    [{ x: room.spawn.x, z: rear }, -50, 0, 'x', room.bounds.minX + PLAYER_RADIUS],
    [{ x: room.spawn.x, z: rear }, 50, 0, 'x', room.bounds.maxX - PLAYER_RADIUS],
    [{ x: right, z: room.spawn.z }, 0, -50, 'z', room.bounds.minZ + PLAYER_RADIUS],
    [{ x: right, z: room.spawn.z }, 0, 50, 'z', room.bounds.maxZ - PLAYER_RADIUS],
  ];
  for (const [start, dx, dz, axis, expected] of perimeterCases) {
    assertSafe(start, room, `${floor}F perimeter start`);
    const result = moveWithCollisions(start, dx, dz, room);
    assertSafe(result, room, `${floor}F large ${axis} movement`);
    near(result[axis], expected, `${floor}F reaches perimeter`);
    assert.equal(result.blocked, true, `${floor}F reports perimeter collision`);
    assert.equal(result[axis === 'x' ? 'blockedX' : 'blockedZ'], true);
  }

  const random = seededRandom(0xCAFE0000 + Number(floor));
  let position = { ...room.spawn };
  for (let index = 0; index < 10000; index++) {
    // Mix ordinary walking with occasional frame stalls / unusually large requests.
    const distance = index % 127 === 0 ? 0.5 + random() * 3 : 0.005 + random() * 0.08;
    const angle = random() * Math.PI * 2;
    const before = { ...position };
    const result = moveWithCollisions(position, Math.cos(angle) * distance, Math.sin(angle) * distance, room);
    assert.deepEqual(position, before, `${floor}F movement mutated its input`);
    assertSafe(result, room, `${floor}F random step ${index}`);
    position = { ...result, y: room.spawn.y };
    randomStepCount++;
  }
}

// Exercise an actual 1F stool, including an axis slide along its straight side.
const downstairs = rooms[1];
assert.ok(downstairs.obstacles.length > 0, '1F regression requires actual furniture obstacles.');
const stool = downstairs.obstacles[0];
const stoolStart = { x: stool.maxX + PLAYER_RADIUS + 0.06, z: (stool.minZ + stool.maxZ) / 2 };
assertSafe(stoolStart, downstairs, 'stool approach');
const stopped = moveWithCollisions(stoolStart, -20, 0, downstairs);
assertSafe(stopped, downstairs, 'large movement toward stool');
near(stopped.x, stool.maxX + PLAYER_RADIUS, 'large movement stops at stool instead of tunnelling', 0.00003);
near(stopped.z, stoolStart.z, 'head-on collision preserves Z');
assert.equal(stopped.blockedX, true);
assert.equal(stopped.blockedZ, false);
const slid = moveWithCollisions(stoolStart, -2, 0.08, downstairs);
assertSafe(slid, downstairs, 'stool slide');
near(slid.z, stoolStart.z + 0.08, 'blocked X still permits movement along Z');
near(slid.x, stool.maxX + PLAYER_RADIUS, 'sliding remains outside stool', 0.00003);
assert.equal(slid.blockedX, true);
assert.equal(slid.blockedZ, false);

// A very thin partition catches regressions that merely check the final endpoint.
const thinWallRoom = {
  bounds: { minX: -5, maxX: 5, minZ: -2, maxZ: 2 },
  obstacles: [{ minX: 0, maxX: 0.001, minZ: -1.9, maxZ: 1.9 }],
};
for (const [startX, dx, expectedX] of [[-2, 4, -PLAYER_RADIUS], [2, -4, 0.001 + PLAYER_RADIUS]]) {
  const result = moveWithCollisions({ x: startX, z: 0 }, dx, 0, thinWallRoom);
  assertSafe(result, thinWallRoom, 'thin partition');
  near(result.x, expectedX, 'cannot tunnel through a 1 mm partition', 0.00003);
}

// Check the shipped controller also preserves standing height when walking/looking.
const previousGlobals = { window: globalThis.window, document: globalThis.document };
const fakeDocument = Object.assign(new EventTarget(), { hidden: false, activeElement: null, querySelector: () => null });
const attributes = new Map();
const canvas = Object.assign(new EventTarget(), {
  getAttribute: name => attributes.get(name) ?? null,
  hasAttribute: name => attributes.has(name),
  setAttribute: (name, value) => attributes.set(name, value),
  removeAttribute: name => attributes.delete(name),
  focus: () => { fakeDocument.activeElement = canvas; },
});
globalThis.window = new EventTarget();
globalThis.document = fakeDocument;
let controller;
try {
  controller = createFirstPerson({ canvas });
  for (const [floor, room] of Object.entries(rooms)) {
    controller.enter(Number(floor), room);
    near(controller.camera.position.y, room.spawn.y, `${floor}F standing height at entry`);
    controller.setMove('forward', true);
    controller.setMove('right', true);
    for (let index = 0; index < 300; index++) {
      controller.look(0.027, index % 2 ? 0.01 : -0.01);
      controller.update(0.05);
      near(controller.camera.position.y, room.spawn.y, `${floor}F fixed walking height`);
      assertSafe(controller.camera.position, room, `${floor}F controller update ${index}`);
    }
    controller.exit();
  }
} finally {
  controller?.dispose();
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

console.log(`Navigation passed: ${Object.keys(rooms).length} rooms, ${randomStepCount.toLocaleString('en-US')} deterministic steps, perimeter, stool sliding, no tunnelling, fixed eye height.`);
