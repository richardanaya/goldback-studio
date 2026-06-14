import * as THREE from 'three';

// A single Goldback note simulated as a verlet sheet.  It is NOT cloth: the
// Goldback is a stiff gold-polymer foil, so the sim uses strong in-plane links
// plus a dedicated bending-stiffness pass.  The sheet stays mostly flat, bends
// in big smooth curves, and crisply settles instead of draping/wrinkling.
// Aspect ratio matches the source art: 678 x 1200  (~0.565).
export const NOTE_ASPECT = 678 / 1200;
export const NOTE_H = 2.2;
export const NOTE_W = NOTE_H * NOTE_ASPECT;
export const COLS = 15;
export const ROWS = 26;

const GRAVITY = new THREE.Vector3(0, -8.5, 0);
const DAMPING = 0.94;          // crisp: sheds jiggle fast, unlike floppy cloth
const STRUCT_ITERS = 7;        // in-plane stiffness (resists stretch/shear)
const BEND_ITERS = 5;          // out-of-plane stiffness (resists folding)
const BEND_STIFF = 0.55;       // how hard the sheet fights curvature
export const FLOOR_Y = -1.55;  // table top — kept close under the note

let _id = 0;

export class Note {
  constructor() {
    this.id = _id++;
    this.n = COLS * ROWS;

    // Flat geometry in the note's local XY plane, centered on origin.
    this.restLocal = new Float32Array(this.n * 3);
    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.tmp = new Float32Array(this.n * 3);

    const dx = NOTE_W / (COLS - 1);
    const dy = NOTE_H / (ROWS - 1);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = (r * COLS + c) * 3;
        this.restLocal[i] = (c - (COLS - 1) / 2) * dx;
        this.restLocal[i + 1] = ((ROWS - 1) / 2 - r) * dy;
        this.restLocal[i + 2] = 0;
      }
    }

    const idx = (r, c) => r * COLS + c;

    // In-plane distance constraints: structural (neighbours) + shear (diagonals).
    // These keep the sheet from stretching, so it behaves like a solid foil.
    this.constraints = [];
    const add = (a, b) => {
      const ax = a * 3, bx = b * 3;
      const ddx = this.restLocal[ax] - this.restLocal[bx];
      const ddy = this.restLocal[ax + 1] - this.restLocal[bx + 1];
      this.constraints.push(a, b, Math.hypot(ddx, ddy));
    };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (c + 1 < COLS) add(idx(r, c), idx(r, c + 1));
        if (r + 1 < ROWS) add(idx(r, c), idx(r + 1, c));
        if (c + 1 < COLS && r + 1 < ROWS) add(idx(r, c), idx(r + 1, c + 1));
        if (c - 1 >= 0 && r + 1 < ROWS) add(idx(r, c), idx(r + 1, c - 1));
      }
    }

    // Bending triplets: a centre particle with its two opposite neighbours.
    // Straightening these (centre toward the midpoint) gives the sheet real
    // stiffness, so it resists folding the way a polymer note does.
    this.bend = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 1; c < COLS - 1; c++) this.bend.push(idx(r, c - 1), idx(r, c), idx(r, c + 1));
    }
    for (let c = 0; c < COLS; c++) {
      for (let r = 1; r < ROWS - 1; r++) this.bend.push(idx(r - 1, c), idx(r, c), idx(r + 1, c));
    }

    // Each note rests at a slightly different floor height so notes lying flat
    // never become coplanar (which would z-fight / glitch the textures).
    this.floorBias = (this.id % 14) * 0.0055;

    // Pose the note is anchored to / held toward.
    this.anchorPos = new THREE.Vector3();
    this.anchorQuat = new THREE.Quaternion();
    this.hold = 1;          // 0 = free sheet, 1 = rigidly holds rest pose
    this.holdTarget = 1;
    this.grabbed = -1;      // particle index being dragged, or -1
    this.grabPoint = new THREE.Vector3();

    this._restWorld = new THREE.Vector3();
    this.resetToAnchor();
  }

  worldRest(i, out) {
    out.set(this.restLocal[i * 3], this.restLocal[i * 3 + 1], this.restLocal[i * 3 + 2]);
    out.applyQuaternion(this.anchorQuat).add(this.anchorPos);
    return out;
  }

  resetToAnchor() {
    for (let i = 0; i < this.n; i++) {
      this.worldRest(i, this._restWorld);
      const k = i * 3;
      this.pos[k] = this.prev[k] = this._restWorld.x;
      this.pos[k + 1] = this.prev[k + 1] = this._restWorld.y;
      this.pos[k + 2] = this.prev[k + 2] = this._restWorld.z;
    }
  }

  setPose(pos, quat, hold = 1) {
    this.anchorPos.copy(pos);
    this.anchorQuat.copy(quat);
    this.holdTarget = hold;
  }

  step(dt, wind, time) {
    this.hold += (this.holdTarget - this.hold) * Math.min(1, dt * 4);
    const free = 1 - this.hold;
    const dt2 = dt * dt;
    const { pos, prev, tmp } = this;

    // Integrate.
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      for (let a = 0; a < 3; a++) {
        const j = k + a;
        tmp[j] = pos[j];
        let acc = GRAVITY.getComponent(a) * free;
        if (free > 0.05) {
          // gentle wind: a stiff foil catches air and sails rather than flutters
          const wx = Math.sin(pos[k + 1] * 1.4 + time * 2.0 + i * 0.15);
          const wz = Math.cos(pos[k] * 1.1 + time * 1.6 + i * 0.3);
          if (a === 0) acc += wind.x * free + wx * wind.t * 0.6;
          if (a === 1) acc += wx * wind.t * 0.15;
          if (a === 2) acc += wind.z * free + wz * wind.t * 0.6;
        }
        pos[j] += (pos[j] - prev[j]) * DAMPING + acc * dt2;
        prev[j] = tmp[j];
      }
    }

    // Satisfy in-plane distance constraints (keeps the foil from stretching).
    const cs = this.constraints;
    for (let iter = 0; iter < STRUCT_ITERS; iter++) {
      for (let c = 0; c < cs.length; c += 3) {
        const a = cs[c] * 3, b = cs[c + 1] * 3, rest = cs[c + 2];
        const dx = pos[b] - pos[a];
        const dy = pos[b + 1] - pos[a + 1];
        const dz = pos[b + 2] - pos[a + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = ((d - rest) / d) * 0.5;
        const ox = dx * diff, oy = dy * diff, oz = dz * diff;
        pos[a] += ox; pos[a + 1] += oy; pos[a + 2] += oz;
        pos[b] -= ox; pos[b + 1] -= oy; pos[b + 2] -= oz;
      }
    }

    // Bending stiffness: pull each triplet's centre toward the midpoint of its
    // neighbours so the sheet resists creasing and springs back toward flat.
    const bd = this.bend;
    for (let iter = 0; iter < BEND_ITERS; iter++) {
      for (let t = 0; t < bd.length; t += 3) {
        const a = bd[t] * 3, m = bd[t + 1] * 3, c = bd[t + 2] * 3;
        const ex = (pos[a] + pos[c]) * 0.5 - pos[m];
        const ey = (pos[a + 1] + pos[c + 1]) * 0.5 - pos[m + 1];
        const ez = (pos[a + 2] + pos[c + 2]) * 0.5 - pos[m + 2];
        const sm = ex * BEND_STIFF, smy = ey * BEND_STIFF, smz = ez * BEND_STIFF;
        pos[m] += sm; pos[m + 1] += smy; pos[m + 2] += smz;
        const half = BEND_STIFF * 0.5;
        pos[a] -= ex * half; pos[a + 1] -= ey * half; pos[a + 2] -= ez * half;
        pos[c] -= ex * half; pos[c + 1] -= ey * half; pos[c + 2] -= ez * half;
      }
    }

    // Hold toward rest pose (stack / fan / flat keep their shape).
    if (this.hold > 0.001) {
      const h = this.hold;
      for (let i = 0; i < this.n; i++) {
        if (i === this.grabbed) continue;
        this.worldRest(i, this._restWorld);
        const k = i * 3;
        pos[k] += (this._restWorld.x - pos[k]) * h;
        pos[k + 1] += (this._restWorld.y - pos[k + 1]) * h;
        pos[k + 2] += (this._restWorld.z - pos[k + 2]) * h;
      }
    }

    // Grabbed particle follows the cursor.
    if (this.grabbed >= 0) {
      const k = this.grabbed * 3;
      pos[k] = this.grabPoint.x; pos[k + 1] = this.grabPoint.y; pos[k + 2] = this.grabPoint.z;
    }

    // Floor — each note rests on its own slightly-raised plane to avoid z-fight.
    const floor = FLOOR_Y + this.floorBias;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      if (pos[k + 1] < floor) {
        pos[k + 1] = floor;
        prev[k + 1] = floor;
        prev[k] += (pos[k] - prev[k]) * 0.5; // friction
      }
    }
  }

  // Shake the sheet: inject a ripple impulse and briefly relax the hold so it
  // ruffles in place, then springs back to its pose as `hold` recovers.
  ruffle() {
    this.hold = Math.min(this.hold, 0.03);
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      const lx = this.restLocal[k], ly = this.restLocal[k + 1];
      const wave = Math.sin(ly * 5.0 + lx * 3.0) * 0.07 + (Math.random() - 0.5) * 0.05;
      this.prev[k + 2] -= wave;                       // out-of-plane ripple velocity
      this.prev[k] -= (Math.random() - 0.5) * 0.035;  // a little lateral snap
    }
  }
}
