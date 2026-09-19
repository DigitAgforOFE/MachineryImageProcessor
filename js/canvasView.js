// Handles image display, zoom/pan, and marker rendering + hit-testing/dragging on a <canvas>.
// All marker coordinates passed in/out are in ORIGINAL IMAGE pixel space, independent of zoom.

const MARKER_RADIUS = 9;
const HIT_RADIUS = 16;
const DRAG_THRESHOLD = 4;

export class CanvasView {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.handlers = handlers; // { onClick(imagePoint), onMarkerDrag(ref, imagePoint), onMarkerDragEnd(ref) }
    this.image = null;
    this.scale = 1; // screen px per image px
    this.offsetX = 0;
    this.offsetY = 0;
    this.markers = []; // [{x, y, color, ref, shape}]
    this.lines = []; // [{p1, p2, color}] connector lines (scale bar, diameter pairs, quick measure)

    this._drag = null; // {ref, startScreen, moved}
    this._pinch = null;

    this._bindEvents();
    new ResizeObserver(() => this._onResize()).observe(canvas.parentElement);
  }

  setImage(img) {
    this.image = img;
    this._onResize();
    this.fitToView();
  }

  fitToView() {
    if (!this.image) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const s = Math.min(cw / this.image.width, ch / this.image.height) * 0.95;
    this.scale = s;
    this.offsetX = (cw - this.image.width * s) / 2;
    this.offsetY = (ch - this.image.height * s) / 2;
  }

  setOverlay(markers, lines) {
    this.markers = markers;
    this.lines = lines;
    this.render();
  }

  _onResize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.render();
  }

  screenToImage(sx, sy) {
    const rect = this.canvas.getBoundingClientRect();
    const x = sx - rect.left;
    const y = sy - rect.top;
    return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale };
  }

  imageToScreen(ix, iy) {
    return { x: ix * this.scale + this.offsetX, y: iy * this.scale + this.offsetY };
  }

  zoomAt(screenX, screenY, factor) {
    const before = this.screenToImage(screenX, screenY);
    this.scale = Math.min(20, Math.max(0.05, this.scale * factor));
    const rect = this.canvas.getBoundingClientRect();
    const x = screenX - rect.left;
    const y = screenY - rect.top;
    this.offsetX = x - before.x * this.scale;
    this.offsetY = y - before.y * this.scale;
    this.render();
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.image) return;

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);
    ctx.drawImage(this.image, 0, 0);
    ctx.restore();

    for (const line of this.lines) {
      const a = this.imageToScreen(line.p1.x, line.p1.y);
      const b = this.imageToScreen(line.p2.x, line.p2.y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(line.dashed ? [6, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const m of this.markers) {
      const s = this.imageToScreen(m.x, m.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      if (m.label) {
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(m.label, s.x, s.y);
      }
    }
  }

  _findMarkerAt(screenX, screenY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = screenX - rect.left;
    const y = screenY - rect.top;
    let best = null;
    let bestDist = Infinity;
    for (const m of this.markers) {
      const s = this.imageToScreen(m.x, m.y);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= HIT_RADIUS && d < bestDist) {
        best = m;
        bestDist = d;
      }
    }
    return best;
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      this.zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    c.addEventListener("mousedown", (e) => this._pointerDown(e.clientX, e.clientY));
    window.addEventListener("mousemove", (e) => this._pointerMove(e.clientX, e.clientY));
    window.addEventListener("mouseup", (e) => this._pointerUp(e.clientX, e.clientY));

    c.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        this._pointerDown(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2) {
        this._drag = null;
        this._pinch = this._pinchState(e.touches);
      }
      e.preventDefault();
    }, { passive: false });

    c.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1 && !this._pinch) {
        this._pointerMove(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2) {
        this._handlePinch(e.touches);
      }
      e.preventDefault();
    }, { passive: false });

    c.addEventListener("touchend", (e) => {
      if (e.touches.length === 0) {
        this._pinch = null;
        if (this._lastTouch) this._pointerUp(this._lastTouch.x, this._lastTouch.y);
      }
      e.preventDefault();
    }, { passive: false });
  }

  _pinchState(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return {
      dist: Math.hypot(dx, dy),
      midX: (touches[0].clientX + touches[1].clientX) / 2,
      midY: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  _handlePinch(touches) {
    const next = this._pinchState(touches);
    if (this._pinch) {
      const factor = next.dist / this._pinch.dist;
      this.zoomAt(next.midX, next.midY, factor);
    }
    this._pinch = next;
  }

  _pointerDown(x, y) {
    this._lastTouch = { x, y };
    const marker = this._findMarkerAt(x, y);
    this._drag = { ref: marker ? marker.ref : null, isPan: !marker, startScreen: { x, y }, moved: false, lastScreen: { x, y } };
  }

  _pointerMove(x, y) {
    this._lastTouch = { x, y };
    if (!this._drag) return;
    const dx = x - this._drag.lastScreen.x;
    const dy = y - this._drag.lastScreen.y;
    if (Math.hypot(x - this._drag.startScreen.x, y - this._drag.startScreen.y) > DRAG_THRESHOLD) {
      this._drag.moved = true;
    }
    if (!this._drag.moved) return;

    if (this._drag.ref) {
      const imgPt = this.screenToImage(x, y);
      this.handlers.onMarkerDrag(this._drag.ref, imgPt);
    } else if (this._drag.isPan) {
      this.offsetX += dx;
      this.offsetY += dy;
      this.render();
    }
    this._drag.lastScreen = { x, y };
  }

  _pointerUp(x, y) {
    if (!this._drag) return;
    const drag = this._drag;
    this._drag = null;
    if (drag.ref && drag.moved) {
      this.handlers.onMarkerDragEnd(drag.ref);
      return;
    }
    if (!drag.moved) {
      // A plain click, even one that landed on an existing marker (e.g. a tool's
      // characteristic-size click starting right on top of its own position marker),
      // should still register as a new point rather than being silently absorbed.
      const imgPt = this.screenToImage(x, y);
      this.handlers.onClick(imgPt);
    }
  }
}
