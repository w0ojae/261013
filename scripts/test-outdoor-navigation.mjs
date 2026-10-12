import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../dist/vendor/three.module.js';
import { createEnvironment } from '../dist/environment-garden.js';
import { modelScale, modelPosition, sourceHeightOffset, groundY } from '../dist/building-placement.js';
import { rooms } from '../dist/rooms-building2.js';
import { createOutdoorZone, indoorDoor, doorIndoorSpawn, exteriorDoor, isWithinDoorTrigger } from '../dist/walk-zones.js';

const near = (actual, expected, label, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);

// Execute the actual shipped loader, including sanitized node names and split
// material primitives. Data imports only replace the browser's Three import map.
const vendor = new URL('../dist/vendor/', import.meta.url);
const threeURL = new URL('three.module.js', vendor).href;
const asData = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const utilsURL = asData((await readFile(new URL('utils/BufferGeometryUtils.js', vendor), 'utf8'))
  .replace(/from ['"]three['"]/gu, `from ${JSON.stringify(threeURL)}`));
const loaderURL = asData((await readFile(new URL('loaders/GLTFLoader.js', vendor), 'utf8'))
  .replace(/from ['"]three['"]/gu, `from ${JSON.stringify(threeURL)}`)
  .replace(/from ['"]\.\.\/utils\/BufferGeometryUtils\.js['"]/gu, `from ${JSON.stringify(utilsURL)}`));
const { GLTFLoader } = await import(loaderURL);
const bytes = await readFile(new URL('../dist/assets/building2.glb', import.meta.url));
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolve, reject));
gltf.scene.position.y -= sourceHeightOffset;
const model = new THREE.Group();
model.scale.setScalar(modelScale);
model.position.copy(modelPosition);
model.add(gltf.scene);
const scene = new THREE.Scene();
scene.add(model);
const environment = createEnvironment(THREE, scene, { width: 11.4, depth: 12, height: 5.4, pathStart: 3.1, groundY });
const outdoors = createOutdoorZone(THREE, environment, model);

// Import the real controller through the shipped Three build, matching the
// browser import map without requiring an npm-installed second Three version.
const controllerSource = await readFile(new URL('../dist/first-person-dissolve.js', import.meta.url), 'utf8');
const rewritten = controllerSource.replace(/from ['"]three['"]/u,
  `from ${JSON.stringify(new URL('../dist/vendor/three.module.js', import.meta.url).href)}`);
const { PLAYER_RADIUS, moveWithCollisions, createFirstPerson } =
  await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`);

function assertSafe(point, zone, label) {
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.z), `${label}: finite position`);
  assert.ok(point.x >= zone.bounds.minX + PLAYER_RADIUS - 1e-7 && point.x <= zone.bounds.maxX - PLAYER_RADIUS + 1e-7, `${label}: X perimeter`);
  assert.ok(point.z >= zone.bounds.minZ + PLAYER_RADIUS - 1e-7 && point.z <= zone.bounds.maxZ - PLAYER_RADIUS + 1e-7, `${label}: Z perimeter`);
  zone.obstacles.forEach((obstacle, index) => {
    const dx = Math.max(obstacle.minX - point.x, 0, point.x - obstacle.maxX);
    const dz = Math.max(obstacle.minZ - point.z, 0, point.z - obstacle.maxZ);
    assert.ok(Math.hypot(dx, dz) >= PLAYER_RADIUS - 1e-7, `${label}: obstacle ${index}`);
  });
}
assertSafe(outdoors.spawn, outdoors, 'Exterior spawn');
assertSafe(doorIndoorSpawn.spawn, doorIndoorSpawn, 'Return café spawn');
assert.ok(isWithinDoorTrigger(doorIndoorSpawn.spawn, indoorDoor), 'Returned indoor player can use the door immediately');
assert.equal(isWithinDoorTrigger(outdoors.spawn, outdoors.door), false, 'Front-porch spawn does not activate the separate right-wall entry');
assert.equal(outdoors.door, exteriorDoor, 'The outside controller uses the real right-wall doorway trigger');
assert.equal(doorIndoorSpawn.spawn.y, rooms[1].spawn.y, 'Return spawn preserves 1F eye height');
near(Math.cos(doorIndoorSpawn.yaw), 1, 'Returning player faces into the café');
near(Math.cos(outdoors.yaw), -1, 'Exiting player faces the garden');

// Keep the interior's original circular trigger, independently of the narrow
// rectangular approach to the half-open exterior door.
assert.ok(isWithinDoorTrigger({ x: indoorDoor.x + indoorDoor.radius * .99, z: indoorDoor.z }, indoorDoor));
assert.equal(isWithinDoorTrigger({ x: indoorDoor.x + indoorDoor.radius + .01, z: indoorDoor.z }, indoorDoor), false);
assert.equal(isWithinDoorTrigger({ x: indoorDoor.x + indoorDoor.radius * .8, z: indoorDoor.z + indoorDoor.radius * .8 }, indoorDoor), false);
const actualDoorGap = { x: 2.09, z: 1.03 };
assert.ok(isWithinDoorTrigger(actualDoorGap, outdoors.door), 'The measured open gap of Cylinder.485 activates exterior entry');
for (const point of [
  { x: 1.22, z: 2 }, { x: 1.22, z: 2.5 }, { x: .2, z: 2 },
  { x: 3.5, z: 1.03 }, { x: 2.09, z: 1.6 }, { x: 2.09, z: .5 },
]) assert.equal(isWithinDoorTrigger(point, outdoors.door), false,
  `Front/left openings and points away from the real doorway do not trigger (${point.x},${point.z})`);
const { minX: doorMinX, maxX: doorMaxX, minZ: doorMinZ, maxZ: doorMaxZ } = outdoors.door.bounds;
for (const point of [
  { x: doorMinX - .0001, z: actualDoorGap.z }, { x: doorMaxX + .0001, z: actualDoorGap.z },
  { x: actualDoorGap.x, z: doorMinZ - .0001 }, { x: actualDoorGap.x, z: doorMaxZ + .0001 },
]) assert.equal(isWithinDoorTrigger(point, outdoors.door), false, 'The exterior trigger does not spill past a narrow approach edge');
for (const point of [null, { x: NaN, z: 1.03 }, { x: 2.09, z: Infinity }]) {
  assert.equal(isWithinDoorTrigger(point, outdoors.door), false, 'Invalid positions cannot activate a doorway');
}

// A separate Three Raycaster is the height oracle. It intersects actual slab
// faces; it does not reuse the walk zone's barycentric support implementation.
const foundation = [];
model.traverse(mesh => {
  if (!mesh.isMesh || mesh.material?.name !== 'Material.019') return;
  let authoredNode = mesh;
  while (authoredNode && authoredNode.userData.name !== 'Cube.107') authoredNode = authoredNode.parent;
  if (!authoredNode) return;
  assert.equal(authoredNode.name.includes('.'), false, 'Foundation uses the real loader-sanitized runtime name');
  const oracle = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  oracle.matrixAutoUpdate = false;
  oracle.matrixWorld.copy(mesh.matrixWorld);
  foundation.push(oracle);
});
assert.ok(foundation.length > 0, 'Original authored foundation found');
const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
function supportFromModel(x, z) {
  ray.set(new THREE.Vector3(x, groundY + .6, z), down);
  return Math.max(groundY, ...ray.intersectObjects(foundation, false).map(hit => hit.point.y));
}
const supportPoints = [
  { x: 1.22, z: 2, label: 'porch' },
  { x: 1.22, z: 3.5, label: 'lower entrance step' },
  { x: 1.22, z: 4.3, label: 'garden lawn' },
];
for (const point of supportPoints) {
  assertSafe(point, outdoors, point.label);
  near(outdoors.heightAt(point.x, point.z), supportFromModel(point.x, point.z), `${point.label} support matches actual GLB`);
}
assert.ok(outdoors.heightAt(1.22, 2) > outdoors.heightAt(1.22, 3.5) + .1, 'Porch and lower step are distinct levels');
assert.ok(outdoors.heightAt(1.22, 3.5) > groundY + .1, 'Entrance step is above the lawn');
near(outdoors.heightAt(1.22, 4.3), groundY, 'Open garden uses lawn height');
near(outdoors.spawn.y, supportFromModel(outdoors.spawn.x, outdoors.spawn.z) + outdoors.eyeHeight, 'Outside spawn stands on real porch');

// Walk from the existing 1F starting point toward the front-right door. The
// trigger must be reachable before the original indoor wall boundary stops us.
const doorApproach = moveWithCollisions(rooms[1].spawn, indoorDoor.x - rooms[1].spawn.x, 10, rooms[1]);
assertSafe(doorApproach, rooms[1], 'Indoor door approach');
assert.ok(isWithinDoorTrigger(doorApproach, indoorDoor), 'Indoor door prompt is reachable');
const gardenToDoor = moveWithCollisions({ x: outdoors.spawn.x, z: 4.5 }, 0, -10, outdoors);
assertSafe(gardenToDoor, outdoors, 'Garden door approach');
assert.equal(isWithinDoorTrigger(gardenToDoor, outdoors.door), false, 'Walking straight back to the old fixed front opening does not activate entry');

// Approach the actual open gap from the right with normal player-sized steps.
// A broad AABB around the diagonal door leaf would falsely block this route.
let doorRoutePosition = { ...outdoors.spawn };
const doorRoute = [{ x: 3, z: outdoors.spawn.z }, { x: 3, z: .90 }, { x: actualDoorGap.x, z: .90 }, actualDoorGap];
for (const waypoint of doorRoute) {
  for (let step = 0; step < 300 && Math.hypot(waypoint.x - doorRoutePosition.x, waypoint.z - doorRoutePosition.z) > 1e-7; step++) {
    const dx = waypoint.x - doorRoutePosition.x, dz = waypoint.z - doorRoutePosition.z;
    const scale = Math.min(1, .04 / Math.hypot(dx, dz));
    doorRoutePosition = moveWithCollisions(doorRoutePosition, dx * scale, dz * scale, outdoors);
    assertSafe(doorRoutePosition, outdoors, 'Actual right-hand doorway approach');
    assert.equal(doorRoutePosition.blocked, false, 'The open gap is reachable without walking through the door leaf');
  }
  near(doorRoutePosition.x, waypoint.x, 'Doorway approach waypoint X');
  near(doorRoutePosition.z, waypoint.z, 'Doorway approach waypoint Z');
}
assert.ok(isWithinDoorTrigger(doorRoutePosition, outdoors.door), 'Outside return prompt is reachable at the actual open door');

// Raycast the original half-open leaf, independently of its new collision
// strips. Precision must open the empty gap without making the leaf passable.
const doorLeaf = [];
model.traverse(mesh => {
  if (!mesh.isMesh) return;
  let authoredNode = mesh;
  while (authoredNode && authoredNode.userData.name !== 'Cylinder.485') authoredNode = authoredNode.parent;
  if (!authoredNode) return;
  const oracle = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  oracle.matrixAutoUpdate = false;
  oracle.matrixWorld.copy(mesh.matrixWorld);
  doorLeaf.push(oracle);
});
assert.ok(doorLeaf.length, 'Original authored half-open door geometry found');
const leafStart = { x: 3.7, z: 1.4 };
assertSafe(leafStart, outdoors, 'Actual door leaf approach');
ray.set(new THREE.Vector3(leafStart.x, groundY + .7, leafStart.z), new THREE.Vector3(-1, 0, 0));
const leafHit = ray.intersectObjects(doorLeaf, false)[0];
assert.ok(leafHit, 'The original GLB has solid door-leaf wood across this approach');
assert.ok(leafHit.point.x > outdoors.obstacles[0].maxX + .1, 'The ray hits the swung-out leaf before the building wall');
const leafStop = moveWithCollisions(leafStart, -3, 0, outdoors);
assertSafe(leafStop, outdoors, 'Actual door leaf collision');
assert.equal(leafStop.blocked, true, 'The solid diagonal door leaf still blocks the player');
assert.ok(leafStop.x >= leafHit.point.x + PLAYER_RADIUS * .8, 'Collision retains clearance before the actual rendered door leaf');
assert.ok(leafStop.x < leafHit.point.x + PLAYER_RADIUS + .2, 'The player stops near the leaf rather than an oversized empty-area box');

// Large movements exercise continuous substeps against the building and all
// garden boundaries instead of testing only the final position.
const building = outdoors.obstacles[0];
for (const [start, dx, dz, axis, expected] of [
  [{ x: 3.7, z: -1 }, -25, 0, 'x', building.maxX + PLAYER_RADIUS],
  [{ x: 1.22, z: 4.5 }, 0, -25, 'z', building.maxZ + PLAYER_RADIUS],
  [{ x: 0, z: -5.8 }, 0, 25, 'z', building.minZ - PLAYER_RADIUS],
  [{ x: 3.7, z: 4.5 }, 25, 0, 'x', outdoors.bounds.maxX - PLAYER_RADIUS],
  [{ x: -5.8, z: 4.5 }, -25, 0, 'x', outdoors.bounds.minX + PLAYER_RADIUS],
  [{ x: 3.7, z: 4.5 }, 0, 25, 'z', outdoors.bounds.maxZ - PLAYER_RADIUS],
  [{ x: 3.7, z: -5.8 }, 0, -25, 'z', outdoors.bounds.minZ + PLAYER_RADIUS],
]) {
  assertSafe(start, outdoors, 'Large movement start');
  const end = moveWithCollisions(start, dx, dz, outdoors);
  assertSafe(end, outdoors, 'Large movement result');
  near(end[axis], expected, 'Cannot tunnel through building/perimeter', 4e-5);
  assert.equal(end.blocked, true, 'Collision is reported');
}

// Every generated trunk and lamp contributes its real transformed footprint.
// Verify those boxes independently, then drive straight into a clear trunk.
for (const name of ['Tree trunks', 'Garden lamp posts']) {
  const mesh = environment.group.getObjectByName(name), instance = new THREE.Matrix4();
  mesh.geometry.computeBoundingBox();
  for (let index = 0; index < mesh.count; index++) {
    mesh.getMatrixAt(index, instance);
    const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld.clone().multiply(instance));
    assert.ok(outdoors.obstacles.some(obstacle =>
      ['X', 'Z'].every(axis => Math.abs(obstacle[`min${axis}`] - box.min[axis.toLowerCase()]) < 1e-7 && Math.abs(obstacle[`max${axis}`] - box.max[axis.toLowerCase()]) < 1e-7)), `${name} instance ${index} blocks walking`);
  }
}
const trunkMesh = environment.group.getObjectByName('Tree trunks'), trunkMatrix = new THREE.Matrix4();
trunkMesh.getMatrixAt(0, trunkMatrix);
const trunkBox = trunkMesh.geometry.boundingBox.clone().applyMatrix4(trunkMesh.matrixWorld.clone().multiply(trunkMatrix));
const trunkStart = { x: trunkBox.max.x + PLAYER_RADIUS + .5, z: (trunkBox.min.z + trunkBox.max.z) / 2 };
assertSafe(trunkStart, outdoors, 'Trunk approach');
const trunkStop = moveWithCollisions(trunkStart, -3, 0, outdoors);
assertSafe(trunkStop, outdoors, 'Trunk collision');
near(trunkStop.x, trunkBox.max.x + PLAYER_RADIUS, 'Large movement cannot tunnel through a tree trunk', 4e-5);

// Complete a lap around the building using normal-size walking increments.
let lapPosition = { ...outdoors.spawn }, lapSteps = 0;
for (const waypoint of [{ x: 1.22, z: 4.5 }, { x: 3.7, z: 4.5 }, { x: 3.7, z: -5.8 }, { x: -5.8, z: -5.8 }, { x: -5.8, z: 4.5 }, { x: 1.22, z: 4.5 }, outdoors.spawn]) {
  for (let step = 0; step < 1000 && Math.hypot(waypoint.x - lapPosition.x, waypoint.z - lapPosition.z) > 1e-7; step++) {
    const dx = waypoint.x - lapPosition.x, dz = waypoint.z - lapPosition.z, scale = Math.min(1, .04 / Math.hypot(dx, dz));
    lapPosition = moveWithCollisions(lapPosition, dx * scale, dz * scale, outdoors);
    assertSafe(lapPosition, outdoors, 'Full garden lap');
    assert.equal(lapPosition.blocked, false, 'The intended garden route stays open');
    lapSteps++;
  }
  near(lapPosition.x, waypoint.x, 'Garden route waypoint X');
  near(lapPosition.z, waypoint.z, 'Garden route waypoint Z');
}

let seed = 0xC0FFEE16, randomPosition = { ...outdoors.spawn };
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
const randomSteps = 12000;
for (let index = 0; index < randomSteps; index++) {
  const length = index % 101 ? .01 + random() * .1 : .6 + random() * 3, angle = random() * Math.PI * 2;
  const before = { ...randomPosition };
  const result = moveWithCollisions(randomPosition, Math.cos(angle) * length, Math.sin(angle) * length, outdoors);
  assert.deepEqual(randomPosition, before, 'Outdoor movement does not mutate caller position');
  assertSafe(result, outdoors, `Deterministic outdoor step ${index}`);
  randomPosition = result;
}

// Run the real camera controller on the authored entrance steps. Outdoor Y
// changes with support; returning indoors retains its original fixed eye Y.
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
  controller.enter('outside', { ...outdoors, spawn: { ...outdoors.spawn, z: 3.4 } });
  controller.setMove('forward', true);
  let easingGap = 0;
  for (let index = 0; index < 30 && easingGap < .001; index++) {
    controller.update(.05);
    const { x, y, z } = controller.camera.position;
    easingGap = y - (outdoors.heightAt(x, z) + outdoors.eyeHeight);
  }
  assert.ok(easingGap > .001, 'A real entrance-step descent starts smooth camera easing');
  controller.setMove('forward', false);
  const stoppedPosition = controller.camera.position.clone();
  for (let index = 0; index < 60; index++) controller.update(.05);
  near(controller.camera.position.x, stoppedPosition.x, 'Idle settling does not move X');
  near(controller.camera.position.z, stoppedPosition.z, 'Idle settling does not move Z');
  near(controller.camera.position.y, outdoors.heightAt(stoppedPosition.x, stoppedPosition.z) + outdoors.eyeHeight,
    'Releasing movement while descending still settles the camera at its supported height');
  controller.enter('outside', outdoors);
  near(controller.camera.position.y, outdoors.spawn.y, 'Outdoor controller entry stands on porch');
  controller.setMove('forward', true);
  let lowestEye = Infinity;
  for (let index = 0; index < 80; index++) {
    controller.update(.05);
    const { x, y, z } = controller.camera.position;
    assertSafe(controller.camera.position, outdoors, `Outdoor controller descent ${index}`);
    assert.ok(y >= outdoors.heightAt(x, z) + outdoors.eyeHeight - 1e-7, 'Camera never sinks below supported eye height');
    lowestEye = Math.min(lowestEye, y);
  }
  assert.ok(lowestEye < outdoors.spawn.y - .2, 'Outdoor camera actually descends from porch to garden');
  near(controller.camera.position.y, groundY + outdoors.eyeHeight, 'Descent settles at lawn eye height', 1e-5);
  controller.setMove('forward', false);
  controller.look(-Math.PI, 0);
  controller.setMove('forward', true);
  for (let index = 0; index < 80; index++) {
    controller.update(.05);
    const { x, y, z } = controller.camera.position;
    assertSafe(controller.camera.position, outdoors, `Outdoor controller ascent ${index}`);
    const supportedEye = outdoors.heightAt(x, z) + outdoors.eyeHeight;
    assert.ok(y >= supportedEye - 1e-7, 'Ascending camera immediately clears the actual step');
    near(y, supportedEye, 'Camera follows the slightly sloped porch without hovering', .001);
  }
  assert.equal(isWithinDoorTrigger(controller.camera.position, outdoors.door), false, 'The real controller does not offer entry at the old front opening');
  controller.setMove('forward', false);
  // Finish the return with the real controller around the right-hand corner,
  // preserving the existing descent/ascent and fixed indoor-eye checks above.
  for (const waypoint of [
    { x: 3, z: controller.camera.position.z }, { x: 3, z: .90 }, { x: actualDoorGap.x, z: .90 }, actualDoorGap,
  ]) {
    controller.setMove('forward', true);
    for (let step = 0; step < 300 && Math.hypot(waypoint.x - controller.camera.position.x, waypoint.z - controller.camera.position.z) > 1e-7; step++) {
      const dx = waypoint.x - controller.camera.position.x, dz = waypoint.z - controller.camera.position.z;
      const distance = Math.hypot(dx, dz), yaw = Math.atan2(-dx, -dz);
      controller.look(yaw - controller.camera.rotation.y, 0);
      controller.update(Math.min(.05, distance / outdoors.walkSpeed));
      assertSafe(controller.camera.position, outdoors, 'Controller returns through the actual right-hand doorway approach');
    }
    controller.setMove('forward', false);
    near(controller.camera.position.x, waypoint.x, 'Controller doorway waypoint X');
    near(controller.camera.position.z, waypoint.z, 'Controller doorway waypoint Z');
  }
  assert.ok(isWithinDoorTrigger(controller.camera.position, outdoors.door), 'Walking around the right corner reaches the café entry trigger');
  controller.setFloor(1, doorIndoorSpawn);
  controller.setMove('forward', true);
  for (let index = 0; index < 100; index++) {
    controller.update(.05);
    near(controller.camera.position.y, rooms[1].spawn.y, 'Returning café camera has fixed standing height');
    assertSafe(controller.camera.position, rooms[1], 'Returned indoor controller');
  }
  controller.setFloor(2, rooms[2]);
  controller.setMove('right', true);
  for (let index = 0; index < 100; index++) {
    controller.update(.05);
    near(controller.camera.position.y, rooms[2].spawn.y, '2F camera remains at the original eye height');
  }
} finally {
  controller?.dispose();
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

console.log(`Outdoor navigation passed: real GLB porch/step support, reachable two-way door, building/tree/lamp/perimeter collisions, ${lapSteps} lap steps, ${randomSteps.toLocaleString('en-US')} deterministic steps, outdoor height following and unchanged indoor eye heights.`);
