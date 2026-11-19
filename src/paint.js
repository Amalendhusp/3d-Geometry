import * as THREE from 'three';

// Two CPU canvases (front and back of the sheet) used as textures.
// Brush strokes only re-upload the rectangle that changed.

export class PaintSurface {
  constructor(renderer) {
    this.renderer = renderer;
    this.front = this.makeSide();
    this.back = this.makeSide();
    this.scratch = document.createElement('canvas');
    this.scratchCtx = this.scratch.getContext('2d', { willReadFrequently: true });
    this.stroke = null;
  }

  makeSide() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return { canvas, ctx, texture, base: '#ffffff', dirty: null };
  }

  // Create blank sheets for a W x H metre paper.
  create(W, H, frontColor, backColor, maxPx = 2048) {
    const pxPerM = Math.min(maxPx / Math.max(W, H), 6000);
    this.pxPerM = pxPerM;
    this.W = W;
    this.H = H;
    const cw = Math.max(16, Math.round(W * pxPerM));
    const ch = Math.max(16, Math.round(H * pxPerM));
    for (const [side, color] of [[this.front, frontColor], [this.back, backColor]]) {
      side.texture.dispose();
      side.canvas = document.createElement('canvas');
      side.canvas.width = cw;
      side.canvas.height = ch;
      side.ctx = side.canvas.getContext('2d', { willReadFrequently: true });
      side.base = color;
      side.ctx.fillStyle = color;
      side.ctx.fillRect(0, 0, cw, ch);
      const t = new THREE.CanvasTexture(side.canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      side.texture = t;
      side.dirty = null;
    }
    this.scratch.width = cw;
    this.scratch.height = ch;
  }

  clear() {
    for (const side of [this.front, this.back]) {
      side.ctx.fillStyle = side.base;
      side.ctx.fillRect(0, 0, side.canvas.width, side.canvas.height);
      side.texture.needsUpdate = true;
      side.dirty = null;
    }
  }

  toPx(x, y) {
    return [(x / this.W) * this.front.canvas.width, (1 - y / this.H) * this.front.canvas.height];
  }

  markDirty(side, x0, y0, x1, y1) {
    const c = side.canvas;
    const r = [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), Math.min(c.width, Math.ceil(x1)), Math.min(c.height, Math.ceil(y1))];
    if (r[2] <= r[0] || r[3] <= r[1]) return;
    if (!side.dirty) side.dirty = r;
    else {
      const d = side.dirty;
      d[0] = Math.min(d[0], r[0]); d[1] = Math.min(d[1], r[1]);
      d[2] = Math.max(d[2], r[2]); d[3] = Math.max(d[3], r[3]);
    }
    if (this.stroke && this.stroke.side === side) {
      const s = this.stroke.rect;
      if (!s) this.stroke.rect = r.slice();
      else {
        s[0] = Math.min(s[0], r[0]); s[1] = Math.min(s[1], r[1]);
        s[2] = Math.max(s[2], r[2]); s[3] = Math.max(s[3], r[3]);
      }
    }
  }

  beginStroke(sideName) {
    const side = this[sideName];
    this.scratchCtx.globalCompositeOperation = 'copy';
    this.scratchCtx.drawImage(side.canvas, 0, 0);
    this.scratchCtx.globalCompositeOperation = 'source-over';
    this.stroke = { side, sideName, rect: null };
  }

  // Draw a segment between two paper points. radius is in metres.
  segment(sideName, a, b, radius, color) {
    const side = this[sideName];
    const ctx = side.ctx;
    const [x0, y0] = this.toPx(a[0], a[1]);
    const [x1, y1] = this.toPx(b[0], b[1]);
    const r = Math.max(0.6, radius * this.pxPerM);
    ctx.fillStyle = ctx.strokeStyle = color ?? side.base;
    if (Math.hypot(x1 - x0, y1 - y0) < 0.5) {
      ctx.beginPath();
      ctx.arc(x1, y1, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = r * 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    this.markDirty(side, Math.min(x0, x1) - r - 2, Math.min(y0, y1) - r - 2, Math.max(x0, x1) + r + 2, Math.max(y0, y1) + r + 2);
  }

  // Finish a stroke; returns an undo record for the changed area.
  endStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (!s || !s.rect) return null;
    const [x0, y0, x1, y1] = s.rect;
    const data = this.scratchCtx.getImageData(x0, y0, x1 - x0, y1 - y0);
    return { type: 'paint', side: s.sideName, x: x0, y: y0, data };
  }

  undo(rec) {
    const side = this[rec.side];
    side.ctx.putImageData(rec.data, rec.x, rec.y);
    this.markDirty(side, rec.x, rec.y, rec.x + rec.data.width, rec.y + rec.data.height);
  }

  fill(sideName, color) {
    const side = this[sideName];
    side.ctx.fillStyle = color;
    side.ctx.fillRect(0, 0, side.canvas.width, side.canvas.height);
    side.texture.needsUpdate = true;
    side.dirty = null;
  }

  // Push changed pixels to the GPU. Call once per frame.
  flush() {
    for (const side of [this.front, this.back]) {
      if (!side.dirty) continue;
      const [x0, y0, x1, y1] = side.dirty;
      side.dirty = null;
      if (!this.uploadRect(side, x0, y0, x1 - x0, y1 - y0)) side.texture.needsUpdate = true;
    }
  }

  uploadRect(side, x, y, w, h) {
    try {
      const props = this.renderer.properties.get(side.texture);
      const tex = props.__webglTexture;
      if (!tex || props.__version !== side.texture.version) return false;
      const gl = this.renderer.getContext();
      const data = side.ctx.getImageData(x, y, w, h);
      this.renderer.state.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.generateMipmap(gl.TEXTURE_2D);
      return true;
    } catch (err) {
      console.warn('Partial texture upload failed, falling back', err);
      return false;
    }
  }
}
