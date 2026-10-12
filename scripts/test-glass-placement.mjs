import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../dist/vendor/three.module.js';
import { createGlassPanes } from '../dist/glass-panes.js';
import { modelScale, modelPosition, sourceHeightOffset } from '../dist/building-placement.js';

// Use the shipped loader and GLB as the independent geometry oracle. The import
// rewrite matches the browser import map, including loader name sanitization.
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
model.position.copy(modelPosition);
model.scale.setScalar(modelScale);
model.add(gltf.scene);
const panes = createGlassPanes(THREE, model, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
model.updateMatrixWorld(true);

// These are authored object identities, not the new pane dimensions. Both frame
// meshes contain disconnected pieces, so their overall boxes are not openings.
const frames = [];
gltf.scene.traverse(mesh => {
  if (!mesh.isMesh) return;
  let authored = mesh;
  while (authored && !authored.userData.name) authored = authored.parent;
  if (!((authored?.userData.name === 'Cube.195' && mesh.material.name === 'Material.026') ||
    (authored?.userData.name === 'Plane.091' && mesh.material.name === 'Material.028'))) return;
  mesh.material = mesh.material.clone();
  mesh.material.side = THREE.DoubleSide;
  frames.push(mesh);
});
assert.equal(panes.length, 5, 'All five exposed windows have one shared two-sided pane');
assert.equal(frames.length, 2, 'Actual second-floor and café wooden frames were loaded');

const triangles = [];
for (const frame of frames) {
  const positions = frame.geometry.getAttribute('position'), indices = frame.geometry.index;
  const count = indices ? indices.count : positions.count;
  for (let index = 0; index < count; index += 3) {
    const vertices = [0, 1, 2].map(offset => new THREE.Vector3()
      .fromBufferAttribute(positions, indices ? indices.getX(index + offset) : index + offset)
      .applyMatrix4(frame.matrixWorld));
    const edgeA = vertices[1].clone().sub(vertices[0]);
    const edgeB = vertices[2].clone().sub(vertices[0]);
    triangles.push({ center: vertices[0].clone().add(vertices[1]).add(vertices[2]).multiplyScalar(1 / 3),
      normal: edgeA.cross(edgeB).normalize() });
  }
}

const ray = new THREE.Raycaster();
const reach = .32 * modelScale, epsilon = 1e-5 * modelScale;
function hitsAt(point, outward) {
  ray.set(point.clone().addScaledVector(outward, reach), outward.clone().negate());
  ray.near = 0;
  ray.far = reach * 2;
  return ray.intersectObjects(frames, false);
}
const exteriorHitsAt = (point, outward) => hitsAt(point, outward)
  .filter(hit => hit.point.clone().sub(point).dot(outward) > epsilon);

let perimeterChecks = 0;
const evidence = [];
for (const pane of panes) {
  const name = pane.name.replace('Outer glass — ', '');
  const center = pane.getWorldPosition(new THREE.Vector3());
  const outward = new THREE.Vector3(0, 0, 1).transformDirection(pane.matrixWorld);
  const right = new THREE.Vector3(1, 0, 0).transformDirection(pane.matrixWorld);
  const up = new THREE.Vector3(0, 1, 0).transformDirection(pane.matrixWorld);
  const width = pane.geometry.parameters.width * modelScale;
  const height = pane.geometry.parameters.height * modelScale;
  const expectedOutward = name.includes('right') ? new THREE.Vector3(1, 0, 0) :
    new THREE.Vector3(0, 0, name.includes('rear') ? -1 : 1);
  assert.ok(outward.dot(expectedOutward) > .999999, `${name}: normal points outside its façade`);
  assert.equal(pane.material.side, THREE.DoubleSide, `${name}: same pane is visible from both sides`);
  assert.equal(pane.userData.rainSurface, 'exterior', `${name}: designated exterior wet surface`);

  // Four corners must be in the exterior clear perimeter. Interior sills can
  // sit behind the glass; they naturally occlude it when viewed from indoors.
  // Continue outwards from each corner and require exterior wood on both axes:
  // floating beside an opening cannot pass merely by missing the frame.
  for (const horizontal of [-1, 1]) for (const vertical of [-1, 1]) {
    const corner = center.clone().addScaledVector(right, horizontal * width / 2)
      .addScaledVector(up, vertical * height / 2);
    assert.equal(exteriorHitsAt(corner, outward).length, 0, `${name}: corner is inside exterior clear perimeter`);
    for (const direction of [right.clone().multiplyScalar(horizontal), up.clone().multiplyScalar(vertical)]) {
      let foundWood = false;
      for (let step = 1; step <= 25; step++) {
        if (exteriorHitsAt(corner.clone().addScaledVector(direction, step * .01 * modelScale), outward).length) {
          foundWood = true;
          break;
        }
      }
      assert.ok(foundWood, `${name}: corner is enclosed by its actual window perimeter`);
      perimeterChecks++;
    }
  }

  // Sample authored face centroids to find a representative mullion. Prefer
  // internal bars; the small undivided rear window falls back to its perimeter.
  // Opposing ray hits measure the wooden cavity independently of pane config.
  const candidates = triangles.filter(triangle => Math.abs(triangle.normal.dot(outward)) > .9999)
    .map(triangle => ({ triangle, offset: pane.worldToLocal(triangle.center.clone()) }))
    .filter(({ offset }) => Math.abs(offset.z) < .32 &&
      Math.abs(offset.x) < pane.geometry.parameters.width / 2 + .1 &&
      Math.abs(offset.y) < pane.geometry.parameters.height / 2 + .1);
  const inside = candidates.filter(({ offset }) =>
    Math.abs(offset.x) < pane.geometry.parameters.width / 2 - .01 &&
    Math.abs(offset.y) < pane.geometry.parameters.height / 2 - .01);
  const cavitySamples = [];
  for (const { triangle } of (inside.length ? inside : candidates)) {
    const point = triangle.center.clone();
    point.addScaledVector(outward, center.clone().sub(point).dot(outward));
    const faces = [];
    for (const hit of hitsAt(point, outward)) {
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (Math.abs(normal.dot(outward)) < .9999) continue;
      const distance = hit.point.clone().sub(center).dot(outward);
      if (!faces.some(face => Math.abs(face - distance) < epsilon)) faces.push(distance);
    }
    if (faces.length < 2) continue;
    const outer = faces[0], inner = faces[1];
    if (outer - inner > .005 * modelScale && outer - inner < .26 * modelScale) {
      cavitySamples.push({ outer, inner, point, thickness: outer - inner });
    }
  }
  assert.ok(cavitySamples.length, `${name}: actual opposing wooden faces surround the glass plane`);
  cavitySamples.sort((a, b) => a.thickness - b.thickness);
  const cavity = cavitySamples[0];
  assert.ok(cavity.outer > epsilon, `${name}: exterior wooden face is in front of wet glass`);
  assert.ok(cavity.inner < -epsilon, `${name}: wet glass is outward of interior wooden face`);
  // An internal mullion overlaps the actual pane. From both camera sides its
  // wood must be hit before the wet glass, including the plane's back face.
  if (inside.length) for (const side of [-1, 1]) {
    ray.set(cavity.point.clone().addScaledVector(outward, side * reach),
      outward.clone().multiplyScalar(-side));
    ray.near = 0;
    ray.far = reach * 2;
    const depthOrder = ray.intersectObjects([...frames, pane], false);
    const glassHit = depthOrder.findIndex(hit => hit.object === pane);
    assert.ok(glassHit > 0, `${name}: wood occludes shared glass from ${side > 0 ? 'outside' : 'inside'}`);
    assert.ok(frames.includes(depthOrder[0].object), `${name}: first depth-tested surface is the dry wooden frame`);
  }
  evidence.push(`${name}: frame cavity ${(cavity.thickness / modelScale).toFixed(5)} local, ` +
    `wet glass ${(cavity.outer / modelScale).toFixed(5)} behind outer wood`);
}

console.log(`Glass placement: ${panes.length} actual GLB window cavities, 20 clear corners, ${perimeterChecks} perimeter checks passed.`);
console.log(evidence.join('\n'));
