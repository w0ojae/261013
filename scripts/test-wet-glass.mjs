import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
import {createGlassPanes} from '../dist/glass-panes.js';
import {createWindowRain} from '../dist/window-rain.js';
import {modelPosition, modelScale} from '../dist/building-placement.js';

// Exercise the shipped CPU water simulation and Three adapter without a GPU.
// Canvas drawing is inert; allocations, revisions, UVs and texture lifetimes
// remain real. Browser/WebGL image quality is checked separately in the page.
const previousDocument = globalThis.document, previousImage = globalThis.Image;
const context = () => ({
  createImageData: (w, h) => ({data: new Uint8ClampedArray(w * h * 4)}),
  getImageData: (x, y, w, h) => ({data: new Uint8ClampedArray(w * h * 4)}),
  save() {}, restore() {}, clearRect() {}, fillRect() {}, putImageData() {}, drawImage() {},
  setTransform() {}, translate() {}, rotate() {}, beginPath() {}, moveTo() {},
  quadraticCurveTo() {}, lineTo() {}, ellipse() {}, arc() {}, fill() {}, stroke() {},
});
before(() => {
  globalThis.document = {createElement: () => {
    const ctx = context();
    return {width: 1, height: 1, getContext: () => ctx};
  }};
  globalThis.Image = class {set src(value) {queueMicrotask(() => this.onload());}};
});
after(() => {
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  if (previousImage === undefined) delete globalThis.Image; else globalThis.Image = previousImage;
});

function mockRenderer() {
  const size = new THREE.Vector2(960, 640);
  const viewport = new THREE.Vector4(12, 17, 511, 333);
  const scissor = new THREE.Vector4(21, 34, 377, 222);
  let target = new THREE.WebGLRenderTarget(1024, 768), scissorTest = true;
  return {
    size, calls: [], failCapture: false,
    extensions: {has: () => false}, domElement: {dataset: {}},
    shadowMap: {autoUpdate: true, needsUpdate: true},
    getDrawingBufferSize: value => value.copy(size),
    getRenderTarget: () => target,
    setRenderTarget(value) {
      target = value;
      // Deliberately change raster state like an offscreen target switch does.
      // The adapter must restore the caller's custom viewport and scissor.
      if (value) {viewport.copy(value.viewport); scissor.copy(value.scissor); scissorTest = value.scissorTest;}
    },
    getViewport: value => value.copy(viewport), setViewport: value => viewport.copy(value),
    getScissor: value => value.copy(scissor), setScissor: value => scissor.copy(value),
    getScissorTest: () => scissorTest, setScissorTest: value => {scissorTest = value;},
    render(scene, camera) {
      this.calls.push({scene, camera, target, visible: scene.children.filter(child => child.isGroup)
        .flatMap(group => group.children.filter(child => child.isMesh).map(child => child.visible))});
      if (this.failCapture && scene === this.mainScene && target !== this.callerTarget) {
        throw new Error('Synthetic capture failure');
      }
    },
  };
}

function fixture(options) {
  const renderer = mockRenderer(), scene = new THREE.Scene(), model = new THREE.Group();
  model.position.copy(modelPosition); model.scale.setScalar(modelScale); scene.add(model);
  const original = new THREE.MeshPhysicalMaterial({transparent: true, opacity: .18, side: THREE.DoubleSide});
  const panes = createGlassPanes(THREE, model, original);
  scene.updateMatrixWorld(true);
  const errors = [];
  const adapter = createWindowRain(THREE, renderer, scene, panes, {...options, onError: error => errors.push(error)});
  renderer.mainScene = scene; renderer.callerTarget = renderer.getRenderTarget();
  const camera = new THREE.PerspectiveCamera(68, 1.5, .025, 150);
  camera.position.set(8, 2.5, 7); camera.lookAt(0, 1.7, .2); camera.updateMatrixWorld();
  return {renderer, scene, model, original, panes, adapter, camera, errors,
    dispose() {
      adapter.dispose(); renderer.callerTarget.dispose(); original.dispose();
      panes.forEach(pane => pane.geometry.dispose());
    }};
}

const textureNames = ['u_waterMap', 'u_clear', 'u_microSeeds', 'u_heartfelt'];
const waterTextures = material => textureNames.map(name => material.uniforms[name].value);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const revisions = renderer => new Map(renderer.domElement.dataset.rainRevision.split(',')
  .filter(Boolean).map(entry => entry.split(':').map(Number)));
async function warm(f, camera = f.camera) {
  f.adapter.render(camera, 1 / 30, {enabled: true, floor: 'outside'});
  await new Promise(resolve => setImmediate(resolve));
  f.adapter.render(camera, 1 / 30, {enabled: true, floor: 'outside'});
  assert.deepEqual(f.errors, []);
}
function normalAndCenter(pane) {
  return {
    center: pane.getWorldPosition(new THREE.Vector3()),
    normal: new THREE.Vector3(0, 0, 1).transformDirection(pane.matrixWorld),
  };
}
function lookAtPane(camera, pane, distance) {
  const {center, normal} = normalAndCenter(pane);
  camera.position.copy(center).addScaledVector(normal, distance);
  camera.lookAt(center); camera.updateMatrixWorld();
}

test('outside sees both floors and one shared capture restores its caller render state', async () => {
  const f = fixture();
  try {
    // A hidden pane must remain hidden throughout capture and final rendering.
    f.panes[2].visible = false;
    const beforeState = {
      target: f.renderer.getRenderTarget(), viewport: f.renderer.getViewport(new THREE.Vector4()),
      scissor: f.renderer.getScissor(new THREE.Vector4()), scissorTest: f.renderer.getScissorTest(),
      shadow: {...f.renderer.shadowMap},
    };
    await warm(f);
    const wet = revisions(f.renderer);
    assert.ok(wet.has(0), 'upper right window is wet from outside');
    assert.ok(wet.has(4), 'lower right window is wet in the same outdoor view');
    assert.ok(!wet.has(2), 'hidden panes are excluded');
    assert.equal(f.panes[2].visible, false);
    assert.equal(f.renderer.getRenderTarget(), beforeState.target);
    assert.deepEqual(f.renderer.getViewport(new THREE.Vector4()), beforeState.viewport);
    assert.deepEqual(f.renderer.getScissor(new THREE.Vector4()), beforeState.scissor);
    assert.equal(f.renderer.getScissorTest(), beforeState.scissorTest);
    assert.deepEqual(f.renderer.shadowMap, beforeState.shadow);
    const captures = f.renderer.calls.filter(call => call.scene === f.scene && call.target !== beforeState.target);
    assert.equal(captures.length, 1, 'all visible panes share a single scene capture');
    assert.ok(captures[0].visible.every(value => !value), 'glass is hidden while capturing its background');
    const upper = f.panes[0].material.uniforms, lower = f.panes[4].material.uniforms;
    assert.equal(upper.u_scene.value, lower.u_scene.value);
    assert.equal(upper.u_depth.value, lower.u_depth.value);
    assert.equal(upper.u_hasDepth.value, 1, 'opaque furniture and frames have an occlusion depth texture');
    assert.equal(f.panes[0].material.side, THREE.DoubleSide);
    assert.equal(f.panes[0].material.depthTest, true);
  } finally {f.dispose();}
});

test('both glass faces, room changes, dry/orbit mode and resizing retain the same water body', async () => {
  const f = fixture();
  try {
    await warm(f);
    const pane = f.panes[4], material = pane.material;
    const textures = waterTextures(material), canvases = textures.map(texture => texture.image);
    const size = material.uniforms.u_cssSize.value.clone();
    const uvs = pane.geometry.attributes.uv.array.slice();
    const initialRevision = revisions(f.renderer).get(4);
    const initialTime = material.uniforms.u_rain.value.x;
    for (const [distance, floor] of [[-.7, 1], [2.1, 'outside'], [-.9, 2], [1.6, 'outside']]) {
      lookAtPane(f.camera, pane, distance);
      f.adapter.render(f.camera, 1 / 30, {enabled: true, floor});
      assert.equal(pane.material, material, `pane has one material from side ${distance}`);
      assert.deepEqual(waterTextures(material), textures);
      assert.deepEqual(textures.map(texture => texture.image), canvases);
      assert.deepEqual(pane.geometry.attributes.uv.array, uvs);
      assert.ok(revisions(f.renderer).has(4), 'selected floor does not hide a visible pane');
    }
    assert.ok(revisions(f.renderer).get(4) > initialRevision, 'the retained water map advances');
    assert.ok(material.uniforms.u_rain.value.x > initialTime, 'the original physics clock advances');
    const pausedTime = material.uniforms.u_rain.value.x;
    const pausedVersions = textures.map(texture => texture.version);
    for (let i = 0; i < 3; i++) f.adapter.render(f.camera, 1, {enabled: false});
    assert.equal(pane.material, f.original, 'ordinary glass returns for dry or orbit views');
    assert.equal(f.adapter.active, false);
    assert.equal(f.renderer.domElement.dataset.rainPanes, '');
    assert.deepEqual(textures.map(texture => texture.version), pausedVersions);
    f.renderer.size.set(2048, 1024);
    f.adapter.render(f.camera, 1 / 30, {enabled: true, floor: 'outside'});
    assert.equal(pane.material, material);
    assert.deepEqual(waterTextures(material), textures);
    assert.deepEqual(textures.map(texture => texture.image), canvases);
    assert.deepEqual(material.uniforms.u_cssSize.value, size, 'physical water scale is independent of viewport size');
    assert.deepEqual(material.uniforms.u_resolution.value, new THREE.Vector2(2048, 1024));
    near(material.uniforms.u_rain.value.x - pausedTime, 1 / 30 * .2);
    assert.deepEqual(pane.geometry.attributes.uv.array, uvs);

    // Actual Three ray intersections address the same point of the same UV map
    // from either side, rather than substituting a mirrored screen overlay.
    const {normal} = normalAndCenter(pane);
    const point = pane.localToWorld(new THREE.Vector3(-pane.geometry.parameters.width * .23,
      pane.geometry.parameters.height * .11, 0));
    for (const direction of [-1, 1]) {
      const origin = point.clone().addScaledVector(normal, direction);
      const hit = new THREE.Raycaster(origin, point.clone().sub(origin).normalize()).intersectObject(pane)[0];
      assert.ok(hit, 'DoubleSide glass intersects from either side');
      near(hit.uv.x, .27); near(hit.uv.y, .61);
    }
    f.adapter.dispose();
    assert.equal(pane.material, f.original);
    assert.ok(canvases.every(canvas => canvas.width === 1 && canvas.height === 1), 'owned CPU maps are released');
  } finally {f.dispose();}
});

test('a failed offscreen capture restores visibility, render target, scissor and shadow settings', async () => {
  const f = fixture();
  try {
    await warm(f);
    f.panes[3].visible = false;
    const visibility = f.panes.map(pane => pane.visible);
    const viewport = f.renderer.getViewport(new THREE.Vector4()), scissor = f.renderer.getScissor(new THREE.Vector4());
    const target = f.renderer.getRenderTarget(), shadow = {...f.renderer.shadowMap};
    const scissorTest = f.renderer.getScissorTest();
    f.renderer.failCapture = true;
    assert.throws(() => f.adapter.render(f.camera, 1 / 30, {enabled: true}), /Synthetic capture failure/);
    assert.deepEqual(f.panes.map(pane => pane.visible), visibility);
    assert.equal(f.renderer.getRenderTarget(), target);
    assert.deepEqual(f.renderer.getViewport(new THREE.Vector4()), viewport);
    assert.deepEqual(f.renderer.getScissor(new THREE.Vector4()), scissor);
    assert.equal(f.renderer.getScissorTest(), scissorTest);
    assert.deepEqual(f.renderer.shadowMap, shadow);
    f.renderer.failCapture = false;
    f.adapter.render(f.camera, 1 / 30, {enabled: true});
    assert.ok(revisions(f.renderer).has(4), 'normal rendering can continue after the caller handles a capture failure');
  } finally {f.dispose();}
});

test('reduced motion retains wet glass while freezing its clock and texture revisions', async () => {
  const f = fixture({reducedMotion: true});
  try {
    await warm(f);
    const pane = f.panes[4], material = pane.material, textures = waterTextures(material);
    const time = material.uniforms.u_rain.value.clone(), revision = revisions(f.renderer).get(4);
    const versions = textures.map(texture => texture.version);
    for (let i = 0; i < 10; i++) f.adapter.render(f.camera, .08, {enabled: true, floor: 'outside'});
    assert.equal(pane.material, material);
    assert.deepEqual(material.uniforms.u_rain.value, time);
    assert.equal(revisions(f.renderer).get(4), revision);
    assert.deepEqual(textures.map(texture => texture.version), versions);
    assert.ok(material.uniforms.u_scene.value && material.uniforms.u_depth.value, 'frozen glass still captures the changing scene');
  } finally {f.dispose();}
});
