// Yürüme modu: masaüstünde WASD/oklar + sürükleyerek bakış, telefonda sol yarıda joystick,
// sağ yarıda sürükleyerek bakış. Duvar, sabit engel ve mobilyalarla çarpışma (gövde yarıçapı 20 cm).

import { add, dot, pointInPolygon, scale, sub } from '../core/geom.js';

const RADIUS = 20; // cm
const SPEED = 140; // cm/s
const DEG = Math.PI / 180;

function closestOnPoly(p, poly) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ab = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
    const c = add(a, scale(ab, t));
    const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return { point: best, dist: bestD };
}

export class WalkControls {
  constructor(dom, joystickEl) {
    this.dom = dom;
    this.joyEl = joystickEl;
    this.knob = joystickEl.querySelector('.knob');
    this.enabled = false;
    this.pos = [0, 0];
    this.yaw = 0; // plan açısı (derece): bakılan yön (cos, sin)
    this.pitch = 0;
    this.keys = new Set();
    this.joy = null; // { id, cx, cy, dx, dy }
    this.look = null; // { id, x, y }
    this.obstacles = [];
    this.walkable = [];
    this.collideFurniture = true;
    this._bind();
  }

  setWorld(obstacles, walkable) {
    this.obstacles = obstacles;
    this.walkable = walkable;
  }

  place(pos, yaw) {
    this.pos = [...pos];
    this.yaw = yaw;
    this.pitch = -5;
  }

  _bind() {
    const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.target.closest?.('input,select,textarea')) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'q', 'e'].includes(k)) {
        this.keys.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    this.dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      const r = this.dom.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (isTouch(e) && x < r.width / 2 && !this.joy) {
        this.joy = { id: e.pointerId, cx: x, cy: y, dx: 0, dy: 0 };
        this.joyEl.hidden = false;
        this.joyEl.style.left = `${x}px`;
        this.joyEl.style.top = `${y}px`;
        this.knob.style.transform = '';
      } else if (!this.look) {
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
      this.dom.setPointerCapture?.(e.pointerId);
    });
    this.dom.addEventListener('pointermove', (e) => {
      if (!this.enabled) return;
      if (this.joy && e.pointerId === this.joy.id) {
        const r = this.dom.getBoundingClientRect();
        let dx = e.clientX - r.left - this.joy.cx;
        let dy = e.clientY - r.top - this.joy.cy;
        const l = Math.hypot(dx, dy);
        const max = 50;
        if (l > max) {
          dx = (dx / l) * max;
          dy = (dy / l) * max;
        }
        this.joy.dx = dx / max;
        this.joy.dy = dy / max;
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (this.look && e.pointerId === this.look.id) {
        const k = isTouch(e) ? 0.3 : 0.22;
        this.yaw += (e.clientX - this.look.x) * k;
        this.pitch = Math.max(-75, Math.min(75, this.pitch - (e.clientY - this.look.y) * k));
        this.look.x = e.clientX;
        this.look.y = e.clientY;
      }
    });
    const end = (e) => {
      if (this.joy && e.pointerId === this.joy.id) {
        this.joy = null;
        this.joyEl.hidden = true;
      }
      if (this.look && e.pointerId === this.look.id) this.look = null;
    };
    this.dom.addEventListener('pointerup', end);
    this.dom.addEventListener('pointercancel', end);
  }

  setEnabled(on) {
    this.enabled = on;
    this.keys.clear();
    this.joy = null;
    this.look = null;
    this.joyEl.hidden = true;
  }

  _insideHome(p) {
    return this.walkable.some((poly) => pointInPolygon(p, poly));
  }

  _resolve(p) {
    let q = [...p];
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const o of this.obstacles) {
        if (!this.collideFurniture && o.kind === 'item') continue;
        const inside = pointInPolygon(q, o.poly);
        const { point, dist } = closestOnPoly(q, o.poly);
        if (inside) {
          const dir = sub(point, q);
          const l = Math.hypot(...dir) || 1;
          q = add(point, scale(dir, RADIUS / l));
          moved = true;
        } else if (dist < RADIUS) {
          const dir = sub(q, point);
          q = add(point, scale(dir, RADIUS / (dist || 1)));
          moved = true;
        }
      }
      if (!moved) break;
    }
    return q;
  }

  update(dt) {
    if (!this.enabled) return;
    let f = 0;
    let s = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) f += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) f -= 1;
    if (this.keys.has('d')) s += 1;
    if (this.keys.has('a')) s -= 1;
    if (this.keys.has('arrowleft') || this.keys.has('q')) this.yaw -= 90 * dt;
    if (this.keys.has('arrowright') || this.keys.has('e')) this.yaw += 90 * dt;
    if (this.joy) {
      f -= this.joy.dy;
      s += this.joy.dx;
    }
    const l = Math.hypot(f, s);
    if (l < 0.05) return;
    if (l > 1) {
      f /= l;
      s /= l;
    }
    const speed = SPEED * (this.keys.has('shift') ? 2 : 1);
    const a = this.yaw * DEG;
    const fwd = [Math.cos(a), Math.sin(a)];
    const right = [-Math.sin(a), Math.cos(a)];
    const step = add(scale(fwd, f * speed * dt), scale(right, s * speed * dt));
    // Küçük adımlarla ilerle (ince duvarların içinden geçmemek için).
    const n = Math.ceil(Math.hypot(...step) / 5);
    for (let i = 0; i < n; i++) {
      const cand = this._resolve(add(this.pos, scale(step, 1 / n)));
      if (this._insideHome(cand)) this.pos = cand;
    }
  }

  applyToCamera(camera, eye) {
    const a = this.yaw * DEG;
    const p = this.pitch * DEG;
    camera.position.set(this.pos[0] / 100, eye / 100, this.pos[1] / 100);
    camera.lookAt(
      camera.position.x + Math.cos(p) * Math.cos(a),
      camera.position.y + Math.sin(p),
      camera.position.z + Math.cos(p) * Math.sin(a),
    );
  }
}
