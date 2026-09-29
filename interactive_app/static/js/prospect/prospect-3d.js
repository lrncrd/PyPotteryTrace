// Prospect Canvas - the docked 3D views of the applied parts (handles, lugs)
//
// Side, top and orbit views of an applied part and of the piece of vessel it is on. There is one
// surface: the smooth union of the wall and the parts (prospect-field.js), meshed as quads; the views
// draw that mesh, and the quads can be shown on it. They show the volume the drawing only suggests,
// and they are where the dimension the drawing does not give is edited: in the top view the crest of
// a horizontal handle or a lug (height above the wall along its length) is dragged. The outlines
// traced on the drawing are never changed from here (see "Adopt").
//
// The views are for reading, not for reproducing the drawing: the light is attached to the camera
// (from above-left of the viewer), so every view is readable.

(function () {
    const M = () => window.ProspectMesh;
    const FD = () => window.ProspectField;

    const PICK_PX = 9;
    const START_ORBIT = () => ({ yaw: -0.6, pitch: -0.35, zoom: 1, panX: 0, panY: 0 });
    const MAX_VOXELS = 2.5e6;
    const smooth = t => t * t * (3 - 2 * t);
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

    class Prospect3D {
        constructor(pc) {
            this.pc = pc;
            this.dock = document.getElementById('prospect-dock');
            if (!this.dock) return;
            this.views = {
                side: { canvas: document.getElementById('prospect-view-side') },
                top: { canvas: document.getElementById('prospect-view-top') },
                orbit: { canvas: document.getElementById('prospect-view-3d') }
            };
            this.orbit = START_ORBIT();
            this.vesselMode = 'fragment';
            this.slice = 0.5;        // height of the section shown from above for a vertical handle (0..1)
            this.showQuads = true;
            this.quadSize = 8;       // px of the drawing
            this.pending = false;
            this.built = null;       // fields and mesh of the current model
            this.topMap = null;      // screen <-> world mapping of the top view, and its crest markers
            this.drag = null;
            this.visible = false;

            const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
            on('prospect-dock-toggle', 'click', () => this.setVisible(!this.visible));
            on('prospect-dock-expand', 'click', () => {
                this.dock.classList.toggle('expanded');
                this.resizeAll();
            });
            on('prospect-view-reset', 'click', () => { this.orbit = START_ORBIT(); this.invalidate(); });
            on('prospect-view-vessel', 'change', e => { this.vesselMode = e.target.value; this.invalidate(); });
            on('prospect-view-slice', 'input', e => { this.slice = e.target.value / 100; this.invalidate(); });
            on('prospect-view-quads', 'click', () => {
                this.showQuads = !this.showQuads;
                document.getElementById('prospect-view-quads').classList.toggle('active', this.showQuads);
                this.invalidate();
            });
            on('prospect-view-quad-size', 'input', e => { this.quadSize = parseFloat(e.target.value); this.invalidate(); });
            const q = document.getElementById('prospect-view-quads');
            if (q) q.classList.toggle('active', this.showQuads);
            this.setupOrbit();
            this.setupTop();
            new ResizeObserver(() => this.resizeAll()).observe(this.dock);
        }

        setVisible(v) {
            this.visible = v;
            this.dock.style.display = v && this.pc.handlesAvailable ? '' : 'none';
            const btn = document.getElementById('prospect-dock-toggle');
            if (btn) btn.classList.toggle('active', v);
            this.resizeAll();
            this.invalidate();
        }

        // The dock follows the current element: it is only there for a vessel that can take applied parts
        sync() {
            const available = this.pc.handlesAvailable;
            const btn = document.getElementById('prospect-dock-toggle');
            if (btn) btn.style.display = available ? '' : 'none';
            this.dock.style.display = this.visible && available ? '' : 'none';
        }

        resizeAll() {
            for (const v of Object.values(this.views)) {
                const r = v.canvas.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                v.w = Math.round(r.width);
                v.h = Math.round(r.height);
                if (v.canvas.width !== v.w) v.canvas.width = v.w;
                if (v.canvas.height !== v.h) v.canvas.height = v.h;
                v.cache = null;
            }
            this.invalidate();
        }

        invalidate() {
            this.sync();
            if (!this.visible || this.pending || !this.pc.handlesAvailable) return;
            this.pending = true;
            requestAnimationFrame(() => {
                this.pending = false;
                this.render();
            });
        }

        // ------------------------------------------------------------------
        // Scene: fields and mesh
        // ------------------------------------------------------------------

        // The fields of the applied parts of the current model, and the mesh of the surface around the
        // part the views are about. Rebuilt only when what they depend on changes.
        scene() {
            const pc = this.pc, scene = pc.scene;
            const selected = pc.selectedFront ? pc.selectedFront.id : null;
            const specs = pc.model.fronts;
            const key = [pc.prospect.id, scene.axisX, scene.radius.y0, scene.radius.y1, scene.radius.radius.length,
                JSON.stringify(specs.map(f => [f.id, f.part, f.axis, f.roundness, f.thickness, f.blend, f.points, f.plan]))].join('|');
            if (!this.built || this.built.key !== key) {
                const vessel = FD().vesselField(scene);
                const list = [];
                for (const spec of specs) {
                    const part = scene.parts.find(p => p.id === spec.part) || null;
                    const pf = FD().partField(spec, part, scene, vessel);
                    if (pf) list.push({ spec, pf });
                }
                this.built = { key, vessel, list, mesh: null, meshKey: '' };
            }
            const b = this.built;
            const target = b.list.find(s => s.spec.id === selected) || b.list[0] || null;
            if (!target) return { list: b.list, target: null, selected };
            const meshKey = `${target.spec.id}|${this.vesselMode}|${this.quadSize}`;
            if (b.meshKey !== meshKey) {
                b.mesh = this.buildMesh(b, target);
                b.meshKey = meshKey;
            }
            return { list: b.list, target, selected, vessel: b.vessel, mesh: b.mesh, F: b.F, info: b.info };
        }

        // The surface: quads around the target part (the piece of wall it is on), or the whole vessel
        buildMesh(b, target) {
            const scene = this.pc.scene, pf = target.pf, vessel = b.vessel, mode = this.vesselMode;
            const F = FD().unionOf(mode === 'none' ? null : vessel, b.list.map(s => s.pf));
            const info = (x, y, z) => {
                const dv = vessel.sd(x, y, z);
                let h = 0, part = -1;
                b.list.forEach((s, i) => {
                    const sh = FD().share(dv, s.pf.sd(x, y, z), s.pf.kAt(x, y));
                    if (sh > h) { h = sh; part = i; }
                });
                return { h: mode === 'none' ? 1 : h, part: h > 0.3 || mode === 'none' ? part : -1 };
            };
            b.F = F;
            b.info = info;
            const bb = pf.bb;
            let u, y, r, span;
            if (mode === 'full') {
                let rMax = 0;
                for (let yy = vessel.y0; yy <= vessel.y1; yy += 8) rMax = Math.max(rMax, vessel.radiusAt(yy + 0.5));
                for (const s of b.list) rMax = Math.max(rMax, s.pf.rhoMax);
                u = [-rMax - 8, rMax + 8]; r = [-rMax - 8, rMax + 8]; y = [vessel.y0 - 4, vessel.y1 + 4];
                span = 2 * rMax;
            } else {
                const spanU = 2 * pf.halfU, spanY = bb.y1 - bb.y0;
                const margin = mode === 'none' ? 8 : Math.max(40, 0.35 * Math.max(spanU, spanY));
                y = [Math.max(vessel.y0 - 4, bb.y0 - margin), Math.min(vessel.y1 + 4, bb.y1 + margin)];
                let rMin = Infinity, rMax = 0;
                for (let yy = y[0]; yy <= y[1]; yy += 4) { const rr = vessel.radiusAt(yy + 0.5); rMin = Math.min(rMin, rr); rMax = Math.max(rMax, rr); }
                const halfL = pf.halfU + margin;
                u = [-halfL, halfL];
                const lo = Math.sqrt(Math.max(0, rMin * rMin - halfL * halfL));
                r = [mode === 'none' ? rMin - 30 : lo - 12, Math.max(rMax, ...b.list.map(s => s.pf.rhoMax)) + 12];
                span = Math.max(u[1] - u[0], y[1] - y[0], r[1] - r[0]);
            }
            let step = Math.max(this.quadSize, span / 130);
            const voxels = () => ((u[1] - u[0]) / step) * ((y[1] - y[0]) / step) * ((r[1] - r[0]) / step);
            while (voxels() > MAX_VOXELS) step *= 1.15;
            return FD().quadMesh(F, info, { ax: scene.axisX, theta: pf.theta, u, y, r, step });
        }

        // ------------------------------------------------------------------
        // Drawing
        // ------------------------------------------------------------------

        // Light attached to the camera: from the viewer, a little from above and from the left
        lightOf(cam) {
            const v = cam.view, r = cam.right, d = cam.down;
            const L = [0, 1, 2].map(i => 0.8 * v[i] - 0.5 * d[i] - 0.35 * r[i]);
            const l = Math.hypot(L[0], L[1], L[2]);
            return (nx, ny, nz) => Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / l);
        }

        // Shaded mesh: the wall grey, the parts warm (the selected one blue), with one continuous tint
        // from the wall into the part where they join
        paint(view, ras, mesh, targetIdx, lit) {
            const ctx = view.canvas.getContext('2d');
            const img = ctx.createImageData(view.w, view.h);
            const d = img.data, W = view.w, n = W * view.h;
            for (let k = 0; k < n; k++) {
                const id = ras.id[k];
                let r = 255, g = 255, b = 255;
                if (id >= 0) {
                    const l = 0.3 + 0.7 * lit(ras.nx[k], ras.ny[k], ras.nz[k]);
                    const s = smooth(clamp((ras.attr[k] - 0.1) / 0.8, 0, 1));
                    const sel = mesh.part[ras.vert[k]] === targetIdx || mesh.part[ras.vert[k]] < 0;
                    const pr = sel ? 90 * l + 90 : 240 * l + 10, pg = sel ? 150 * l + 70 : 190 * l + 10, pb = sel ? 255 * l : 140 * l + 10;
                    r = (205 * l + 25) * (1 - s) + pr * s; g = (210 * l + 25) * (1 - s) + pg * s; b = (220 * l + 25) * (1 - s) + pb * s;
                    // a dark line where the surface ends against the background
                    const x = k % W, y = (k / W) | 0;
                    const edge = x === 0 || y === 0 || x === W - 1 || y === view.h - 1 ||
                        ras.id[k - 1] < 0 || ras.id[k + 1] < 0 || ras.id[k - W] < 0 || ras.id[k + W] < 0;
                    if (edge) { r *= 0.3; g *= 0.3; b *= 0.3; }
                }
                d[4 * k] = r; d[4 * k + 1] = g; d[4 * k + 2] = b; d[4 * k + 3] = 255;
            }
            ctx.putImageData(img, 0, 0);
            return ctx;
        }

        // The quads: their edges where they face the camera
        drawQuads(ctx, view, ras, mesh, cam) {
            if (!this.showQuads) return;
            const V = mesh.pos.length / 3;
            const sx = new Float32Array(V), sy = new Float32Array(V), sz = new Float32Array(V);
            for (let i = 0; i < V; i++) {
                const p = cam.project(mesh.pos[3 * i], mesh.pos[3 * i + 1], mesh.pos[3 * i + 2]);
                sx[i] = p[0]; sy[i] = p[1]; sz[i] = p[2];
            }
            const tol = mesh.step * 0.9;
            ctx.strokeStyle = 'rgba(15, 30, 90, 0.45)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            const e = mesh.wire, W = view.w;
            for (let t = 0; t < e.length; t += 2) {
                const a = e[t], b = e[t + 1];
                const mx = (sx[a] + sx[b]) / 2, my = (sy[a] + sy[b]) / 2;
                const i = Math.round(mx), j = Math.round(my);
                if (i < 0 || j < 0 || i >= W || j >= view.h) continue;
                const k = j * W + i;
                if (ras.id[k] < 0 || (sz[a] + sz[b]) / 2 < ras.z[k] - tol) continue;
                ctx.moveTo(sx[a], sy[a]);
                ctx.lineTo(sx[b], sy[b]);
            }
            ctx.stroke();
        }

        empty(v, text) {
            const ctx = v.canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, v.w, v.h);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '12px sans-serif';
            ctx.fillText(text, 10, 24);
        }

        label(ctx, text, line = 0) {
            ctx.fillStyle = '#475569';
            ctx.font = '11px sans-serif';
            ctx.fillText(text, 8, 14 + 13 * line);
        }

        // An orbit camera looking at a mesh, zoomed to fit it in the view (with the user's zoom and pan)
        fitCamera(mesh, angles, v, extra = {}) {
            let sx = 0, sy = 0, sz = 0, n = 0;
            for (let i = 0; i < mesh.pos.length; i += 3) { sx += mesh.pos[i]; sy += mesh.pos[i + 1]; sz += mesh.pos[i + 2]; n++; }
            const cx = sx / n, cy = sy / n, cz = sz / n;
            const c1 = M().orbitCamera({ cx, cy, cz, yaw: angles.yaw, pitch: angles.pitch, W: 0, H: 0, scale: 1 });
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (let i = 0; i < mesh.pos.length; i += 3) {
                const p = c1.project(mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]);
                x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
            }
            const scale = (extra.zoom || 1) * Math.min((v.w - 24) / Math.max(1, x1 - x0), (v.h - 24) / Math.max(1, y1 - y0));
            const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
            return M().orbitCamera({
                cx, cy, cz, yaw: angles.yaw, pitch: angles.pitch, W: v.w, H: v.h, scale,
                panX: -mx * scale + (extra.panX || 0), panY: -my * scale + (extra.panY || 0)
            });
        }

        render() {
            const pc = this.pc;
            if (!pc.handlesAvailable || !pc.model) return;
            for (const v of Object.values(this.views)) if (!v.w) { this.resizeAll(); return; }
            const sc = this.scene();
            if (!sc.target || !sc.mesh || !sc.mesh.idx.length) {
                for (const v of Object.values(this.views)) this.empty(v, 'Place a handle or a lug to see it here');
                this.topMap = null;
                return;
            }
            const { target, mesh } = sc;
            const targetIdx = sc.list.indexOf(target);
            const theta = target.pf.theta;

            // 3D: from outside, a little from the side and from above
            {
                const v = this.views.orbit;
                const cam = this.fitCamera(mesh, { yaw: -theta + this.orbit.yaw, pitch: this.orbit.pitch }, v, this.orbit);
                const ras = M().rasterize([mesh], cam, v.w, v.h);
                const ctx = this.paint(v, ras, mesh, targetIdx, this.lightOf(cam));
                this.drawQuads(ctx, v, ras, mesh, cam);
                this.label(ctx, `${mesh.quads.length / 4} quads`);
            }
            // Side: looking across the plane through the axis and the part, like the drawn side view
            {
                const v = this.views.side;
                const yaw = Math.atan2(-Math.cos(theta), -Math.sin(theta));
                const cam = this.fitCamera(mesh, { yaw, pitch: 0 }, v);
                const ras = M().rasterize([mesh], cam, v.w, v.h);
                const ctx = this.paint(v, ras, mesh, targetIdx, this.lightOf(cam));
                this.drawQuads(ctx, v, ras, mesh, cam);
                this.label(ctx, 'outside on the left, the wall on the right');
                if (target.pf.stats) this.label(ctx, target.pf.stats, 1);
            }
            this.renderTop(sc, targetIdx);
        }

        // From above: the mesh for a horizontal handle or a lug; for a vertical handle the section at
        // the height chosen with the slider, cut in the surface (the wall and the handle as one shape)
        renderTop(sc, targetIdx) {
            const pc = this.pc, v = this.views.top, scene = pc.scene, pf = sc.target.pf;
            const { mesh, vessel, F } = sc;
            if (pf.axis === 'y') {
                const ys = Math.round(pf.yTop + this.slice * (pf.yBot - pf.yTop));
                const cT = Math.cos(pf.theta), sT = Math.sin(pf.theta);
                const halfL = pf.halfU * 2.2 + 30;
                const rw = vessel.radiusAt(ys + 0.5);
                const lo = Math.sqrt(Math.max(0, rw * rw - halfL * halfL)) - 24, hi = pf.rhoMax * 1.03 + 10;
                const scale = Math.min((v.w - 16) / (2 * halfL), (v.h - 16) / (hi - lo));
                const key = `${sc.list.indexOf(sc.target)}|${ys}|${v.w}x${v.h}|${this.built.key}|${this.vesselMode}`;
                if (!v.cache || v.cache.key !== key) {
                    const img = new ImageData(v.w, v.h);
                    const dd = img.data;
                    const fieldOf = this.vesselMode === 'none' ? (x, y, z) => pf.sd(x, y, z) : F;
                    const at = (px, py) => {
                        const u = (px - v.w / 2) / scale, rr = (py - v.h / 2) / scale + (lo + hi) / 2;
                        return [scene.axisX + u * cT + rr * sT, ys + 0.5, -u * sT + rr * cT];
                    };
                    for (let py = 0; py < v.h; py++) {
                        for (let px = 0; px < v.w; px++) {
                            const [x, y, z] = at(px + 0.5, py + 0.5);
                            const f = fieldOf(x, y, z);
                            const k = 4 * (py * v.w + px);
                            let r = 255, g = 255, b = 255;
                            if (f < 0) {
                                // the wall inside the wall (what the part has inside it is hidden), the part inside the part, and a tint
                                // where the fillet has added material between them
                                let h = 1;
                                if (this.vesselMode !== 'none') {
                                    const dv = vessel.sd(x, y, z), dp = pf.sd(x, y, z);
                                    h = dv < 0 ? 0 : dp < 0 ? 1 : FD().share(dv, dp, pf.kAt(x, y));
                                }
                                const s = smooth(clamp((h - 0.1) / 0.8, 0, 1));
                                r = 205 * (1 - s) + 90 * s + 20; g = 210 * (1 - s) + 150 * s + 20; b = 220 * (1 - s) + 255 * s;
                            }
                            if (Math.abs(f) < 0.6 / scale) { r = 30; g = 40; b = 90; }
                            dd[k] = r; dd[k + 1] = g; dd[k + 2] = b; dd[k + 3] = 255;
                        }
                    }
                    v.cache = { key, img };
                }
                const ctx = v.canvas.getContext('2d');
                ctx.putImageData(v.cache.img, 0, 0);
                this.label(ctx, `section at row ${ys} (slider above); outside at the bottom`);
                this.topMap = null;
                return;
            }
            // horizontal: the mesh seen from above, x right and z down (towards the viewer of the drawing)
            const b = pf.bb;
            const zs = [0, 1, 2, 3].map(i => FD().wallZ(scene, b.x0 + (b.x1 - b.x0) * i / 3, (b.y0 + b.y1) / 2));
            const Z1 = Math.max(pf.rhoMax, ...zs) + 25, Z0 = Math.min(...zs) - 25;
            const padX = Math.max(30, 0.25 * (b.x1 - b.x0));
            const X0 = b.x0 - padX, X1 = b.x1 + padX;
            const scale = Math.min((v.w - 16) / (X1 - X0), (v.h - 16) / (Z1 - Z0));
            const mx = (X0 + X1) / 2, mz = (Z0 + Z1) / 2;
            const cam = M().orbitCamera({ cx: mx, cy: 0, cz: mz, yaw: 0, pitch: -Math.PI / 2, W: v.w, H: v.h, scale });
            const ras = M().rasterize([mesh], cam, v.w, v.h);
            const ctx = this.paint(v, ras, mesh, sc.list.indexOf(sc.target), this.lightOf(cam));
            this.drawQuads(ctx, v, ras, mesh, cam);
            const toScreen = (x, z) => [v.w / 2 + scale * (x - mx), v.h / 2 + scale * (z - mz)];
            // crest markers: where the outer surface of the part is, along its length
            this.topMap = { scale, mx, mz, target: sc.target, markers: [] };
            const spec = sc.target.spec;
            const plan = pf.plan;
            const cy = (b.y0 + b.y1) / 2;
            const rw = vessel.radiusAt(cy + 0.5);
            ctx.strokeStyle = '#2563eb';
            ctx.fillStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            plan.forEach((p, i) => {
                const x = pf.xmin + p.t * (pf.xmax - pf.xmin);
                const dx = x - scene.axisX;
                const z = Math.sqrt(Math.max(0, (rw + p.dz) * (rw + p.dz) - dx * dx));
                const [sx, sy] = toScreen(x, z);
                ctx.beginPath();
                ctx.arc(sx, sy, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                this.topMap.markers.push({ i, x, cy, rw, sx, sy });
            });
            void spec;
            this.label(ctx, 'from above: drag the crest points');
        }

        // ------------------------------------------------------------------
        // Interaction
        // ------------------------------------------------------------------

        setupOrbit() {
            const c = this.views.orbit.canvas;
            c.style.touchAction = 'none';
            c.addEventListener('pointerdown', e => {
                c.setPointerCapture(e.pointerId);
                this.drag = { kind: 'orbit', x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
            });
            c.addEventListener('pointermove', e => {
                if (!this.drag || this.drag.kind !== 'orbit') return;
                const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
                this.drag.x = e.clientX; this.drag.y = e.clientY;
                if (this.drag.pan) { this.orbit.panX += dx; this.orbit.panY += dy; }
                else {
                    this.orbit.yaw += dx * 0.01;
                    this.orbit.pitch = Math.max(-1.5, Math.min(1.5, this.orbit.pitch + dy * 0.01));
                }
                this.invalidate();
            });
            const end = () => { if (this.drag && this.drag.kind === 'orbit') this.drag = null; };
            c.addEventListener('pointerup', end);
            c.addEventListener('pointercancel', end);
            c.addEventListener('contextmenu', e => e.preventDefault());
            c.addEventListener('wheel', e => {
                e.preventDefault();
                this.orbit.zoom = Math.max(0.3, Math.min(8, this.orbit.zoom * Math.exp(-e.deltaY * 0.0015)));
                this.invalidate();
            }, { passive: false });
            c.addEventListener('dblclick', () => { this.orbit = START_ORBIT(); this.invalidate(); });
        }

        // A point of the top view: the crest of a horizontal part follows the pointer (its height above the wall)
        setupTop() {
            const c = this.views.top.canvas;
            c.style.touchAction = 'none';
            const pos = e => {
                const r = c.getBoundingClientRect();
                return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height };
            };
            c.addEventListener('pointerdown', e => {
                if (!this.topMap) return;
                const p = pos(e);
                const hit = this.topMap.markers.find(m => Math.hypot(m.sx - p.x, m.sy - p.y) <= PICK_PX);
                if (!hit) return;
                c.setPointerCapture(e.pointerId);
                this.drag = { kind: 'crest', index: hit.i, moved: false };
            });
            c.addEventListener('pointermove', e => {
                if (!this.drag || this.drag.kind !== 'crest' || !this.topMap) return;
                const p = pos(e), t = this.topMap;
                const spec = t.target.spec;
                const m = t.markers.find(q => q.i === this.drag.index);
                if (!m) return;
                const z = (p.y - this.views.top.h / 2) / t.scale + t.mz;
                const dx = m.x - this.pc.scene.axisX;
                if (!spec.plan || !spec.plan.length) spec.plan = t.target.pf.plan.map(q => Object.assign({}, q));
                spec.plan[this.drag.index].dz = Math.max(0, Math.round((Math.sqrt(dx * dx + z * z) - m.rw) * 10) / 10);
                this.drag.moved = true;
                this.pc.recomputeShading();
                this.pc.redraw();
            });
            const end = () => {
                if (this.drag && this.drag.kind === 'crest') {
                    if (this.drag.moved) { this.pc.pushHistory(); this.pc.updateUI(); }
                    this.drag = null;
                }
            };
            c.addEventListener('pointerup', end);
            c.addEventListener('pointercancel', end);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        // after the canvas controller (both listen to DOMContentLoaded, this file is loaded later)
        if (window.prospectCanvas) window.prospect3d = new Prospect3D(window.prospectCanvas);
    });
})();
