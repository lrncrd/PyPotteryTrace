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
    const G = () => window.ProspectGeometry;

    const PICK_PX = 9;
    const KEY_TOL = 0.006;      // a section edited within this height (0..1 of the handle) is the same one
    const DOUBLE_TAP_MS = 350;
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
            this.editing = false;    // the section or the side view is being dragged: the mesh waits for the end
            this.symmetric = true;   // the shoulders of the section move together
            this.secMap = null;      // screen <-> section of the top view of a vertical handle, and its handles
            this.sideMap = null;     // the same for the side view
            this.lastTap = null;
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
            on('prospect-sec-sym', 'click', () => {
                this.symmetric = !this.symmetric;
                document.getElementById('prospect-sec-sym').classList.toggle('active', this.symmetric);
            });
            const sym = document.getElementById('prospect-sec-sym');
            if (sym) sym.classList.toggle('active', this.symmetric);
            on('prospect-sec-clear', 'click', () => this.editSpec(spec => {
                if (!spec.sections) return false;
                spec.sections = spec.sections.filter(k => Math.abs(k.t - this.slice) >= KEY_TOL);
                if (!spec.sections.length) delete spec.sections;
                return true;
            }));
            on('prospect-sec-reset', 'click', () => this.editSpec(spec => {
                if (!spec.sections) return false;
                delete spec.sections;
                return true;
            }));
            // (back to the chosen shape of lume, as deep as in the section drawn)
            on('prospect-lume-reset', 'click', () => this.editSpec(spec => {
                if (!spec.under && spec.lumeShape !== 'custom') return false;
                delete spec.under; delete spec.underLow; delete spec.underNear; delete spec.underNearLow;
                if (spec.bez) { delete spec.bez.up; delete spec.bez.low; delete spec.bez.nup; delete spec.bez.nlow; }
                if (spec.lumeShape === 'custom') spec.lumeShape = spec.kind === 'lug' ? 'none' : 'arch';
                return true;
            }));
            on('prospect-side-reset', 'click', () => this.editSpec(spec => {
                if (!spec.sideEdit) return false;
                delete spec.sideEdit;
                return true;
            }));
            this.setupOrbit();
            this.setupTop();
            this.setupSide();
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
                JSON.stringify(specs.map(({ shadow, bend, ...f }) => f))].join('|');
            if (!this.built || this.built.key !== key) {
                const vessel = FD().vesselField(scene);
                const list = [];
                for (const spec of specs) {
                    const part = scene.parts.find(p => p.id === spec.part) || null;
                    const pf = FD().partField(spec, part, scene, vessel);
                    if (pf) list.push({ spec, pf });
                }
                // (while the section or the side view is dragged the mesh of before stays, to the end of
                // the drag: the views being edited are drawn from the fields)
                const old = this.built;
                this.built = { key, vessel, list, mesh: old ? old.mesh : null, meshKey: old ? old.meshKey : '' };
            }
            const b = this.built;
            const target = b.list.find(s => s.spec.id === selected) || b.list[0] || null;
            this.target = target;
            if (!target) return { list: b.list, target: null, selected };
            this.fields(b);
            const meshKey = `${target.spec.id}|${this.vesselMode}|${this.quadSize}|${b.key}`;
            if (b.meshKey !== meshKey && !(this.editing && b.mesh)) {
                b.mesh = this.buildMesh(b, target);
                b.meshKey = meshKey;
            }
            return { list: b.list, target, selected, vessel: b.vessel, mesh: b.mesh, F: b.F, info: b.info };
        }

        // The surface of the vessel and the parts (F), and what a point of it belongs to (info)
        fields(b) {
            const vessel = b.vessel, mode = this.vesselMode;
            b.F = FD().unionOf(mode === 'none' ? null : vessel, b.list.map(s => s.pf));
            b.info = (x, y, z) => {
                const dv = vessel.sd(x, y, z);
                let h = 0, part = -1;
                b.list.forEach((s, i) => {
                    const sh = FD().share(dv, s.pf.sd(x, y, z), s.pf.kAt(x, y));
                    if (sh > h) { h = sh; part = i; }
                });
                return { h: mode === 'none' ? 1 : h, part: h > 0.3 || mode === 'none' ? part : -1 };
            };
        }

        // The surface: quads around the target part (the piece of wall it is on), or the whole vessel
        buildMesh(b, target) {
            const scene = this.pc.scene, pf = target.pf, vessel = b.vessel, mode = this.vesselMode;
            const { F, info } = b;
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
                this.topMap = this.secMap = this.sideMap = null;
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
            this.syncButtons(target.pf);
            // Side of a horizontal handle or a lug: the section across the strap, at the position chosen with the slider
            if (target.pf.axis === 'x') this.renderCut(sc);
            // Side: looking across the plane through the axis and the part, like the drawn side view
            else {
                const v = this.views.side;
                const yaw = Math.atan2(-Math.cos(theta), -Math.sin(theta));
                // (the camera stays put while an end is dragged, so the handle stays under the pointer)
                const cam = this.drag && this.drag.kind === 'side' ? this.drag.cam : this.fitCamera(mesh, { yaw, pitch: 0 }, v);
                const ras = M().rasterize([mesh], cam, v.w, v.h);
                const ctx = this.paint(v, ras, mesh, targetIdx, this.lightOf(cam));
                this.drawQuads(ctx, v, ras, mesh, cam);
                this.drawSideEdit(ctx, cam, target);
                this.label(ctx, 'outside on the left, the wall on the right');
                if (target.pf.stats) this.label(ctx, target.pf.stats, 1);
                if (this.sideMap) this.label(ctx, 'drag the ends up or down', 2);
                this.secMap = null;
            }
            this.renderTop(sc, targetIdx);
        }

        // The controls that only make sense for one kind of part
        syncButtons(pf) {
            const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
            show('prospect-lume-reset', pf.axis === 'x' && pf.underPlan.length > 0);
            show('prospect-plan-shift', pf.axis === 'x');
            show('prospect-side-reset', pf.axis === 'y');
        }

        // The section across the strap of a horizontal handle or a lug at the position `slice` along its
        // length, cut in the surface (the wall and the part as one shape), with the handles of the section.
        // Outside on the left, the wall on the right, like the side view of a vertical handle.
        renderCut(sc) {
            const v = this.views.side, scene = this.pc.scene, pf = sc.target.pf, spec = sc.target.spec;
            const { vessel, F } = sc, ax = scene.axisX;
            const xs = Math.round(pf.xmin + this.slice * (pf.xmax - pf.xmin)) + 0.5;
            const fr = pf.frameAt(xs), dx = xs - ax;
            const rowAt = y => { const r = vessel.radiusAt(y + 0.5), sl = vessel.slopeAt(y + 0.5); return [r, Math.sqrt(1 + sl * sl)]; };
            const zOf = (y, dv) => { const [r, k] = rowAt(y); const rr = r + dv * k; return Math.sqrt(Math.max(0, rr * rr - dx * dx)); };
            const dvOf = (y, z) => { const [r, k] = rowAt(y); return (Math.hypot(dx, z) - r) / k; };
            const halfY = (fr.hw + fr.dz) * 1.4 + 24, ymid = fr.cy - 0.3 * fr.dz * Math.sin(pf.phi);
            const zHi = zOf(fr.cy, Math.hypot(Math.max(fr.dz, 10), fr.hw) + 16), zLo = zOf(fr.cy, -40), zmid = (zHi + zLo) / 2;
            const scale = Math.min((v.w - 16) / Math.max(1, zHi - zLo), (v.h - 16) / (2 * halfY));
            const st = this.editing ? 2 : 1;
            const key = `cut|${sc.list.indexOf(sc.target)}|${Math.round(xs)}|${v.w}x${v.h}|${this.built.key}|${this.vesselMode}|${st}`;
            if (!v.cache || v.cache.key !== key) {
                const img = new ImageData(v.w, v.h), dd = img.data;
                // The section as chosen: the strap alone, as high as it is here, with no hole and no change of height along
                // it (what the hole and the crest do to it is seen in the views from above and below)
                let cp = pf;
                if (!pf.asDrawn) {
                    const flat = [{ t: 0, dz: fr.dz }, { t: 1, dz: fr.dz }], none = [{ t: 0, dz: 0 }, { t: 1, dz: 0 }];
                    const { bez, ...rest } = spec;
                    cp = FD().partField(Object.assign(rest, { plan: flat, under: none, underLow: none, lumeShape: 'arch' }), scene.parts.find(q => q.id === spec.part) || null, scene, vessel) || pf;
                }
                const fieldOf = this.vesselMode === 'none' ? (x, y, z) => cp.sd(x, y, z) : (cp === pf ? F : FD().unionOf(vessel, [cp]));
                for (let py = 0; py < v.h; py += st) {
                    for (let px = 0; px < v.w; px += st) {
                        const y = (py + 0.5 * st - v.h / 2) / scale + ymid, z = zmid - (px + 0.5 * st - v.w / 2) / scale;
                        const f = fieldOf(xs, y, z);
                        let r = 255, g = 255, b = 255;
                        if (f < 0) {
                            let h = 1;
                            if (this.vesselMode !== 'none') {
                                const dv = vessel.sd(xs, y, z), dp = cp.sd(xs, y, z);
                                h = dv < 0 ? 0 : dp < 0 ? 1 : FD().share(dv, dp, cp.kAt(xs, y));
                            }
                            const s = smooth(clamp((h - 0.1) / 0.8, 0, 1));
                            r = 205 * (1 - s) + 90 * s + 20; g = 210 * (1 - s) + 150 * s + 20; b = 220 * (1 - s) + 255 * s;
                        }
                        if (Math.abs(f) < 0.6 * st / scale) { r = 30; g = 40; b = 90; }
                        for (let j = py; j < Math.min(v.h, py + st); j++) {
                            for (let i = px; i < Math.min(v.w, px + st); i++) {
                                const q = 4 * (j * v.w + i);
                                dd[q] = r; dd[q + 1] = g; dd[q + 2] = b; dd[q + 3] = 255;
                            }
                        }
                    }
                }
                v.cache = { key, img };
            }
            const ctx = v.canvas.getContext('2d');
            ctx.putImageData(v.cache.img, 0, 0);
            const k = (spec.sections || []).find(q => Math.abs(q.t - this.slice) < KEY_TOL);
            const sec = k || FD().sectionTrack(spec)(this.slice);
            // s across the front outline (-1 its top edge), f depth below the crest, in units of fr.depth
            // (a turned arch: the strap turns as a solid about the line through the middle of its outline, at
            // height cy; s across the section, f the depth below its crest, in the section as it was before)
            const cF = Math.cos(pf.phi), sF = Math.sin(pf.phi);
            const toScreen = (s, f) => {
                const u = s * fr.hw, r = fr.dz - f * fr.depth;
                const dv = u * sF + r * cF, y = fr.cy + u * cF - r * sF, z = zOf(y, dv);
                return [v.w / 2 - (z - zmid) * scale, v.h / 2 + (y - ymid) * scale];
            };
            const fromScreen = (px, py) => {
                const y = (py - v.h / 2) / scale + ymid, z = zmid - (px - v.w / 2) / scale, dv = dvOf(y, z);
                const p = y - fr.cy, u = p * cF + dv * sF, r = -p * sF + dv * cF;
                return { s: u / fr.hw, f: (fr.dz - r) / fr.depth };
            };
            // the inclination: the middle of the crest, dragged: it sits at (cy - dz sin, dz cos) about the axis
            const leanAt = (px, py) => {
                const y = (py - v.h / 2) / scale + ymid, z = zmid - (px - v.w / 2) / scale;
                return Math.round(clamp(Math.atan2(fr.cy - y, Math.max(0.5, dvOf(y, z))) * 180 / Math.PI, -90, 90));
            };
            // (a round or oval section is fixed: only the tilt is handled; the shoulders and points are for the others)
            const locked = pf.sectionLocked;
            const markers = locked ? [] : [{ kind: 'sl', p: toScreen(sec.sl, sec.fl) }, { kind: 'sr', p: toScreen(sec.sr, sec.fr) }];
            if (fr.dz > 3 && !pf.asDrawn) markers.push({ kind: 'lean', p: toScreen(0, 0) });
            if (k && !locked) k.pts.forEach((q, i) => markers.push({ kind: 'pt', i, p: toScreen(q.s, q.f) }));
            for (const m of markers) {
                if (m.kind === 'lean') { ctx.fillStyle = '#2563eb'; ctx.fillRect(m.p[0] - 5, m.p[1] - 5, 10, 10); }
                else this.marker(ctx, m.p[0], m.p[1], m.kind !== 'pt');
            }
            this.secMap = { view: 'side', markers: markers.map(m => ({ kind: m.kind, i: m.i, sx: m.p[0], sy: m.p[1] })), fromScreen, leanAt, spec, locked };
            this.sideMap = null;
            this.label(ctx, `section across the strap at ${Math.round(this.slice * 100)}% of its length (slider above)`);
            this.label(ctx, pf.asDrawn ? 'the section as drawn next to the profile (its inclination too)'
                : locked ? 'round and oval sections are fixed (Square, Strap or Custom can be shaped)'
                    : 'drag the shoulders; double-tap: add or remove a point', 1);
            if (!pf.asDrawn) this.label(ctx, 'drag the square up or down: the arch tilts', 2);
            const edited = locked ? [] : (spec.sections || []).map(q => `${Math.round(q.t * 100)}%`);
            if (edited.length) this.label(ctx, `edited at ${edited.join(', ')}`, 3);
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
                const st = this.editing ? 2 : 1;   // (half resolution while a handle is dragged)
                const key = `${sc.list.indexOf(sc.target)}|${ys}|${v.w}x${v.h}|${this.built.key}|${this.vesselMode}|${st}`;
                if (!v.cache || v.cache.key !== key) {
                    const img = new ImageData(v.w, v.h);
                    const dd = img.data;
                    const fieldOf = this.vesselMode === 'none' ? (x, y, z) => pf.sd(x, y, z) : F;
                    const at = (px, py) => {
                        const u = (px - v.w / 2) / scale, rr = (py - v.h / 2) / scale + (lo + hi) / 2;
                        return [scene.axisX + u * cT + rr * sT, ys + 0.5, -u * sT + rr * cT];
                    };
                    for (let py = 0; py < v.h; py += st) {
                        for (let px = 0; px < v.w; px += st) {
                            const [x, y, z] = at(px + 0.5 * st, py + 0.5 * st);
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
                            if (Math.abs(f) < 0.6 * st / scale) { r = 30; g = 40; b = 90; }
                            for (let j = py; j < Math.min(v.h, py + st); j++) {
                                for (let i = px; i < Math.min(v.w, px + st); i++) {
                                    const q = 4 * (j * v.w + i);
                                    dd[q] = r; dd[q + 1] = g; dd[q + 2] = b; dd[q + 3] = 255;
                                }
                            }
                        }
                    }
                    v.cache = { key, img };
                }
                const ctx = v.canvas.getContext('2d');
                ctx.putImageData(v.cache.img, 0, 0);
                this.drawSectionEdit(ctx, v, sc, { ys, lo, hi, scale, cT, sT });
                this.label(ctx, `section at row ${ys} (slider above); outside at the bottom`);
                const edited = (sc.target.spec.sections || []).map(k => `${Math.round(k.t * 100)}%`);
                this.label(ctx, 'drag the shoulders; double-tap: add or remove a point', 1);
                if (edited.length) this.label(ctx, `edited at ${edited.join(', ')}`, 2);
                this.topMap = null;
                return;
            }
            // horizontal: plain 2D drawings, from above and from below, x to the right, the wall and the curves (Bezier)
            const b = pf.bbFoot, spec = sc.target.spec;
            const zs = [0, 1, 2, 3].map(i => FD().wallZ(scene, b.x0 + (b.x1 - b.x0) * i / 3, (b.y0 + b.y1) / 2));
            const Z1 = Math.max(pf.rhoMax, ...zs) + 10, Z0 = Math.min(...zs) - 10;
            const padX = Math.max(20, 0.15 * (b.x1 - b.x0));
            const X0 = b.x0 - padX, X1 = b.x1 + padX;
            const mx = (X0 + X1) / 2, mz = (Z0 + Z1) / 2;
            const cy = (b.y0 + b.y1) / 2, rw = vessel.radiusAt(cy + 0.5), ax = scene.axisX;
            const len = pf.xmax - pf.xmin;
            // from above (the outside at the bottom) and, for a handle, from below (the outside at the top)
            const hole = pf.underPlan.length > 0, closed = pf.underNearPlan.length > 0;
            const hp = hole ? Math.floor(v.h / 2) : v.h;
            const panels = (hole ? ['up', 'low'] : ['up']).map((key, i) => ({
                key, flip: key === 'up' ? 1 : -1, y0: i * hp, h: hp,
                scale: Math.min((v.w - 16) / (X1 - X0), (hp - 30) / (Z1 - Z0))
            }));
            const ctx = v.canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, v.w, v.h);
            const items = [];
            this.topMap = { panels, items, mx, mz, rw, ax, pf, spec, xmin: pf.xmin, len };
            if (!this.sel || this.sel.id !== spec.id) this.sel = null;
            const nodesOf = key => (spec.bez && spec.bez[key]) || (pf.circleNodes && !spec.under && (key === 'up' || key === 'low') ? pf.circleNodes.far : pf.circleNodes && !spec.underNear && (key === 'nup' || key === 'nlow') ? pf.circleNodes.near : null) || FD().bezFromPlan(key === 'crest' ? pf.plan : key === 'up' ? pf.underPlan : key === 'low' ? pf.underLowPlan : key === 'nup' ? pf.underNearPlan : pf.underNearLowPlan);
            for (const pn of panels) {
                const sx = x => v.w / 2 + pn.scale * (x - mx), sy = z => pn.y0 + pn.h / 2 + pn.flip * pn.scale * (z - mz) + 6;
                const at = (t, dz) => {
                    const x = pf.xmin + t * len, dx = x - ax;
                    return [sx(x), sy(Math.sqrt(Math.max(0, (rw + Math.max(0, dz)) ** 2 - dx * dx)))];
                };
                pn.at = at;
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, pn.y0, v.w, pn.h);
                ctx.clip();
                // the vessel: the wall, and what is inside it
                const wall = [];
                for (let x = X0; x <= X1; x += (X1 - X0) / 80) wall.push([sx(x), sy(Math.sqrt(Math.max(0, rw * rw - (x - ax) ** 2)))]);
                ctx.fillStyle = '#e2e8e0';
                ctx.beginPath();
                wall.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
                ctx.lineTo(sx(X1), pn.flip > 0 ? pn.y0 - 5 : pn.y0 + pn.h + 5);
                ctx.lineTo(sx(X0), pn.flip > 0 ? pn.y0 - 5 : pn.y0 + pn.h + 5);
                ctx.fill();
                ctx.strokeStyle = '#1e2a5a';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                wall.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
                ctx.stroke();
                // the curves: crest, and the lume on this side (the one on the other side dashed)
                const list = [['crest', '#2563eb', false]];
                const far = pn.key, near = 'n' + pn.key, oFar = far === 'up' ? 'low' : 'up';
                if (hole) list.push([far, '#d97706', false]);
                if (closed) list.push([near, '#d97706', false]);
                if (hole) list.push([oFar, '#d97706', true]);
                if (closed) list.push(['n' + oFar, '#d97706', true]);
                const lines = {};
                for (const [key, color, dashed] of list) {
                    const nodes = nodesOf(key), line = [];
                    for (let i = 0; i < nodes.length - 1; i++) {
                        const a = nodes[i], c = nodes[i + 1];
                        const P = [[a.t, a.z], [a.t + a.hr[0], a.z + a.hr[1]], [c.t + c.hl[0], c.z + c.hl[1]], [c.t, c.z]];
                        for (let k = 0; k <= 16; k++) {
                            const u = k / 16, w = 1 - u;
                            const t = w * w * w * P[0][0] + 3 * w * w * u * P[1][0] + 3 * w * u * u * P[2][0] + u * u * u * P[3][0];
                            const z = w * w * w * P[0][1] + 3 * w * w * u * P[1][1] + 3 * w * u * u * P[2][1] + u * u * u * P[3][1];
                            const q = at(t, z);
                            line.push({ x: q[0], y: q[1], seg: i, u });
                        }
                    }
                    lines[key + (dashed ? '*' : '')] = line;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = dashed ? 1 : 2;
                    ctx.setLineDash(dashed ? [4, 4] : []);
                    ctx.beginPath();
                    line.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
                    ctx.stroke();
                    ctx.setLineDash([]);
                    if (!dashed) line.forEach((q, i) => { if (i % 2 === 0) items.push({ kind: 'seg', key, seg: q.seg, u: q.u, sx: q.x, sy: q.y, pn }); });
                }
                // the handle itself: between the crest and the lume (a lug: down to the wall)
                const inner = hole && !closed ? lines[pn.key] : null;
                ctx.fillStyle = 'rgba(37,99,235,0.13)';
                ctx.beginPath();
                lines.crest.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
                (inner || wall.filter(q => q[0] >= at(0, 0)[0] - 1 && q[0] <= at(1, 0)[0] + 1).map(q => ({ x: q[0], y: q[1] })))
                    .slice().reverse().forEach(q => ctx.lineTo(q.x, q.y));
                ctx.fill();
                // a closed hole: between its far and its near edge
                if (closed) {
                    ctx.fillStyle = '#ffffff';
                    ctx.beginPath();
                    lines[pn.key].forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
                    lines['n' + pn.key].slice().reverse().forEach(q => ctx.lineTo(q.x, q.y));
                    ctx.fill();
                    ctx.strokeStyle = '#d97706';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }
                // the nodes (a filled square on the selected one, with its handles)
                for (const [key, color] of list.filter(l => !l[2])) {
                    const nodes = nodesOf(key);
                    nodes.forEach((n, i) => {
                        const [nx, ny] = at(n.t, n.z);
                        const on = this.sel && this.sel.key === key && this.sel.i === i;
                        if (on) {
                            for (const side of ['hl', 'hr']) {
                                if (!n[side][0]) continue;
                                const [hx, hy] = at(n.t + n[side][0], n.z + n[side][1]);
                                ctx.strokeStyle = color;
                                ctx.lineWidth = 1;
                                ctx.beginPath();
                                ctx.moveTo(nx, ny);
                                ctx.lineTo(hx, hy);
                                ctx.stroke();
                                ctx.fillStyle = color;
                                ctx.beginPath();
                                ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
                                ctx.fill();
                                items.push({ kind: side, key, i, sx: hx, sy: hy, pn });
                            }
                        }
                        ctx.strokeStyle = color;
                        ctx.fillStyle = on ? color : '#ffffff';
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.rect(nx - 4, ny - 4, 8, 8);
                        ctx.fill();
                        ctx.stroke();
                        items.push({ kind: 'node', key, i, sx: nx, sy: ny, pn });
                    });
                }
                ctx.restore();
                ctx.fillStyle = '#475569';
                ctx.font = '11px sans-serif';
                ctx.fillText(!hole ? 'from above: the crest (blue)'
                    : pn.key === 'up' ? 'from above: the crest (blue) and the upper opening of the lume (orange)'
                        : 'from below: the crest (blue) and the lower opening of the lume (orange; dashed: the upper one)', 8, pn.y0 + 13);
                if (pn.key === 'up' && hp > 60) ctx.fillText(!hole ? 'for a hole: Hole through it, in the panel' : 'drag the nodes; click a curve: new node; double-click a node: remove it', 8, pn.y0 + 26);
                if (pn.key === 'low') { ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, pn.y0 + 0.5); ctx.lineTo(v.w, pn.y0 + 0.5); ctx.stroke(); }
            }
        }

        // A handle of a view: `fill` for the main ones (ends, shoulders), white for the others
        marker(ctx, x, y, fill) {
            ctx.strokeStyle = '#2563eb';
            ctx.fillStyle = fill ? '#2563eb' : '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // The section at the height of the slider, edited from above: its two shoulders (where the
        // rounded corners begin) and, at a height already edited, its points. The section as edited is
        // stored at the slider's height (spec.sections, see prospect-field.js).
        drawSectionEdit(ctx, v, sc, g) {
            const pf = sc.target.pf, spec = sc.target.spec, ax = this.pc.scene.axisX;
            const fr = pf.frame(g.ys + 0.5), rOut = pf.outerRho(g.ys + 0.5), mid = (g.lo + g.hi) / 2;
            const key = (spec.sections || []).find(k => Math.abs(k.t - this.slice) < KEY_TOL);
            const sec = key || FD().sectionTrack(spec)(this.slice);
            // s across the front outline, f depth below the face of the side view (units of fr.depth)
            const toScreen = (s, f) => {
                const x = fr.cx + s * fr.hw, rr = rOut - f * fr.depth;
                return [v.w / 2 + (x - ax - rr * g.sT) / g.cT * g.scale, v.h / 2 + (rr - mid) * g.scale];
            };
            const fromScreen = (px, py) => {
                const u = (px - v.w / 2) / g.scale, rr = (py - v.h / 2) / g.scale + mid;
                return { s: (ax + u * g.cT + rr * g.sT - fr.cx) / fr.hw, f: (rOut - rr) / fr.depth };
            };
            const markers = [{ kind: 'sl', p: toScreen(sec.sl, sec.fl) }, { kind: 'sr', p: toScreen(sec.sr, sec.fr) }];
            if (key) key.pts.forEach((q, i) => markers.push({ kind: 'pt', i, p: toScreen(q.s, q.f) }));
            for (const m of markers) this.marker(ctx, m.p[0], m.p[1], m.kind !== 'pt');
            this.secMap = { markers: markers.map(m => ({ kind: m.kind, i: m.i, sx: m.p[0], sy: m.p[1] })), fromScreen, spec };
        }

        // The side view the 3D is made from (drawn, with its ends moved) over the mesh, with handles on its ends
        drawSideEdit(ctx, cam, target) {
            const pf = target.pf, part = pf.part;
            this.sideMap = null;
            if (pf.axis !== 'y' || !part) return;
            const ax = this.pc.scene.axisX;
            const sT = Math.sin(pf.theta), cT = Math.cos(pf.theta);
            const all = part.rings.flat();
            const sgn = all.reduce((a, p) => a + p.x, 0) / all.length < ax ? -1 : 1;
            const toScreen = p => { const r = sgn * (p.x - ax); return cam.project(ax + r * sT, p.y, r * cT); };
            ctx.strokeStyle = 'rgba(37, 99, 235, 0.85)';
            ctx.lineWidth = 1.2;
            for (const ring of part.rings) {
                ctx.beginPath();
                G().edgeLine(ring).map(toScreen).forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
                if (!ring.open) ctx.closePath();
                ctx.stroke();
            }
            const markers = [
                { kind: 'top', p: toScreen(all.reduce((m, q) => (q.y < m.y ? q : m))) },
                { kind: 'bottom', p: toScreen(all.reduce((m, q) => (q.y > m.y ? q : m))) }
            ];
            for (const m of markers) this.marker(ctx, m.p[0], m.p[1], true);
            // screen px per px of the drawing, and the screen direction of "down"
            const o = cam.project(ax, 0, 0), dn = cam.project(ax, 100, 0);
            const scale = Math.hypot(dn[0] - o[0], dn[1] - o[1]) / 100;
            const unit = q => { const l = Math.hypot(q[0] - o[0], q[1] - o[1]) || 1; return [(q[0] - o[0]) / l, (q[1] - o[1]) / l]; };
            this.sideMap = {
                cam, scale, down: unit(dn), spec: target.spec,
                markers: markers.map(m => ({ kind: m.kind, sx: m.p[0], sy: m.p[1] }))
            };
        }

        // ------------------------------------------------------------------
        // Interaction
        // ------------------------------------------------------------------

        // Position of a pointer event in the pixels of a view's canvas
        canvasPos(c, e) {
            const r = c.getBoundingClientRect();
            return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height };
        }

        // Is this tap the second of a double tap (same place, quickly)? Works for mouse, touch and pen alike
        doubleTap(c, p) {
            const now = performance.now(), last = this.lastTap;
            this.lastTap = { c, x: p.x, y: p.y, at: now };
            if (last && last.c === c && now - last.at < DOUBLE_TAP_MS && Math.hypot(last.x - p.x, last.y - p.y) < 12) {
                this.lastTap = null;
                return true;
            }
            return false;
        }

        // An edit of the handle the views are about, from a button: `fn(spec)` returns whether it changed
        editSpec(fn) {
            const spec = this.target && this.target.spec;
            if (!spec || !fn(spec)) return;
            this.pc.refitBand(spec);
            this.finishEdit(true);
        }

        // The end of an edit of the section or of the side view: the drawing and the mesh catch up
        finishEdit(changed) {
            this.editing = false;
            if (changed) {
                this.pc.recomputeShading();
                this.pc.redraw();
                this.pc.pushHistory();
                this.pc.updateUI();
            }
            this.invalidate();
        }

        // The section edited at the slider's height, made from the one there if there was none
        sectionKey(spec) {
            const t = this.slice;
            spec.sections = spec.sections || [];
            let key = spec.sections.find(k => Math.abs(k.t - t) < KEY_TOL);
            if (key) return key;
            const sec = FD().sectionTrack(spec)(t);
            // the points of the nearest edited height, where the face is now
            const nearest = spec.sections.slice().sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
            const pts = nearest ? nearest.pts.filter(p => p.s > sec.sl && p.s < sec.sr).map(p => ({ s: p.s, f: FD().faceDepth(sec, p.s, 1, 1) })) : [];
            key = { t, sl: sec.sl, sr: sec.sr, fl: sec.fl, fr: sec.fr, pts };
            spec.sections.push(key);
            return key;
        }

        // A handle of the section follows the pointer (s across, f in depth)
        dragSection(d, q) {
            const k = d.key, r3 = v => Math.round(v * 1000) / 1000;
            const f = r3(clamp(q.f, 0, 0.95));
            if (d.what === 'pt') {
                const p = k.pts[d.i];
                p.s = r3(clamp(q.s, k.sl + 0.02, k.sr - 0.02));
                p.f = f;
                return;
            }
            // the shoulders: -1..0 on the left, 0..1 on the right (together when symmetric)
            if (d.what === 'shoulder') d.what = q.s < 0 ? 'sl' : 'sr';
            const left = d.what === 'sl', s = r3(left ? clamp(q.s, -1, 0) : clamp(q.s, 0, 1));
            if (left || this.symmetric) { k.sl = left ? s : -s; k.fl = f; }
            if (!left || this.symmetric) { k.sr = left ? -s : s; k.fr = f; }
            k.pts = k.pts.filter(p => p.s > k.sl && p.s < k.sr);
        }

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

        // A tap on the section of a vertical handle: a handle is dragged; a double tap adds a point to the
        // face there, or removes the point tapped. Returns whether the tap was for the section.
        sectionDown(c, e) {
            const m = this.secMap, p = this.canvasPos(c, e);
            const hit = m.markers.find(q => Math.hypot(q.sx - p.x, q.sy - p.y) <= PICK_PX);
            if (hit && hit.kind === 'lean') {
                c.setPointerCapture(e.pointerId);
                this.drag = { kind: 'lean', spec: m.spec, moved: false };
                this.editing = true;
                return true;
            }
            if (this.doubleTap(c, p)) {
                if (m.locked) return true;
                const key = this.sectionKey(m.spec);
                if (hit && hit.kind === 'pt') key.pts.splice(hit.i, 1);
                else {
                    const q = m.fromScreen(p.x, p.y);
                    if (q.s <= key.sl || q.s >= key.sr || q.f < -0.3) return true;
                    key.pts.push({ s: 0, f: 0 });
                    this.dragSection({ key, what: 'pt', i: key.pts.length - 1 }, q);
                }
                this.finishEdit(true);
                return true;
            }
            if (!hit) return false;
            c.setPointerCapture(e.pointerId);
            // (the height gets its own section at the first move, not at a tap; two shoulders on top of
            // each other, a fully round face, part the way the pointer goes)
            const both = m.markers.filter(q => q.kind !== 'pt' && Math.hypot(q.sx - p.x, q.sy - p.y) <= PICK_PX).length > 1;
            this.drag = { kind: 'section', spec: m.spec, key: null, what: both ? 'shoulder' : hit.kind, i: hit.i, moved: false };
            this.editing = true;
            return true;
        }

        // The handles of the section follow the pointer (either canvas); true if a section was being dragged
        sectionMove(c, e) {
            if (!this.drag || (this.drag.kind !== 'section' && this.drag.kind !== 'lean')) return false;
            const p = this.canvasPos(c, e);
            if (this.drag.kind === 'lean') {
                this.drag.spec.lean = this.secMap.leanAt(p.x, p.y);
                this.drag.moved = true;
                // the drawing follows while the strap is dragged (half resolution, as for the crest points)
                this.pc.recomputeShading(2);
                this.pc.redraw();
                this.invalidate();
                return true;
            }
            if (!this.drag.key) this.drag.key = this.sectionKey(this.drag.spec);
            this.dragSection(this.drag, this.secMap.fromScreen(p.x, p.y));
            this.drag.moved = true;
            this.invalidate();
            return true;
        }

        sectionEnd() {
            if (!this.drag || (this.drag.kind !== 'section' && this.drag.kind !== 'lean')) return false;
            const moved = this.drag.moved;
            this.drag = null;
            this.finishEdit(moved);
            return true;
        }

        // The ends of the side view follow the pointer up or down
        setupSide() {
            const c = this.views.side.canvas;
            c.style.touchAction = 'none';
            c.addEventListener('pointerdown', e => {
                if (this.secMap && this.secMap.view === 'side' && this.sectionDown(c, e)) return;
                const m = this.sideMap;
                if (!m) return;
                const p = this.canvasPos(c, e);
                const hit = m.markers.find(q => Math.hypot(q.sx - p.x, q.sy - p.y) <= PICK_PX);
                if (!hit) return;
                c.setPointerCapture(e.pointerId);
                const spec = m.spec;
                this.drag = {
                    kind: 'side', what: hit.kind, x: p.x, y: p.y, cam: m.cam, map: m, spec, moved: false,
                    edit: Object.assign({ dy0: 0, dy1: 0 }, spec.sideEdit)
                };
                this.editing = true;
            });
            c.addEventListener('pointermove', e => {
                if (this.sectionMove(c, e)) return;
                const d = this.drag;
                if (!d || d.kind !== 'side') return;
                const p = this.canvasPos(c, e), m = d.map, dx = p.x - d.x, dy = p.y - d.y;
                // px of the drawing, down
                const down = (dx * m.down[0] + dy * m.down[1]) / m.scale;
                const r1 = v => Math.round(v * 10) / 10;
                const ed = Object.assign({}, d.edit);
                if (d.what === 'top') ed.dy0 = r1(ed.dy0 + down);
                else ed.dy1 = r1(ed.dy1 + down);
                d.spec.sideEdit = ed;
                this.pc.refitBand(d.spec);
                d.moved = true;
                this.invalidate();
            });
            const end = () => {
                if (this.sectionEnd()) return;
                const d = this.drag;
                if (!d || d.kind !== 'side') return;
                this.drag = null;
                this.finishEdit(d.moved);
            };
            c.addEventListener('pointerup', end);
            c.addEventListener('pointercancel', end);
        }

        // The Bezier curves of the two 2D views of a horizontal part (crest, upper and lower opening of the lume)
        setupTop() {
            const c = this.views.top.canvas;
            c.style.touchAction = 'none';
            const pos = e => this.canvasPos(c, e);
            const r1 = v => Math.round(v * 10) / 10;
            // (t along the length, dz above the wall) of a point of a panel
            const toPlan = (p, pn, m) => {
                const x = (p.x - this.views.top.w / 2) / pn.scale + m.mx, z = pn.flip * (p.y - pn.y0 - pn.h / 2 - 6) / pn.scale + m.mz;
                return { t: (x - m.xmin) / m.len, dz: Math.hypot(x - m.ax, z) - m.rw };
            };
            // the handles of a node stay within its neighbours, so the curve stays a function of the length
            const fit = (nodes, i) => {
                const n = nodes[i], prev = nodes[i - 1], next = nodes[i + 1];
                if (prev) { const room = n.t - prev.t; if (-n.hl[0] > room) { const k = room / -n.hl[0]; n.hl = [n.hl[0] * k, n.hl[1] * k]; } }
                else n.hl = [0, 0];
                if (next) { const room = next.t - n.t; if (n.hr[0] > room) { const k = room / n.hr[0]; n.hr = [n.hr[0] * k, n.hr[1] * k]; } }
                else n.hr = [0, 0];
            };
            const change = (fast) => {
                const m = this.topMap;
                FD().syncBez(m.spec);
                if (m.spec.under && m.spec.lumeShape !== 'hole') m.spec.lumeShape = 'custom';
                this.pc.recomputeShading(fast ? 2 : undefined);
                this.pc.redraw();
                this.invalidate();
            };
            const done = () => { this.pc.recomputeShading(); this.pc.redraw(); this.pc.pushHistory(); this.pc.updateUI(); this.invalidate(); };
            c.addEventListener('pointerdown', e => {
                if (this.secMap && this.secMap.view !== 'side' && this.sectionDown(c, e)) return;
                const m = this.topMap;
                if (!m || !m.items) return;
                const p = pos(e), d = q => Math.hypot(q.sx - p.x, q.sy - p.y);
                const first = kind => m.items.filter(q => kind.includes(q.kind) && d(q) <= PICK_PX).sort((a, b) => d(a) - d(b))[0];
                const hit = first(['hl', 'hr']) || first(['node']);
                if (hit) {
                    c.setPointerCapture(e.pointerId);
                    const bz = FD().bezEnsure(m.spec, m.pf);
                    const nodes = bz[hit.key];
                    if (hit.kind === 'node' && this.doubleTap(c, p)) {
                        if (nodes.length > 2 && hit.i > 0 && hit.i < nodes.length - 1) {
                            nodes.splice(hit.i, 1);
                            fit(nodes, hit.i - 1); fit(nodes, hit.i);
                            this.sel = null;
                            change(false);
                            done();
                        }
                        return;
                    }
                    this.sel = { id: m.spec.id, key: hit.key, i: hit.i };
                    this.drag = { kind: 'bez', what: hit.kind, key: hit.key, i: hit.i, pn: hit.pn, moved: false };
                    this.invalidate();
                    return;
                }
                // on a curve: a new node there (the curve keeps its shape), which follows the pointer
                const on = first(['seg']);
                if (!on) { if (this.sel) { this.sel = null; this.invalidate(); } return; }
                c.setPointerCapture(e.pointerId);
                const nodes = FD().bezEnsure(m.spec, m.pf)[on.key];
                const a = nodes[on.seg], z = nodes[on.seg + 1], u = on.u;
                const P = [[a.t, a.z], [a.t + a.hr[0], a.z + a.hr[1]], [z.t + z.hl[0], z.z + z.hl[1]], [z.t, z.z]];
                const mid = (A, B) => [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u];
                const Q = [mid(P[0], P[1]), mid(P[1], P[2]), mid(P[2], P[3])], R = [mid(Q[0], Q[1]), mid(Q[1], Q[2])], S = mid(R[0], R[1]);
                const node = { t: Math.round(S[0] * 1e4) / 1e4, z: r1(S[1]), hl: [R[0][0] - S[0], R[0][1] - S[1]], hr: [R[1][0] - S[0], R[1][1] - S[1]] };
                a.hr = [Q[0][0] - P[0][0], Q[0][1] - P[0][1]];
                z.hl = [Q[2][0] - P[3][0], Q[2][1] - P[3][1]];
                nodes.splice(on.seg + 1, 0, node);
                this.sel = { id: m.spec.id, key: on.key, i: on.seg + 1 };
                this.drag = { kind: 'bez', what: 'node', key: on.key, i: on.seg + 1, pn: on.pn, moved: true };
                change(true);
            });
            c.addEventListener('pointermove', e => {
                if (this.sectionMove(c, e)) return;
                const dr = this.drag, m = this.topMap;
                if (!dr || dr.kind !== 'bez' || !m) return;
                const nodes = m.spec.bez[dr.key], n = nodes[dr.i], q = toPlan(pos(e), dr.pn, m);
                if (dr.what === 'node') {
                    n.z = Math.max(0, r1(q.dz));
                    const last = nodes.length - 1, tip = dr.key !== 'crest' && m.pf.underNearPlan.length > 0 && (dr.i === 0 || dr.i === last);
                    if (dr.i > 0 && dr.i < last) n.t = Math.round(Math.min(nodes[dr.i + 1].t - 0.03, Math.max(nodes[dr.i - 1].t + 0.03, q.t)) * 1e4) / 1e4;
                    // (the tips of a closed hole move along the length, and its two edges meet there)
                    else if (tip) {
                        n.t = Math.round((dr.i === 0 ? Math.min(nodes[1].t - 0.03, Math.max(0, q.t)) : Math.max(nodes[last - 1].t + 0.03, Math.min(1, q.t))) * 1e4) / 1e4;
                        const pair = m.spec.bez[{ up: 'nup', nup: 'up', low: 'nlow', nlow: 'low' }[dr.key]], o = pair[dr.i === 0 ? 0 : pair.length - 1];
                        o.t = n.t; o.z = n.z;
                        fit(pair, dr.i === 0 ? 0 : pair.length - 1);
                    }
                    fit(nodes, dr.i - 1 >= 0 ? dr.i - 1 : 0); fit(nodes, dr.i); if (dr.i + 1 < nodes.length) fit(nodes, dr.i + 1);
                } else {
                    const side = dr.what, other = side === 'hr' ? 'hl' : 'hr', sg = side === 'hr' ? 1 : -1;
                    const dt = Math.max(0, sg * (q.t - n.t)) * sg, dz = r1(q.dz - n.z);
                    const len2 = Math.hypot(n[other][0], n[other][1]), len1 = Math.hypot(dt, dz);
                    n[side] = [dt, dz];
                    // (aligned: the other handle goes the opposite way, as long as it was)
                    if (len1 > 1e-6 && len2 > 1e-6) n[other] = [-dt / len1 * len2, -dz / len1 * len2];
                    fit(nodes, dr.i);
                }
                dr.moved = true;
                change(true);
            });
            const end = () => {
                if (this.sectionEnd()) return;
                if (this.drag && this.drag.kind === 'bez') {
                    const moved = this.drag.moved;
                    this.drag = null;
                    if (moved) done();
                }
            };
            c.addEventListener('pointerup', end);
            c.addEventListener('pointercancel', end);

            // the slider moves the whole handle out of the wall or into it: the crest and the lume together (what stands on the wall stays)
            const shift = document.getElementById('prospect-plan-shift');
            if (shift) {
                let last = 0;
                shift.addEventListener('input', () => {
                    const m = this.topMap;
                    if (!m) return;
                    const v = parseFloat(shift.value), delta = v - last;
                    last = v;
                    const bz = FD().bezEnsure(m.spec, m.pf);
                    for (const key of Object.keys(bz)) for (const n of bz[key]) if (n.z > 0.05) n.z = Math.max(0.1, r1(n.z + delta));
                    change(true);
                });
                shift.addEventListener('change', () => { last = 0; shift.value = 0; done(); });
            }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        // after the canvas controller (both listen to DOMContentLoaded, this file is loaded later)
        if (window.prospectCanvas) window.prospect3d = new Prospect3D(window.prospectCanvas);
    });
})();
