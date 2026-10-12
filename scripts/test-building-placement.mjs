import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from '../dist/vendor/three.module.js';
import { modelScale, modelPosition, sourceHeightOffset, buildingYOffset, groundY, rainShelter, modelToWorld } from '../dist/building-placement.js';
import { rooms } from '../dist/rooms-building2.js';
import { createExteriorRain } from '../dist/weather/exterior-rain.js';
import { createGlassPanes } from '../dist/glass-panes.js';

const near = (actual, expected, label, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
const asset = await readFile(new URL('../dist/assets/building2.glb', import.meta.url));
assert.equal(createHash('sha256').update(asset).digest('hex').toUpperCase(),
  'A9B28A9A46FA69E83DB8083B0392752E5AE4DD8BC80C408193448EC1B197FE6C', 'Authored GLB must remain unchanged');

// Read the actual shipped GLB instead of trusting a hand-entered bounding box.
assert.equal(asset.readUInt32LE(0), 0x46546c67, 'GLB magic');
const jsonSize = asset.readUInt32LE(12);
const gltf = JSON.parse(asset.subarray(20, 20 + jsonSize));
const binary = asset.subarray(28 + jsonSize);
const parent = new Map();
gltf.nodes.forEach((node, index) => node.children?.forEach(child => parent.set(child, index)));
const matrices = new Map();
function nodeMatrix(index) {
  if (matrices.has(index)) return matrices.get(index);
  const node = gltf.nodes[index];
  const matrix = node.matrix ? new THREE.Matrix4().fromArray(node.matrix) : new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
    new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
    new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]));
  if (parent.has(index)) matrix.premultiply(nodeMatrix(parent.get(index)));
  matrices.set(index, matrix);
  return matrix;
}
function accessor(index, components) {
  const description = gltf.accessors[index], view = gltf.bufferViews[description.bufferView];
  const [bytes, method] = { 5121: [1, 'readUInt8'], 5123: [2, 'readUInt16LE'], 5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] }[description.componentType];
  const start = (view.byteOffset ?? 0) + (description.byteOffset ?? 0), stride = view.byteStride ?? bytes * components;
  return { count: description.count, read: element => Array.from({ length: components }, (_, component) =>
    binary[method](start + element * stride + component * bytes)) };
}
const oldParentY = -.8239 * .78;
const oldPlacement = new THREE.Matrix4().compose(new THREE.Vector3(-.078, oldParentY, 2.34),
  new THREE.Quaternion(), new THREE.Vector3(.78, .78, .78))
  .multiply(new THREE.Matrix4().makeTranslation(0, -sourceHeightOffset, 0));
const newPlacement = new THREE.Matrix4().compose(new THREE.Vector3(modelPosition.x, modelPosition.y, modelPosition.z),
  new THREE.Quaternion(), new THREE.Vector3(modelScale, modelScale, modelScale))
  .multiply(new THREE.Matrix4().makeTranslation(0, -sourceHeightOffset, 0));
const triangles = [], foundation = [];
for (let index = 0; index < gltf.nodes.length; index++) {
  const node = gltf.nodes[index];
  if (node.mesh === undefined) continue;
  for (const primitive of gltf.meshes[node.mesh].primitives) {
    assert.ok(primitive.mode === undefined || primitive.mode === 4, 'Triangle model primitives');
    const positions = accessor(primitive.attributes.POSITION, 3);
    const indices = primitive.indices === undefined ? null : accessor(primitive.indices, 1);
    const beforeMatrix = oldPlacement.clone().multiply(nodeMatrix(index));
    const afterMatrix = newPlacement.clone().multiply(nodeMatrix(index));
    const before = [], after = [];
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const point = new THREE.Vector3().fromArray(positions.read(vertex));
      before.push(point.clone().applyMatrix4(beforeMatrix));
      after.push(point.applyMatrix4(afterMatrix));
    }
    const count = indices?.count ?? positions.count;
    for (let offset = 0; offset < count; offset += 3) {
      const ids = [0, 1, 2].map(component => indices ? indices.read(offset + component)[0] : offset + component);
      const triangle = { before: ids.map(id => before[id]), after: ids.map(id => after[id]) };
      triangles.push(triangle);
      if (node.name === 'Cube.107' && gltf.materials[primitive.material].name === 'Material.019') foundation.push(triangle);
    }
  }
}
assert.ok(foundation.length > 100, 'Actual foundation geometry found');

// Its main underside is flat, but the exposed rear-left lower edge rises.
// Mixed authored winding means the lower envelope, rather than the normal sign,
// identifies those rear faces. The other horizontal layers are above Y .17.
const underside = foundation.filter(({ before }) => {
  const cross = before[1].clone().sub(before[0]).cross(before[2].clone().sub(before[0]));
  return cross.length() > 1e-8 && Math.abs(cross.normalize().y) > .95 && Math.max(...before.map(vertex => vertex.y)) < .154;
});
assert.ok(underside.length >= 30, 'Both flat and sloped underside faces are covered');
const previousHighestUnderside = Math.max(...underside.flatMap(triangle => triangle.before.map(vertex => vertex.y)));
near(previousHighestUnderside, .15323206922131688, 'Measured highest exposed underside');
// The requested correction keeps only 2/5 of the previous full-grounding drop.
// Verify the offset against actual geometry rather than the placement module.
const intendedYOffset = (groundY - .005 - previousHighestUnderside) * (2 / 5);
near(buildingYOffset, intendedYOffset, 'Only 2/5 of the previous lowering is retained');
for (const triangle of foundation) {
  triangle.before.forEach((before, index) => {
    const after = triangle.after[index];
    near(after.x, before.x, 'Foundation fixed X');
    near(after.z, before.z, 'Foundation fixed Z');
    near(after.y - before.y, intendedYOffset, 'Every foundation vertex follows the intended lowering');
  });
}
const currentHighestUnderside = Math.max(...underside.flatMap(triangle => triangle.after.map(vertex => vertex.y)));
near(currentHighestUnderside, previousHighestUnderside + intendedYOffset, 'Rear perimeter follows the requested higher placement');
const mainTop = foundation.filter(({ before }) => before.every(vertex => Math.abs(vertex.y - .30490520478818495) < 1e-10));
assert.ok(mainTop.length >= 15, 'Broad main slab top found');
assert.ok(mainTop.every(triangle => triangle.after.every(vertex => vertex.y > groundY + .27)), 'Main slab remains visible above ground');
const lowStep = foundation.filter(({ before }) => before.every(vertex => Math.abs(vertex.y - .17198029993177427) < 1e-10));
assert.ok(lowStep.length >= 20 && lowStep.every(triangle => triangle.after.every(vertex => vertex.y > groundY + .14)), 'Entrance step remains above ground');

// Independent vertical intersection with every authored model triangle checks
// that lowering a room camera preserves its clearance from actual geometry.
function surfaceBelow(point, key) {
  let highest = -Infinity;
  for (const triangle of triangles) {
    const [a, b, c] = triangle[key];
    const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(denominator) < 1e-12) continue;
    const first = ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) / denominator;
    const second = ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) / denominator;
    const third = 1 - first - second;
    if (Math.min(first, second, third) < -1e-9) continue;
    const y = first * a.y + second * b.y + third * c.y;
    if (y < point.y - 1e-6) highest = Math.max(highest, y);
  }
  assert.ok(Number.isFinite(highest), 'Authored model surface below room spawn');
  return highest;
}
const localRooms = {
  1: { spawn: [1.65, 2.79, -2.8], bounds: [.82, 2.21, -5.53, -.92], obstacles: [[.81, 1.21, -2.20, -1.78], [.66, 1.06, -3.82, -3.39], [.66, 1.06, -3.01, -2.59]] },
  2: { spawn: [.9, 5.17, -2.6], bounds: [-1.68, 1.48, -3.68, -1.92], obstacles: [] },
};
const oldWorld = ([x, y, z]) => ({ x: (x - .1) * .78, y: (y - .8239) * .78, z: (z + 3) * .78 });
const oldRect = ([minX, maxX, minZ, maxZ]) => ({ minX: (minX - .1) * .78, maxX: (maxX - .1) * .78, minZ: (minZ + 3) * .78, maxZ: (maxZ + 3) * .78 });
const clearances = [];
for (const [floor, fixture] of Object.entries(localRooms)) {
  const room = rooms[floor], oldSpawn = oldWorld(fixture.spawn), world = modelToWorld(...fixture.spawn);
  for (const coordinate of ['x', 'y', 'z']) near(room.spawn[coordinate], world[coordinate], `${floor}F room follows model ${coordinate}`);
  near(room.spawn.y - oldSpawn.y, buildingYOffset, `${floor}F camera translation`);
  for (const [key, value] of Object.entries(oldRect(fixture.bounds))) near(room.bounds[key], value, `${floor}F collision bound ${key}`);
  assert.equal(room.obstacles.length, fixture.obstacles.length, `${floor}F obstacle count`);
  fixture.obstacles.forEach((rectangle, index) => {
    for (const [key, value] of Object.entries(oldRect(rectangle))) near(room.obstacles[index][key], value, `${floor}F obstacle ${index} ${key}`);
  });
  const oldGap = oldSpawn.y - surfaceBelow(oldSpawn, 'before');
  const newGap = room.spawn.y - surfaceBelow(room.spawn, 'after');
  near(newGap, oldGap, `${floor}F eye clearance from actual GLB`, 1e-10);
  assert.ok(newGap > .25, `${floor}F camera stays clear of model surface`);
  clearances.push(`${floor}F=${newGap.toFixed(6)}`);
}

// Glass and added indoor light fixtures are children of the same Three group.
// Exercise every shipped pane, bulb and light with real world matrices.
const model = new THREE.Group();
model.scale.setScalar(modelScale);
model.position.set(modelPosition.x, oldParentY, modelPosition.z);
createGlassPanes(THREE,model,new THREE.MeshPhysicalMaterial());
const fixturePositions = [[1.25, 3.36, -2.25], [.2, 6.35, -2.8]].flatMap(([x, y, z]) => [[x, y, z], [x, y - .13, z]]);
for (const coordinates of fixturePositions) {
  const child = new THREE.Object3D();
  child.position.fromArray(coordinates);model.add(child);
}
model.updateMatrixWorld(true);
const oldChildren = model.children.map(child => child.getWorldPosition(new THREE.Vector3()));
const oldChildMatrices = model.children.map(child => child.matrixWorld.clone());
model.position.y = modelPosition.y;model.updateMatrixWorld(true);
model.children.forEach((child, index) => {
  const point = child.getWorldPosition(new THREE.Vector3());
  near(point.x, oldChildren[index].x, `Child ${index} fixed X`);
  near(point.z, oldChildren[index].z, `Child ${index} fixed Z`);
  near(point.y - oldChildren[index].y, buildingYOffset, `Child ${index} shares building translation`);
  child.matrixWorld.elements.forEach((element, component) => near(element - oldChildMatrices[index].elements[component],
    component === 13 ? buildingYOffset : 0, `Child ${index} complete transform component ${component}`));
});
const mainSource = await readFile(new URL('../dist/main-garden.js', import.meta.url), 'utf8');
assert.match(mainSource, /model\.scale\.setScalar\(modelScale\);\s*model\.position\.(?:copy\(modelPosition\)|set\(modelPosition\.x,modelPosition\.y,modelPosition\.z\))/u, 'Runtime uses the shared placement');
assert.match(mainSource, /groundY,shelter:rainShelter,buildingYOffset/u, 'Runtime passes translated rain settings');

const rain = createExteriorRain(THREE, new THREE.Scene(), { groundY, shelter: rainShelter, buildingYOffset });
try {
  const uniforms = rain.mesh.material.uniforms;
  near(uniforms.uRoof.value, 4.45 + buildingYOffset, 'Actual GPU roof clipping uniform follows building');
  near(uniforms.uGround.value, -.055, 'Rain still lands at the lawn height');
  near(uniforms.uBuildingYOffset.value, buildingYOffset, 'GPU light profile follows building');
  assert.deepEqual(uniforms.uShelter.value.toArray(), [-2.85, 2.91, -2.47, 2.47], 'Rain shelter footprint is unchanged');
} finally { rain.dispose(); }

console.log(`Building placement passed: GLB hash, 2/5 lowering (${buildingYOffset.toFixed(6)}), ${underside.length} underside faces, visible slab/step, ${clearances.join(', ')}, unchanged XZ collisions, 5 panes/4 fixtures, GPU rain alignment.`);
