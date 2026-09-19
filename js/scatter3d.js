// A small, dependency-free rotatable 3D scatter renderer (orthographic, hand-rolled —
// no WebGL/three.js, so it works fully offline in the field).

const PITCH = 0.5; // fixed elevation angle, radians

export class Scatter3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.points = []; // {x, z, length, color} — length is the tool's measured characteristic size, drawn as a vertical stem down from Y=0
    this.yaw = -0.6;
    this._drag = null;
    this._bindEvents();
    new ResizeObserver(() => this.render()).observe(canvas.parentElement);
  }

  setPoints(points) {
    this.points = points;
    this.render();
  }

  rotateBy(delta) {
    this.yaw += delta;
    this.render();
  }

  resetView() {
    this.yaw = -0.6;
    this.render();
  }

  _project(pt, scale, cx, cy) {
    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw);
    const rx = pt.x * cosY + pt.z * sinY;
    const rz = -pt.x * sinY + pt.z * cosY;
    const cosP = Math.cos(PITCH), sinP = Math.sin(PITCH);
    const screenX = cx + rx * scale;
    const screenY = cy + (-pt.y * cosP + rz * sinP) * scale;
    const depth = pt.y * sinP + rz * cosP;
    return { screenX, screenY, depth };
  }

  render() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    let maxExtent = 20;
    for (const p of this.points) {
      maxExtent = Math.max(maxExtent, Math.abs(p.x), Math.abs(p.z), p.length || 0);
    }
    const scale = (Math.min(w, h) * 0.38) / maxExtent;
    const cx = w / 2, cy = h / 2 - h * 0.05;

    // Ground grid in the X-Z plane, at y=0, for spatial reference.
    ctx.strokeStyle = "#2a2f38";
    ctx.lineWidth = 1;
    const gridStep = niceStep(maxExtent);
    const gridExtent = Math.ceil(maxExtent / gridStep) * gridStep;
    for (let g = -gridExtent; g <= gridExtent; g += gridStep) {
      const a = this._project({ x: g, y: 0, z: -gridExtent }, scale, cx, cy);
      const b = this._project({ x: g, y: 0, z: gridExtent }, scale, cx, cy);
      ctx.beginPath();
      ctx.moveTo(a.screenX, a.screenY);
      ctx.lineTo(b.screenX, b.screenY);
      ctx.stroke();
      const c = this._project({ x: -gridExtent, y: 0, z: g }, scale, cx, cy);
      const d = this._project({ x: gridExtent, y: 0, z: g }, scale, cx, cy);
      ctx.beginPath();
      ctx.moveTo(c.screenX, c.screenY);
      ctx.lineTo(d.screenX, d.screenY);
      ctx.stroke();
    }

    // Axis lines: X (lateral), Z (depth), Y (each tool's measured size, drawn downward).
    drawAxis(ctx, this._project({ x: -gridExtent, y: 0, z: 0 }, scale, cx, cy), this._project({ x: gridExtent, y: 0, z: 0 }, scale, cx, cy), "#ff5c5c", "X (left–right)");
    drawAxis(ctx, this._project({ x: 0, y: 0, z: -gridExtent }, scale, cx, cy), this._project({ x: 0, y: 0, z: gridExtent }, scale, cx, cy), "#4f8cff", "Z (front–back)");
    drawAxis(ctx, this._project({ x: 0, y: 0, z: 0 }, scale, cx, cy), this._project({ x: 0, y: -maxExtent, z: 0 }, scale, cx, cy), "#26de81", "Y (tool size)");

    // Each point is either a flat dot (no characteristic size measured yet) or a stem
    // running from the toolbar (Y=0) down to Y=-length — sorted farthest-first so nearer
    // stems draw on top.
    const items = this.points.map((p) => {
      const top = this._project({ x: p.x, y: 0, z: p.z }, scale, cx, cy);
      if (p.length) {
        const bottom = this._project({ x: p.x, y: -p.length, z: p.z }, scale, cx, cy);
        return { p, top, bottom, depth: (top.depth + bottom.depth) / 2 };
      }
      return { p, top, bottom: null, depth: top.depth };
    });
    items.sort((a, b) => b.depth - a.depth);

    for (const { p, top, bottom, depth } of items) {
      const depthNorm = Math.max(0.5, Math.min(1.4, 1 - depth / (maxExtent * 2)));
      ctx.globalAlpha = Math.max(0.55, depthNorm);

      if (bottom) {
        ctx.beginPath();
        ctx.moveTo(top.screenX, top.screenY);
        ctx.lineTo(bottom.screenX, bottom.screenY);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2.5 * depthNorm;
        ctx.stroke();
        drawDot(ctx, top.screenX, top.screenY, 3 * depthNorm, p.color);
        drawDot(ctx, bottom.screenX, bottom.screenY, 5.5 * depthNorm, p.color);
      } else {
        drawDot(ctx, top.screenX, top.screenY, 6 * depthNorm, p.color);
      }
      ctx.globalAlpha = 1;
    }
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("mousedown", (e) => this._dragStart(e.clientX));
    window.addEventListener("mousemove", (e) => this._dragMove(e.clientX));
    window.addEventListener("mouseup", () => (this._drag = null));
    c.addEventListener("touchstart", (e) => this._dragStart(e.touches[0].clientX), { passive: true });
    c.addEventListener("touchmove", (e) => this._dragMove(e.touches[0].clientX), { passive: true });
    c.addEventListener("touchend", () => (this._drag = null));
  }

  _dragStart(x) {
    this._drag = { lastX: x };
  }

  _dragMove(x) {
    if (!this._drag) return;
    const dx = x - this._drag.lastX;
    this._drag.lastX = x;
    this.yaw += dx * 0.006;
    this.render();
  }
}

function niceStep(extent) {
  const raw = extent / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * pow;
}

function drawDot(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "#10131a";
  ctx.stroke();
}

function drawAxis(ctx, a, b, color, label) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(a.screenX, a.screenY);
  ctx.lineTo(b.screenX, b.screenY);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "11px sans-serif";
  ctx.fillText(label, b.screenX + 4, b.screenY);
}
