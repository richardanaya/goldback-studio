import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { Note, COLS, ROWS, NOTE_W, NOTE_H, FLOOR_Y } from './cloth.js';

// ---------- Renderer / scene / camera ----------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.2, 6.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2.5;
controls.maxDistance = 14;
controls.target.set(0, -0.35, 0);
// Left button is reserved for grabbing notes; orbit with right / two-finger.
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };

// A soft fill so the dark side of the foil never goes black.
const fill = new THREE.DirectionalLight(0xfff2d6, 1.1);
fill.position.set(3, 6, 4);
fill.castShadow = true;
fill.shadow.mapSize.set(1024, 1024);
fill.shadow.camera.near = 1;
fill.shadow.camera.far = 30;
fill.shadow.camera.left = -6; fill.shadow.camera.right = 6;
fill.shadow.camera.top = 6; fill.shadow.camera.bottom = -6;
fill.shadow.bias = -0.0008;
scene.add(fill);
scene.add(new THREE.AmbientLight(0x40392a, 0.6));

// A real table surface: dark, faintly polished so it catches the HDRI and a
// soft reflection of the falling note — you can clearly see the note land on it.
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(14, 64),
  new THREE.MeshStandardMaterial({
    color: 0xeae6dc, roughness: 0.55, metalness: 0.0, envMapIntensity: 0.5,
  })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y - 0.01;
floor.receiveShadow = true;
scene.add(floor);

// ---------- Assets ----------
const texLoader = new THREE.TextureLoader();
function loadTex(url, srgb) {
  return new Promise((res) => texLoader.load(url, (t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    res(t);
  }));
}
const loadColor = (u) => loadTex(u, true);
const loadData = (u) => loadTex(u, false);

let frontTex, backTex, frontMat, backMat;
const notes = [];

// Shared geometry template: UVs + triangle indices (positions filled per note).
function buildTemplate() {
  const geo = new THREE.BufferGeometry();
  const uv = new Float32Array(COLS * ROWS * 2);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = (r * COLS + c) * 2;
      uv[i] = c / (COLS - 1);
      uv[i + 1] = 1 - r / (ROWS - 1);
    }
  }
  const idx = [];
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c, b = a + 1, d = a + COLS, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return { uv, idx };
}
let TEMPLATE;

function makeNoteObject(note) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(note.pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(TEMPLATE.uv, 2));
  geo.setIndex(TEMPLATE.idx);
  geo.computeVertexNormals();

  // Front face and back face share positions but use different art + winding.
  const front = new THREE.Mesh(geo, frontMat);
  front.castShadow = true; front.receiveShadow = true;
  const back = new THREE.Mesh(geo, backMat);
  back.castShadow = false; back.receiveShadow = true;

  const group = new THREE.Group();
  group.add(front, back);
  group.userData.note = note;
  note.geo = geo;
  note.mesh = front; // raycast target
  scene.add(group);
  return group;
}

// ---------- Poses ----------
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
// A small, UNIFORM back-lean shared by every note: enough that a dropped note
// topples instead of balancing on its bottom edge, but identical for all notes
// so they stay parallel and never cut into each other when arranged.
const REST_TILT = 0.09;

function poseSpread() {
  const k = notes.length;
  notes.forEach((n, i) => {
    const t = k === 1 ? 0 : (i / (k - 1) - 0.5);
    _e.set(REST_TILT, t * 0.25, 0);
    n.setPose(new THREE.Vector3(t * (k > 1 ? 3.2 : 0), 0.25, 0), _q.setFromEuler(_e), 1);
  });
}

function poseStack() {
  // A clean, aligned pile: every note shares one orientation and only differs
  // in height, so they sit flush instead of intersecting.
  _e.set(-Math.PI / 2, 0, 0.04);
  _q.setFromEuler(_e);
  notes.forEach((n, i) => {
    n.setPose(new THREE.Vector3(0, FLOOR_Y + 0.02 + i * 0.013, 0), _q.clone(), 1);
  });
}

function poseFan() {
  const k = notes.length;
  const hingeY = -NOTE_H * 0.5;                 // shared hinge near the bottom
  const arc = Math.min(1.55, 0.17 * k);         // total in-plane splay
  const curve = Math.min(0.85, 0.11 * k);       // gentle bow about the vertical axis
  notes.forEach((n, i) => {
    const t = k === 1 ? 0 : i / (k - 1) - 0.5;  // -0.5 .. 0.5
    // splay (z) fans the cards out; bow (y) wraps the fan into a slight curve
    _e.set(0, t * curve, -t * arc);
    _q.setFromEuler(_e);
    const offset = new THREE.Vector3(0, NOTE_H * 0.5, 0).applyQuaternion(_q);
    // layer each card in depth so neighbours never share a plane / z-fight
    offset.z += (i - (k - 1) / 2) * 0.03;
    n.setPose(new THREE.Vector3(0, hingeY, 0).add(offset), _q.clone(), 1);
  });
}

function poseFlip() {
  notes.forEach((n) => {
    _e.setFromQuaternion(n.anchorQuat);
    _q.setFromEuler(new THREE.Euler(0, Math.PI, 0));
    n.setPose(n.anchorPos, n.anchorQuat.clone().multiply(_q), Math.max(n.holdTarget, 0.6));
  });
}

function drop() { notes.forEach((n) => { n.holdTarget = 0; }); }

function ruffle() {
  windBurst = 7;
  notes.forEach((n) => n.ruffle());
}

// ---------- Note count ----------
const MAX_NOTES = 28;
function addNote(silent) {
  if (notes.length >= MAX_NOTES) return;
  const n = new Note();
  notes.push(n);
  makeNoteObject(n);
  if (!silent) { poseSpread(); flashCount(); }
}
function removeNote() {
  if (notes.length <= 1) return;
  const n = notes.pop();
  n.mesh.parent.removeFromParent();
  n.geo.dispose();
  poseSpread();
  flashCount();
}
function reset() {
  while (notes.length > 1) removeNote();
  poseSpread();
  notes[0].resetToAnchor();
  flashCount();
}

const countEl = document.getElementById('noteCount');
function flashCount() { countEl.textContent = notes.length; }

// ---------- Interaction (grab a note) ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dragPlane = new THREE.Plane();
const dragHit = new THREE.Vector3();
let active = null; // { note, index }

function setPointer(e) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // left only; right handled by orbit
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const meshes = notes.map((n) => n.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return;
  const hit = hits[0];
  const note = hit.object.userData?.note ?? notes.find((n) => n.mesh === hit.object);
  // pick nearest of the face's three vertices
  const f = hit.face;
  const p = hit.point;
  let best = f.a, bestD = Infinity;
  for (const vi of [f.a, f.b, f.c]) {
    const dx = note.pos[vi * 3] - p.x, dy = note.pos[vi * 3 + 1] - p.y, dz = note.pos[vi * 3 + 2] - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = vi; }
  }
  active = { note, index: best };
  note.grabbed = best;
  note.holdTarget = 0;       // grabbing makes it go floppy
  note.grabPoint.copy(p);
  dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), p);
  renderer.domElement.setPointerCapture(e.pointerId);
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!active) return;
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, dragHit)) {
    active.note.grabPoint.copy(dragHit);
  }
});

function endDrag(e) {
  if (!active) return;
  active.note.grabbed = -1;
  active = null;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {}
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

// ---------- UI ----------
document.getElementById('ui').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  ({ add: () => addNote(), remove: removeNote, stack: poseStack, fan: poseFan,
     spread: poseSpread, ruffle, flip: poseFlip, drop, reset })[act]?.();
});

const windSlider = document.getElementById('wind');
const shineSlider = document.getElementById('shine');
shineSlider.addEventListener('input', () => {
  const v = +shineSlider.value / 100;
  if (frontMat) { frontMat.roughness = 0.6 - v * 0.5; backMat.roughness = 0.65 - v * 0.5; }
});

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const map = { a: () => addNote(), s: poseStack, f: poseFan, r: ruffle, d: drop, x: removeNote };
  if (e.key === ' ') { e.preventDefault(); drop(); return; }
  map[e.key.toLowerCase()]?.();
});

// ---------- Loop ----------
let windBurst = 0;
const wind = { x: 0, z: 0, t: 0 };
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  let dt = clock.getDelta();
  dt = Math.min(dt, 1 / 30);
  const time = clock.elapsedTime;

  const slider = +windSlider.value / 100;
  windBurst *= 0.94;
  wind.x = Math.sin(time * 0.6) * slider * 3.2;
  wind.z = Math.cos(time * 0.4) * slider * 1.6;
  wind.t = slider * 2.2 + windBurst;

  for (const n of notes) {
    n.step(dt, wind, time);
    n.geo.attributes.position.needsUpdate = true;
    n.geo.computeVertexNormals();
    n.geo.computeBoundingSphere();
  }

  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Boot ----------
async function boot() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const [hdr, fTex, bTex, fMetal, bMetal, bNormal] = await Promise.all([
    new Promise((res) => new HDRLoader().load('./assets/env.hdr', res)),
    loadColor('./assets/gb_front.png'),
    loadColor('./assets/gb_back.png'),
    loadData('./assets/gb_front_metal.jpg'),
    loadData('./assets/gb_back_metal.jpg'),
    loadData('./assets/gb_back_normal.jpg'),
  ]);

  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const envRT = pmrem.fromEquirectangular(hdr);
  scene.environment = envRT.texture;
  scene.background = hdr;
  scene.backgroundBlurriness = 0.25;
  hdr.colorSpace = THREE.LinearSRGBColorSpace;

  frontTex = fTex; backTex = bTex;

  // Gold-foil PBR: printed art is the albedo, the embossed grayscale map drives
  // metalness + roughness + bump so the foil stamping actually catches light.
  const baseRough = 0.6 - (+shineSlider.value / 100) * 0.5;
  const common = {
    metalness: 1.0,
    roughness: baseRough,
    envMapIntensity: 1.35,
  };
  // Front and back share geometry; each renders only its facing side so the two
  // printed faces never z-fight.  metalnessMap (blue chan) isolates the foil from
  // the paper.  Front uses its metal map as a bump; back has a real normal map.
  // roughnessMap is intentionally left off so the Shine slider stays in control.
  frontMat = new THREE.MeshStandardMaterial({
    map: frontTex, metalnessMap: fMetal, bumpMap: fMetal, bumpScale: 0.012,
    side: THREE.FrontSide, ...common,
  });
  backMat = new THREE.MeshStandardMaterial({
    map: backTex, metalnessMap: bMetal, normalMap: bNormal,
    normalScale: new THREE.Vector2(0.8, 0.8),
    side: THREE.BackSide, ...common, roughness: baseRough + 0.05,
  });
  // subtle warm sheen in the metallic tint
  frontMat.color.setHex(0xfff4d8);
  backMat.color.setHex(0xf6e3b0);
  frontMat.userData.metalTex = fMetal; backMat.userData.metalTex = bMetal;

  TEMPLATE = buildTemplate();
  addNote(true);
  poseSpread();
  notes[0].resetToAnchor();

  const loader = document.getElementById('loader');
  loader.style.opacity = '0';
  setTimeout(() => loader.remove(), 650);

  // Debug / console handle, plus a ?demo=fan|stack|spread hook for quick checks.
  window.gb = { notes, addNote, poseFan, poseStack, poseSpread, drop, ruffle, scene, camera };
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo) {
    for (let i = 0; i < 7; i++) addNote(true);
    ({ fan: poseFan, stack: poseStack, spread: poseSpread })[demo]?.();
    flashCount();
  }

  animate();
}

boot().catch((err) => {
  console.error('[goldback] boot failed:', err);
  const loader = document.getElementById('loader');
  if (loader) loader.innerHTML =
    `<div style="max-width:520px;text-align:center;color:#ff9a9a;font-size:13px;line-height:1.5">` +
    `<b>Failed to start.</b><br/>${String(err && err.message || err)}</div>`;
});
