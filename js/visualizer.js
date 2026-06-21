// visualizer.js — real-time analog-stick plot with drift trail & deadzone ring.
export class StickViz {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._size();
    this.trail = [];
    this.deadzone = 0;       // normalized 0..1, drawn as a ring when set
    this.restCenter = null;  // {x,y} normalized, captured center marker
    this.pos = { x: 0, y: 0 };
  }

  _size() {
    const { c } = this;
    c.width = 250 * this.dpr; c.height = 250 * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this.W = 250; this.H = 250;
  }

  set(norm) {
    this.pos = { x: norm[0], y: norm[1] };
    const mag = Math.hypot(norm[0], norm[1]);
    if (mag > 0.04) {
      this.trail.push({ x: norm[0], y: norm[1] });
      if (this.trail.length > 90) this.trail.shift();
    }
  }

  clearTrail() { this.trail = []; }

  draw() {
    const { ctx, W, H } = this;
    const cx = W / 2, cy = H / 2, R = W / 2 - 22;
    ctx.clearRect(0, 0, W, H);

    // grid rings
    ctx.strokeStyle = 'rgba(120,150,220,0.10)';
    ctx.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) ring(ctx, cx, cy, R * f);
    // crosshair
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

    // deadzone ring
    if (this.deadzone > 0) {
      ctx.strokeStyle = 'rgba(255,177,60,0.55)';
      ctx.setLineDash([4, 4]); ring(ctx, cx, cy, R * this.deadzone); ctx.setLineDash([]);
    }

    // trail
    if (this.trail.length > 1) {
      ctx.lineWidth = 2;
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1], b = this.trail[i];
        const alpha = i / this.trail.length;
        ctx.strokeStyle = `rgba(79,140,255,${alpha * 0.5})`;
        ctx.beginPath();
        ctx.moveTo(cx + a.x * R, cy + a.y * R);
        ctx.lineTo(cx + b.x * R, cy + b.y * R);
        ctx.stroke();
      }
    }

    // captured rest-center marker
    if (this.restCenter) {
      const mx = cx + this.restCenter.x * R, my = cy + this.restCenter.y * R;
      ctx.strokeStyle = 'rgba(47,213,126,0.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx - 6, my); ctx.lineTo(mx + 6, my);
      ctx.moveTo(mx, my - 6); ctx.lineTo(mx, my + 6); ctx.stroke();
    }

    // live dot
    const px = cx + this.pos.x * R, py = cy + this.pos.y * R;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, 12);
    grad.addColorStop(0, '#9cc2ff'); grad.addColorStop(1, '#2e6be6');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

function ring(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
