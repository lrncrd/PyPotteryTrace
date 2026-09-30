// Prospect Canvas - one surface for the vessel and its applied parts (handles, lugs)
//
// The vessel and every applied part are signed distance fields (negative inside, in px of the
// drawing), and the surface of the whole is their smooth union: where a handle meets the wall the
// two are not two solids side by side, the wall rises into the handle and the handle spreads on the
// wall (a fillet whose size is the "blend"). Everything that is seen comes from this one surface:
// the shading of the front view (the field is ray-marched along the view of the drawing, its
// gradient is the normal) and the quad mesh of the 3D views (surface nets on the same field).
//
// World frame = the drawing: x right, y down (image rows), z towards the viewer of the front view;
// the axis of the vessel is x = axisX, z = 0.
//
// A part is the intersection of two extrusions, one for each view the drawing gives of it, so that
// both drawings rule:
//   vertical handle (axis y): the front polygon extruded along the view (z), and the side view
//     (Handle layer: outer contour, hole = the lume, closed against the wall) extruded across, at the
//     azimuth theta of the handle. The thickness and the lume are those of the side view.
//   horizontal handle / lug (axis x): the front polygon, and the band between two offsets of the wall,
//     dz(t) and dz(t) - b, where dz(t) is the crest along the length (the top view edits it). A lug has
//     no lume: it is solid down to the wall (no lower offset).
// The edges of the section are rounded ("roundness") with the rounded intersection of the two.

(function () {
    const G = () => window.ProspectGeometry;
    const S = () => window.ProspectShading;

    const MAX_SIN = 0.97;
    const BLEND_SCALE = 1.4;      // the smooth union spreads over blend * BLEND_SCALE * (mean width) px
    const WALL_DEPTH = 64;        // how far into the wall the side view of a handle is continued (px): more than the rounding of its corners
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

    // ------------------------------------------------------------------
    // Distance helpers
    // ------------------------------------------------------------------

    // Smooth minimum (cubic): the union of two fields with a fillet of size k
    function smin(a, b, k) {
        if (k <= 1e-6) return Math.min(a, b);
        const h = Math.max(k - Math.abs(a - b), 0) / k;
        return Math.min(a, b) - h * h * h * k / 6;
    }

    // Share of b (the part) in the union: 0 = all a (the vessel), 1 = all b
    function share(a, b, k) {
        if (k <= 1e-6) return b < a ? 1 : 0;
        return clamp(0.5 + 0.5 * (a - b) / k, 0, 1);
    }

    // The fillet fades out beyond the outline traced on the drawing (the drawing rules): full inside,
    // gone at 0.3 k px outside
    function taper(k, s) {
        if (s <= 0) return k;
        const t = Math.min(1, s / (0.3 * k));
        return k * (1 - t * t * (3 - 2 * t));
    }

    // How far the side of a section recedes at depth t below a face, for elliptic corners Ru across
    // and Rt deep (Ru = Rt: a circle; Ru = the half width: the whole face is curved, a pillow)
    function recess(t, Ru, Rt) {
        if (t >= Rt) return 0;
        if (t <= 0) return Ru;
        const u = (Rt - t) / Rt;
        return Ru * (1 - Math.sqrt(Math.max(1e-6, 1 - u * u)));
    }

    // A field sampled on a pixel grid, bilinear; beyond the grid the distance to it is added
    // (one sample every `s` px of the drawing, the values in px)
    class Grid {
        constructor(x0, y0, w, h, data, s = 1) {
            this.x0 = x0; this.y0 = y0; this.w = w; this.h = h; this.data = data; this.s = s;
        }

        at(x, y) {
            const mx = this.w - 1, my = this.h - 1, s = this.s;
            let fx = (x - this.x0) / s - 0.5, fy = (y - this.y0) / s - 0.5, ox = 0, oy = 0;
            if (fx < 0) { ox = -fx; fx = 0; } else if (fx > mx) { ox = fx - mx; fx = mx; }
            if (fy < 0) { oy = -fy; fy = 0; } else if (fy > my) { oy = fy - my; fy = my; }
            const i = Math.min(mx - 1, Math.floor(fx)), j = Math.min(my - 1, Math.floor(fy));
            const tx = fx - i, ty = fy - j, d = this.data, w = this.w;
            const k = j * w + i;
            const v = (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - ty) + (d[k + w] * (1 - tx) + d[k + w + 1] * tx) * ty;
            return ox || oy ? v + Math.hypot(ox, oy) * s : v;
        }
    }

    // Alpha channel of what `draw(ctx)` paints on a w x h canvas
    function alphaOf(w, h, draw) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        draw(ctx);
        const d = ctx.getImageData(0, 0, w, h).data;
        const a = new Uint8Array(w * h);
        for (let k = 0; k < w * h; k++) a[k] = d[4 * k + 3];
        return a;
    }

    // Signed distance (negative inside) to the edge pixels, smoothed: the raster edge is quantized
    // and its gradient would streak the shading
    function signedDistance(inside, edge, w, h, blur) {
        const free = new Uint8Array(w * h);
        for (let k = 0; k < w * h; k++) free[k] = edge[k] > 40 ? 0 : 1;
        const d = G().distanceTransform(free, w, h);
        const s = new Float64Array(w * h);
        for (let k = 0; k < w * h; k++) s[k] = inside[k] ? -d[k] : d[k];
        return Float32Array.from(S().boxBlur(S().boxBlur(s, w, h, blur), w, h, blur));
    }

    // ------------------------------------------------------------------
    // The vessel
    // ------------------------------------------------------------------

    // Surface of revolution r(y) around the axis; ends closed at the first and last row of the profile
    function vesselField(scene) {
        const R = scene.radius, ax = scene.axisX, rad = R.radius, dr = R.dr, H = rad.length;
        const y0 = R.y0, y1 = R.y1;
        const rows = y => {
            const f = clamp(y - 0.5, 0, H - 1), i = Math.floor(f), t = f - i, i1 = Math.min(H - 1, i + 1);
            return [rad[i] * (1 - t) + rad[i1] * t, dr[i] * (1 - t) + dr[i1] * t];
        };
        return {
            ax, y0, y1, H,
            radiusAt: y => rows(y)[0],
            slopeAt: y => rows(y)[1],
            sd(x, y, z) {
                const dx = x - ax, rho = Math.sqrt(dx * dx + z * z);
                const [r, d] = rows(y);
                return Math.max((rho - r) / Math.sqrt(1 + d * d), y0 - y, y - y1);
            }
        };
    }

    // Depth of the wall of the vessel behind the image point (x, y)
    function wallZ(scene, x, y) {
        const rad = scene.radius.radius;
        const f = clamp(y - 0.5, 0, rad.length - 1), i = Math.floor(f), t = f - i;
        const r = rad[i] * (1 - t) + rad[Math.min(rad.length - 1, i + 1)] * t;
        const dx = x - scene.axisX;
        return Math.sqrt(Math.max(0, r * r - dx * dx));
    }

    // ------------------------------------------------------------------
    // Crest of a horizontal part
    // ------------------------------------------------------------------

    const smoothstep = t => t * t * (3 - 2 * t);

    // Height above the wall of the crest of a horizontal handle, along its length (t in [0, 1]):
    // control points [{ t, dz }] (the top view edits them), smooth between them
    function planAt(plan, t) {
        const pts = plan.slice().sort((p, q) => p.t - q.t);
        if (t <= pts[0].t) return pts[0].dz;
        if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].dz;
        for (let i = 1; i < pts.length; i++) {
            if (t <= pts[i].t) {
                const u = (t - pts[i - 1].t) / Math.max(1e-6, pts[i].t - pts[i - 1].t);
                // Catmull-Rom through the points
                const p0 = pts[Math.max(0, i - 2)].dz, p1 = pts[i - 1].dz, p2 = pts[i].dz, p3 = pts[Math.min(pts.length - 1, i + 1)].dz;
                return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
            }
        }
        return pts[pts.length - 1].dz;
    }

    // A first plan: an ellipse whose crest stands out by `protrusion` px
    function defaultPlan(protrusion) {
        return [0, 0.25, 0.5, 0.75, 1].map(t => ({ t, dz: Math.round(protrusion * Math.sqrt(Math.max(0, 1 - (2 * t - 1) * (2 * t - 1))) * 10) / 10 }));
    }

    // A curve along the length of a horizontal handle as Bezier nodes, like the curves of Blender: [{ t, z, hl, hr }]
    // (t along the length, z the height above the wall; hl and hr the handles, as offsets [dt, dz] from the
    // node, within the neighbouring nodes so the curve stays a function of t). bezFromPlan fits one to a plan,
    // bezSample gives the plan back (dense points)
    function bezFromPlan(plan, n = 9) {
        const srt = plan.slice().sort((a, b) => a.t - b.t);
        const ts = srt.length <= n ? srt.map(p => p.t) : Array.from({ length: n }, (_, i) => srt[Math.round(i * (srt.length - 1) / (n - 1))].t);
        const h = 0.03, r1 = v => Math.round(v * 10) / 10;
        return ts.map((t, i) => {
            const a = Math.max(0, t - h), b = Math.min(1, t + h), slope = (planAt(plan, b) - planAt(plan, a)) / (b - a);
            const l = i > 0 ? (t - ts[i - 1]) / 3 : 0, r = i < ts.length - 1 ? (ts[i + 1] - t) / 3 : 0;
            return { t, z: r1(planAt(plan, t)), hl: [-l, r1(-slope * l)], hr: [r, r1(slope * r)] };
        });
    }

    function bezSample(nodes) {
        const out = [];
        const push = (t, z) => {
            if (!out.length || t > out[out.length - 1].t + 1e-4) out.push({ t: Math.round(t * 1e4) / 1e4, dz: Math.max(0, Math.round(z * 100) / 100) });
        };
        for (let i = 0; i < nodes.length - 1; i++) {
            const a = nodes[i], b = nodes[i + 1];
            const t0 = a.t, t1 = a.t + a.hr[0], t2 = b.t + b.hl[0], t3 = b.t;
            const z0 = a.z, z1 = a.z + a.hr[1], z2 = b.z + b.hl[1], z3 = b.z;
            for (let k = 0; k < 12; k++) {
                const u = k / 12, v = 1 - u;
                push(v * v * v * t0 + 3 * v * v * u * t1 + 3 * v * u * u * t2 + u * u * u * t3,
                    v * v * v * z0 + 3 * v * v * u * z1 + 3 * v * u * u * z2 + u * u * u * z3);
            }
        }
        const e = nodes[nodes.length - 1];
        push(e.t, e.z);
        return out;
    }

    // spec.bez = { crest, up, low }: the crest, and the lume where it opens on the upper and on the lower side
    // (nodes); the plans the field works with (spec.plan, spec.under, spec.underLow) are sampled from them
    function syncBez(spec) {
        const b = spec.bez;
        if (!b) return;
        if (b.crest) spec.plan = bezSample(b.crest);
        if (b.up && b.low) { spec.under = bezSample(b.up); spec.underLow = bezSample(b.low); }
        if (b.nup && b.nlow) { spec.underNear = bezSample(b.nup); spec.underNearLow = bezSample(b.nlow); }
    }

    // The Bezier curves of a part (from its plans the first time)
    function bezEnsure(spec, pf) {
        const b = spec.bez = spec.bez || {};
        if (!b.crest) b.crest = bezFromPlan(pf.plan);
        if (pf.underPlan.length && !(b.up && b.low)) {
            b.up = !spec.under && pf.circleNodes ? JSON.parse(JSON.stringify(pf.circleNodes.far)) : bezFromPlan(pf.underPlan);
            b.low = JSON.parse(JSON.stringify(b.up));
        }
        // (a closed hole has its near edge too: the hole is between the two)
        if (pf.underNearPlan.length && !(b.nup && b.nlow)) {
            b.nup = !spec.underNear && pf.circleNodes ? JSON.parse(JSON.stringify(pf.circleNodes.near)) : bezFromPlan(pf.underNearPlan);
            b.nlow = JSON.parse(JSON.stringify(b.nup));
        }
        syncBez(spec);
        return b;
    }

    // Shapes of a horizontal handle seen from above (its crest, and its lume inside it): the height (0..1)
    // across its length, u from -1 to 1
    const LUME_SHAPES = {
        arch: u => Math.sqrt(Math.max(0, 1 - u * u)),
        flat: u => Math.pow(Math.max(0, 1 - u ** 4), 0.25),
        // a pointed arch: two arcs of radius 1.6 meeting in the middle
        pointed: u => Math.sqrt(Math.max(0, 2.56 - (Math.abs(u) + 0.6) ** 2)) / Math.sqrt(2.2)
    };

    // A curve of that shape `h` px high, between a and 1 - a along the length (0 outside: the arms)
    function shapePlan(shape, h, a = 0) {
        const g = LUME_SHAPES[shape] || LUME_SHAPES.arch;
        const ts = Array.from({ length: 9 }, (_, i) => a + (1 - 2 * a) * i / 8);
        if (a > 0) { ts.unshift(0); ts.push(1); }
        return ts.map(t => ({ t: Math.round(t * 1000) / 1000, dz: Math.round(h * g(clamp((2 * t - 1) / (1 - 2 * a), -1, 1)) * 10) / 10 }));
    }

    // The fillet of a part only where it stands on the wall: full there, gone `k` px away from it (the lume
    // is not filled in). `attached` per row or column; the fillet size of each.
    function attachK(attached, k) {
        const n = attached.length, d = new Float32Array(n).fill(Infinity);
        for (let i = 0, last = -Infinity; i < n; i++) { if (attached[i]) last = i; d[i] = i - last; }
        for (let i = n - 1, last = Infinity; i >= 0; i--) { if (attached[i]) last = i; d[i] = Math.min(d[i], last - i); }
        return Float32Array.from(d, v => k * (1 - smoothstep(Math.min(1, v / Math.max(1e-6, k)))));
    }

    // What the section drawn next to the profile says of a horizontal handle or a lug: its extent in y, how
    // far its crest stands out of the wall and how far from the wall the strap begins (the lume: 0 when it is
    // on the wall), px
    function drawnSection(part, scene) {
        const ax = scene.axisX, rad = scene.radius.radius, H = rad.length, rings = part.rings;
        const sgn = rings[0].reduce((s, p) => s + p.x, 0) / rings[0].length < ax ? -1 : 1;
        const dvAt = (x, y) => sgn * (x - ax) - rad[clamp(Math.round(y), 0, H - 1)];
        const b = G().bbox(rings[0]);
        let crest = 0, under = Infinity, hole = 0, onWall = 0, nWall = 0, upper = Infinity, lower = Infinity;
        const ym = (b.y0 + b.y1) / 2;
        for (let y = Math.ceil(b.y0) + 0.5; y < b.y1; y++) {
            for (const [xa, xb] of G().horizontalSpans(y, rings[0])) {
                const da = dvAt(xa, y), db = dvAt(xb, y);
                crest = Math.max(crest, da, db);
                under = Math.min(under, da, db);
                if (y < ym) upper = Math.min(upper, da, db); else lower = Math.min(lower, da, db);
                if (Math.min(da, db) < 3) { onWall += y; nWall++; }
            }
            for (const ring of rings.slice(1)) {
                for (const [xa, xb] of G().horizontalSpans(y, ring)) hole = Math.max(hole, dvAt(xa, y), dvAt(xb, y));
            }
        }
        if (!(crest > 0)) return null;
        // (ya: the middle of where it stands on the wall)
        // (under: the gap between the strap and the wall; above and below, in the upper and the lower half)
        const gap = v => Math.max(0, hole, v === Infinity ? 0 : v);
        return { y0: b.y0, y1: b.y1, ya: nWall ? onWall / nWall : ym, crest, under: gap(under), above: gap(upper), below: gap(lower) };
    }

    // ------------------------------------------------------------------
    // Applied parts
    // ------------------------------------------------------------------

    // rho_out(y) of a part (side view), per image row
    function outerProfile(part, axisX, height) {
        return G().radiusByRow([G().edgeLine(part.outline)], axisX, height, false);
    }

    // Raster of the front polygon: inside test and signed distance
    // (a large polygon on one sample every few px: at most MAX_GRID samples)
    const MAX_GRID = 250000;

    function polygonGrid(poly, bb) {
        const x0 = Math.floor(bb.x0) - 12, y0 = Math.floor(bb.y0) - 12;
        const W = Math.ceil(bb.x1) - x0 + 13, H = Math.ceil(bb.y1) - y0 + 13;
        const s = Math.max(1, Math.ceil(Math.sqrt(W * H / MAX_GRID)));
        const w = Math.ceil(W / s), h = Math.ceil(H / s);
        const path = ctx => {
            ctx.beginPath();
            poly.forEach((p, i) => (i ? ctx.lineTo((p.x - x0) / s, (p.y - y0) / s) : ctx.moveTo((p.x - x0) / s, (p.y - y0) / s)));
            ctx.closePath();
        };
        const fill = alphaOf(w, h, ctx => { path(ctx); ctx.fillStyle = '#000'; ctx.fill(); });
        const edge = alphaOf(w, h, ctx => { path(ctx); ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke(); });
        const inside = new Uint8Array(w * h);
        for (let k = 0; k < w * h; k++) inside[k] = fill[k] > 127 ? 1 : 0;
        const sd = signedDistance(inside, edge, w, h, 2);
        if (s > 1) for (let k = 0; k < sd.length; k++) sd[k] *= s;
        return {
            grid: new Grid(x0, y0, w, h, sd, s),
            isInside(px, py) {
                const i = Math.floor((px - x0) / s), j = Math.floor((py - y0) / s);
                return i >= 0 && j >= 0 && i < w && j < h && inside[j * w + i] === 1;
            }
        };
    }

    // The side view of a vertical handle as a field over (rho, y): rho the distance from the axis.
    // The figure is the outline minus the holes (the lume), continued into the wall by WALL_DEPTH px so
    // that the handle does not stop short of the vessel; the distance is to the drawn edges only (the
    // closing along the wall is not an edge).
    function sideGrid(part, wall, axisX, holeRows) {
        const rings = part.rings;
        const sgn = rings[0].reduce((s, p) => s + p.x, 0) / rings[0].length < axisX ? -1 : 1;
        const toRho = p => ({ x: sgn * (p.x - axisX), y: p.y });
        const H = wall.radius.length;
        const rAt = y => wall.radius[clamp(Math.round(y), 0, H - 1)];
        const fb = G().bbox(rings.flat().map(toRho));
        let rmin = Infinity;
        for (let y = Math.floor(fb.y0); y <= Math.ceil(fb.y1); y++) rmin = Math.min(rmin, rAt(y));
        const pad = 12;
        const x0 = Math.floor(Math.min(fb.x0, rmin - WALL_DEPTH)) - pad, y0 = Math.floor(fb.y0) - pad;
        const w = Math.ceil(fb.x1) + pad - x0, h = Math.ceil(fb.y1) + pad - y0;
        const fill = alphaOf(w, h, ctx => {
            ctx.beginPath();
            for (const ring of rings) {
                ring.forEach((p, i) => { const q = toRho(p); if (i) ctx.lineTo(q.x - x0, q.y - y0); else ctx.moveTo(q.x - x0, q.y - y0); });
                ctx.closePath();
            }
            ctx.fillStyle = '#000';
            ctx.fill('evenodd');
        });
        const inside = new Uint8Array(w * h);
        let rowA = h, rowB = -1;
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) if (fill[j * w + i] > 127) { inside[j * w + i] = 1; rowA = Math.min(rowA, j); rowB = Math.max(rowB, j); }
        }
        // The lume reaches the wall: a hole drawn a few px short of it does not leave a skin there
        if (rings.length > 1) {
            const holes = alphaOf(w, h, ctx => {
                ctx.beginPath();
                for (const ring of rings.slice(1)) {
                    ring.forEach((p, i) => { const q = toRho(p); if (i) ctx.lineTo(q.x - x0, q.y - y0); else ctx.moveTo(q.x - x0, q.y - y0); });
                    ctx.closePath();
                }
                ctx.fillStyle = '#000';
                ctx.fill();
            });
            for (let j = rowA; j <= rowB; j++) {
                let first = -1;
                for (let i = 0; i < w; i++) if (holes[j * w + i] > 127) { first = i; break; }
                if (first < 0) continue;
                const gap = x0 + first - rAt(y0 + j);
                if (gap > 0 && gap <= 10) for (let i = Math.max(0, Math.floor(rAt(y0 + j) - x0)); i < first; i++) inside[j * w + i] = 0;
            }
        }
        // The wall band, on the rows where the figure meets the wall (the arms of the handle), not
        // across the lume
        const band = new Uint8Array(h);
        for (let j = rowA; j <= rowB; j++) {
            if (holeRows(y0 + j)) continue;
            const r = rAt(y0 + j);
            for (let i = Math.max(0, Math.floor(r - x0) - 1); i <= Math.min(w - 1, Math.ceil(r + 3 - x0)); i++) {
                if (inside[j * w + i]) { band[j] = 1; break; }
            }
            if (!band[j]) continue;
            for (let i = 0; i < w; i++) {
                const rho = x0 + i + 0.5;
                if (rho >= r - WALL_DEPTH && rho <= r + 0.5) inside[j * w + i] = 1;
            }
        }
        // The drawn edges (`outer`: with the outer contour, else only the inner ones: the holes, and
        // the limit of the wall band)
        const drawEdges = (ctx, outer) => {
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 2;
            for (const ring of outer ? rings : rings.slice(1)) {
                ctx.beginPath();
                G().edgeLine(ring).forEach((p, i) => { const q = toRho(p); if (i) ctx.lineTo(q.x - x0, q.y - y0); else ctx.moveTo(q.x - x0, q.y - y0); });
                if (!ring.open) ctx.closePath();
                ctx.stroke();
            }
            // the inner limit of every stretch of the band, and its two ends
            for (let j = rowA; j <= rowB; j++) {
                if (!band[j]) continue;
                const xi = rAt(y0 + j) - WALL_DEPTH - x0;
                if (j === rowA || !band[j - 1]) {
                    ctx.beginPath();
                    ctx.moveTo(xi, j + 0.5);
                    ctx.lineTo(rAt(y0 + j) - x0, j + 0.5);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(xi, j + 0.5);
                } else {
                    ctx.lineTo(xi, j + 0.5);
                }
                if (j === rowB || !band[j + 1]) {
                    ctx.lineTo(xi, j + 0.5);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(xi, j + 0.5);
                    ctx.lineTo(rAt(y0 + j) - x0, j + 0.5);
                    ctx.stroke();
                }
            }
        };
        const edge = alphaOf(w, h, ctx => drawEdges(ctx, true));
        const edgeIn = alphaOf(w, h, ctx => drawEdges(ctx, false));
        const sd = signedDistance(inside, edge, w, h, 4);
        // The outer contour on every row (sub-pixel, from the smoothed distance: a pixel-quantized
        // contour would step the rounding of the corners)
        const hi = new Float32Array(h).fill(-1e9);
        for (let j = 0; j < h; j++) {
            let iHi = -1;
            for (let i = w - 2; i >= 0; i--) if (inside[j * w + i]) { iHi = i; break; }
            if (iHi < 0) continue;
            const a = sd[j * w + iHi], b = sd[j * w + iHi + 1];
            hi[j] = x0 + iHi + 0.5 + (a < 0 && b > a ? Math.min(1, -a / (b - a)) : 0.5);
        }
        const hiRaw = Float32Array.from(hi);
        for (let j = 0; j < h; j++) {
            if (hiRaw[j] < -1e8) continue;
            let acc = 0, n = 0;
            for (let k = Math.max(0, j - 4); k <= Math.min(h - 1, j + 4); k++) if (hiRaw[k] > -1e8) { acc += hiRaw[k]; n++; }
            hi[j] = acc / n;
        }
        // slope of the contour, d(hi)/dy: the radial depth is the distance to the contour times sqrt(1 + slope^2)
        const slope = new Float32Array(h);
        for (let j = 0; j < h; j++) {
            const a = Math.max(0, j - 5), b = Math.min(h - 1, j + 5);
            if (hi[a] > -1e8 && hi[b] > -1e8 && b > a) slope[j] = (hi[b] - hi[a]) / (b - a);
        }
        const grid = new Grid(x0, y0, w, h, sd);
        // distance to the inner edges only: rounds the inner corners of the section
        grid.inner = new Grid(x0, y0, w, h, signedDistance(new Uint8Array(w * h), edgeIn, w, h, 4));
        grid.rows = {
            y0, h, hi, slope,
            // linear in y; rows without figure give -1e9 (nothing there)
            at(arr, y) {
                const f = clamp(y - y0 - 0.5, 0, h - 1), i = Math.floor(f), t = f - i, i1 = Math.min(h - 1, i + 1);
                return arr[i] < -1e8 || arr[i1] < -1e8 ? arr[t < 0.5 ? i : i1] : arr[i] * (1 - t) + arr[i1] * t;
            }
        };
        return grid;
    }

    // ------------------------------------------------------------------
    // Section of a vertical handle (edited from above)
    // ------------------------------------------------------------------
    //
    // The outer face of the section across the strap: s from -1 (left edge of the front outline) to 1
    // (right edge), f the depth below the outer face of the side view, in units of the rounding depth
    // (half the thickness). Two shoulders (sl, fl) and (sr, fr) where the rounded corners begin (quarter
    // ellipses down to the edges) and, between them, points [{ s, f }] the face runs through smoothly (a
    // saddle, a groove). spec.sections [{ t, sl, sr, fl, fr, pts }] gives it at some heights t (0 = top
    // of the handle, 1 = bottom), blended in between; without them one section follows `roundness`.
    const SECTION_SAMPLES = 33;

    function defaultSection(spec) {
        const r = clamp('roundness' in spec ? spec.roundness : 1, 0.02, 1);
        return { t: 0, sl: -(1 - r), sr: 1 - r, fl: 0, fr: 0, pts: [] };
    }

    // The face between the shoulders on SECTION_SAMPLES samples: a monotone cubic through the shoulders
    // and the points, flat at the shoulders (where the corners start flat)
    function sectionMid(sec) {
        const out = new Float32Array(SECTION_SAMPLES);
        if (sec.sr - sec.sl < 1e-4) return out.fill(sec.fl);
        const xs = [sec.sl], ys = [sec.fl];
        for (const p of (sec.pts || []).slice().sort((a, b) => a.s - b.s)) {
            if (p.s > xs[xs.length - 1] + 1e-3 && p.s < sec.sr - 1e-3) { xs.push(p.s); ys.push(p.f); }
        }
        xs.push(sec.sr); ys.push(sec.fr);
        const n = xs.length, d = [], m = new Float64Array(n);
        for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
        for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 / (1 / d[i - 1] + 1 / d[i]);
        for (let k = 0, i = 0; k < SECTION_SAMPLES; k++) {
            const x = sec.sl + (sec.sr - sec.sl) * k / (SECTION_SAMPLES - 1);
            while (i < n - 2 && x > xs[i + 1]) i++;
            const h = xs[i + 1] - xs[i], u = clamp((x - xs[i]) / h, 0, 1), u2 = u * u, u3 = u2 * u;
            out[k] = (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] + (3 * u2 - 2 * u3) * ys[i + 1] + (u3 - u2) * h * m[i + 1];
        }
        return out;
    }

    // The sections of a handle as a function of the height t, each { sl, sr, fl, fr, mid }
    function sectionTrack(spec) {
        const keys = (spec.sections && spec.sections.length ? spec.sections : [defaultSection(spec)])
            .slice().sort((a, b) => a.t - b.t)
            .map(k => ({ t: k.t, sl: k.sl, sr: k.sr, fl: k.fl, fr: k.fr, mid: sectionMid(k) }));
        return t => {
            if (t <= keys[0].t) return keys[0];
            const last = keys[keys.length - 1];
            if (t >= last.t) return last;
            let i = 0;
            while (t > keys[i + 1].t) i++;
            const a = keys[i], b = keys[i + 1], w = smoothstep((t - a.t) / Math.max(1e-6, b.t - a.t));
            const mix = (p, q) => p * (1 - w) + q * w;
            return {
                t, sl: mix(a.sl, b.sl), sr: mix(a.sr, b.sr), fl: mix(a.fl, b.fl), fr: mix(a.fr, b.fr),
                mid: a.mid.map((v, k) => mix(v, b.mid[k]))
            };
        };
    }

    // Depth (units of the rounding depth) of the face at s; the corners end at the edges at depth ce
    function faceDepth(sec, s, ceL, ceR) {
        if (s <= sec.sl) {
            const e = Math.max(ceL, sec.fl), q = sec.sl > -1 ? Math.min(1, (sec.sl - s) / (1 + sec.sl)) : 1;
            return sec.fl + (e - sec.fl) * (1 - Math.sqrt(1 - q * q));
        }
        if (s >= sec.sr) {
            const e = Math.max(ceR, sec.fr), q = sec.sr < 1 ? Math.min(1, (s - sec.sr) / (1 - sec.sr)) : 1;
            return sec.fr + (e - sec.fr) * (1 - Math.sqrt(1 - q * q));
        }
        const x = (s - sec.sl) / (sec.sr - sec.sl) * (SECTION_SAMPLES - 1);
        const i = Math.min(SECTION_SAMPLES - 2, Math.floor(x)), u = x - i;
        return sec.mid[i] * (1 - u) + sec.mid[i + 1] * u;
    }

    // ------------------------------------------------------------------
    // Side view of a vertical handle
    // ------------------------------------------------------------------

    // The side view the 3D uses: the drawn one with its ends moved (spec.sideEdit { dy0, dy1 }: the
    // figure is stretched between them and kept on the wall)
    function sidePart(spec, part, scene) {
        const e = spec.sideEdit;
        if (!part || !e || (!e.dy0 && !e.dy1)) return part;
        const ax = scene.axisX, rad = scene.radius.radius, H = rad.length;
        const rw = y => rad[clamp(Math.round(y), 0, H - 1)];
        const all = part.rings.flat();
        const Y0 = Math.min(...all.map(p => p.y)), Y1 = Math.max(...all.map(p => p.y));
        const N0 = Y0 + (e.dy0 || 0), N1 = Math.max(N0 + 10, Y1 + (e.dy1 || 0));
        const k = (N1 - N0) / Math.max(1, Y1 - Y0);
        const sgn = all.reduce((a, p) => a + p.x, 0) / all.length < ax ? -1 : 1;
        // (the distance out of the wall is kept: the arms stay on it)
        const move = p => {
            const y = N0 + (p.y - Y0) * k;
            return { x: ax + sgn * (rw(y) + sgn * (p.x - ax) - rw(p.y)), y };
        };
        const rings = part.rings.map(r => {
            const q = r.map(move);
            if (r.edgeEnd) q.edgeEnd = r.edgeEnd;
            if (r.open) q.open = r.open;
            return q;
        });
        return Object.assign({}, part, { rings, outline: rings[0], bbox: G().bbox(rings[0]) });
    }

    // Vertical handle: front polygon x side view
    function verticalField(spec, part, scene, poly, bb) {
        const ax = scene.axisX, wall = scene.radius, H = wall.radius.length;
        const rho = outerProfile(part, ax, H);
        if (!rho) return null;
        const holes = part.rings.slice(1).map(r => G().edgeLine(r));
        const inner = holes.length ? G().radiusByRow(holes, ax, H, false) : null;
        const yTop = Math.max(rho.y0, Math.ceil(bb.y0)), yBot = Math.min(rho.y1, Math.floor(bb.y1));
        if (yBot <= yTop) return null;
        // the azimuth of the handle, from the middle of its polygon at mid height
        const yMid = Math.min(yBot, Math.max(yTop, Math.round((yTop + yBot) / 2)));
        const spMid = G().horizontalSpans(yMid + 0.5, poly);
        if (!spMid.length) return null;
        const pMid = rho.radius[yMid] > 0.5 ? rho.radius[yMid] : wall.radius[yMid];
        const sinT = clamp(((spMid[0][0] + spMid[spMid.length - 1][1]) / 2 - ax) / pMid, -MAX_SIN, MAX_SIN);
        const cosT = Math.sqrt(1 - sinT * sinT);
        // rounding radius of the section on every row
        const Rrow = new Float32Array(H).fill(0.05), RtRow = new Float32Array(H).fill(0.05), hwRow = new Float32Array(H);
        // the frame of the section on every row: middle and half width of the front outline (x of the
        // drawing), the section there and the depth its corners end at
        const cxRow = new Float32Array(H), hwxRow = new Float32Array(H).fill(1), ceL = new Float32Array(H), ceR = new Float32Array(H);
        const secRow = new Array(H).fill(null);
        let sumW = 0, n = 0, maxHw = 0, rhoMax = 0;
        const strap = [], all = [];
        for (let y = yTop; y <= yBot; y++) {
            const p = rho.radius[y];
            if (p <= 0.5) continue;
            const spans = G().horizontalSpans(y + 0.5, poly);
            if (!spans.length) continue;
            const xl = spans[0][0], xr = spans[spans.length - 1][1];
            if (xr - xl < 1) continue;
            const hw = (xr - xl) / (2 * cosT);
            cxRow[y] = (xl + xr) / 2;
            hwxRow[y] = (xr - xl) / 2;
            const hole = inner && inner.radius[y] > 0.5 ? inner.radius[y] : wall.radius[y];
            const b = spec.thickness > 0 ? spec.thickness : Math.max(3, p - hole);
            hwRow[y] = hw;
            all.push(b);
            if (inner && inner.radius[y] > 0.5) strap.push(b);
            sumW += xr - xl; n++;
            maxHw = Math.max(maxHw, hw);
            rhoMax = Math.max(rhoMax, p);
        }
        if (!n) return null;
        // The rounding of the section follows the width of the polygon and one thickness for the whole
        // handle (with the local thickness the flat face would narrow where the strap is thick). Its depth
        // is half the thickness; across, the corners reach from the shoulders of the section to the edges
        // (elliptic: a wide strap is curved across and its tone turns gradually, as on a cylinder). A
        // corner narrower than it is deep ends higher up the side, as a round one would.
        const thickRef = spec.thickness > 0 ? spec.thickness : all.slice().sort((p, q) => p - q)[Math.floor(all.length / 2)];
        const track = sectionTrack(spec);
        for (let y = yTop; y <= yBot; y++) {
            if (!(hwRow[y] > 0)) continue;
            const sec = track((y - yTop) / Math.max(1, yBot - yTop));
            secRow[y] = sec;
            RtRow[y] = Math.max(0.05, thickRef / 2);
            ceL[y] = Math.min(1, (1 + sec.sl) * hwRow[y] / RtRow[y]);
            ceR[y] = Math.min(1, (1 - sec.sr) * hwRow[y] / RtRow[y]);
            // the inner corners (towards the wall) as round as the outer ones
            Rrow[y] = Math.max(0.05, Math.min(1, 1 - (sec.sr - sec.sl) / 2) * hwRow[y]);
        }
        // Rows without a width (above and below the polygon, gaps) take the rounding of the nearest row:
        // unrounded, the blurred edge of the side view would leave a thin skin there, whose underside
        // draws a dark line across the top of the handle
        const near = new Int32Array(H).fill(-1);
        for (let y = 0, last = -1; y < H; y++) { if (hwRow[y] > 0) last = y; near[y] = last; }
        for (let y = H - 1, last = -1; y >= 0; y--) {
            if (hwRow[y] > 0) last = y;
            if (last >= 0 && (near[y] < 0 || last - y < y - near[y])) near[y] = last;
        }
        for (let y = 0; y < H; y++) {
            const q = near[y];
            if (hwRow[y] > 0 || q < 0) continue;
            Rrow[y] = Rrow[q]; RtRow[y] = RtRow[q]; cxRow[y] = cxRow[q]; hwxRow[y] = hwxRow[q];
            ceL[y] = ceL[q]; ceR[y] = ceR[q]; secRow[y] = secRow[q];
        }
        const face = (i, x) => secRow[i] ? faceDepth(secRow[i], (x - cxRow[i]) / hwxRow[i], ceL[i], ceR[i]) : 0;
        const P = polygonGrid(poly, bb);
        const side = sideGrid(part, wall, ax, y => inner && inner.radius[clamp(Math.round(y), 0, H - 1)] > 0.5);
        const meanW = sumW / n;
        const median = a => { const c = a.slice().sort((p, q) => p - q); return c[Math.floor(c.length / 2)]; };
        // the fillet is a fraction of the thickness of the strap
        const kFull = (('blend' in spec) ? spec.blend : 0.5) * median(strap.length ? strap : all) * BLEND_SCALE;
        // (only where the arms stand on the wall: not across the lume)
        const kRow = attachK(Uint8Array.from({ length: H }, (_, y) => (inner && inner.radius[y] > 0.5 ? 0 : 1)), kFull);
        // what the side view says: the thickness of the strap and the size of the lume
        let stats = `side view: strap ${Math.round(median(strap.length ? strap : all))} px thick`;
        if (holes.length) { const hb = G().bbox(holes.flat()); stats += `, lume ${Math.round(hb.w)} x ${Math.round(hb.h)} px`; }
        return {
            axis: 'y', spec, part, bb, theta: Math.asin(sinT), meanW, yTop, yBot, xmin: bb.x0, xmax: bb.x1, stats,
            // for the editing of the section: its frame on a row, the outer face of the side view there
            frame: y => { const i = clamp(Math.round(y - 0.5), 0, H - 1); return { cx: cxRow[i], hw: hwxRow[i], depth: RtRow[i] }; },
            outerRho: y => side.rows.at(side.rows.hi, y),
            zTop: rhoMax + maxHw + 2, rhoMax, halfU: maxHw,
            k: kFull, thick: median(strap.length ? strap : all),
            kAt: (x, y) => taper(kRow[clamp(Math.round(y - 0.5), 0, H - 1)], P.grid.at(x, y)),
            inside: P.isInside,
            sdXY: (x, y) => P.grid.at(x, y),
            sd(x, y, z) {
                const rp = (x - ax) * sinT + z * cosT;
                const f = clamp(y - 0.5, 0, H - 1), i = Math.floor(f), t = f - i, i1 = Math.min(H - 1, i + 1);
                let b = side.at(rp, y);
                if (spec.thickness > 0) b = Math.max(b, rho.radius[i] * (1 - t) + rho.radius[i1] * t - spec.thickness - rp);
                // The section is shaped in the radial direction only: with the distance to the whole
                // side figure the strap would narrow towards the tip of an arm
                const Ru = Rrow[i] * (1 - t) + Rrow[i1] * t, Rt = RtRow[i] * (1 - t) + RtRow[i1] * t;
                // depth below the outer face along rho': the distance to the contour (consistent with b)
                // over the cosine of its slope; near the tip of an arm the depth is large, no rounding
                const sk = side.rows.at(side.rows.slope, y);
                const tOut = Math.max(0, -b) * Math.sqrt(1 + sk * sk), tIn = side.inner.at(rp, y);
                // no deeper than half the strap there: deeper, the two rounded faces would meet short of
                // the traced outline (where the side view is thinner, or slanted)
                const Rd = Math.max(0.05, Math.min(Rt, 0.5 * (tOut + Math.max(0, tIn))));
                // the outer face: the section across the strap (a height field below the side view's face;
                // steeper than a distance at the edges: the ray-march bounds its steps and refines the hit)
                const fOut = Rd * (face(i, x) * (1 - t) + face(i1, x) * t) - tOut;
                return Math.max(b, fOut, P.grid.at(x, y) + recess(tIn, Ru, Rd));
            }
        };
    }

    // Horizontal handle or lug: front polygon x band between two offsets of the wall. The outer offset
    // is the crest dz(t), the inner one the underside (spec.under, the lume; without it, one thickness
    // below the crest). The outer face is shaped across the strap by the sections (spec.sections, the
    // same as those of a vertical handle, t along the length; s across from the top edge to the bottom
    // one), the corners on the underside are as round as the outer ones. A lug has no lume: it is solid
    // down to the wall.
    // The arch may be turned (spec.lean, degrees, up at the crest): the whole strap, section included,
    // turns as a solid about the line along its length that runs through the middle of the traced
    // outline, so it keeps its shape whatever the inclination; at 90 degrees the ring lies flat on the
    // wall and is seen from the front as an arch. The traced polygon is the footprint of the strap
    // before it is turned; what is seen from the front is its projection (`outline`), worked out from the
    // sections: an ellipse for a round section, a rectangle for a square one.
    // A section "as drawn" (spec.section 'drawn') is the figure drawn next to the profile itself, as the side
    // view of a vertical handle is: it runs along the part, farther out of the wall or nearer to it as the
    // crest seen from above, and is cut by the traced outline. It is not turned (it is drawn as it leans).
    function horizontalField(spec, side, scene, poly, bb, vessel) {
        const xmin = Math.ceil(bb.x0), xmax = Math.floor(bb.x1);
        const drawn = drawnSection(side, scene);
        if (xmax - xmin < 3 || !drawn) return null;
        const lug = spec.kind === 'lug';
        // the crest stands out of the wall as far as in the section drawn, until it is edited from above
        const plan = spec.plan && spec.plan.length ? spec.plan : defaultPlan(drawn.crest);
        const ratio = spec.thickRatio > 0 ? spec.thickRatio : 0.6;
        // A horizontal handle is a lug with a hole through it: a cylinder from top to bottom (spec.holeTilt, degrees,
        // leans it out of the wall towards the bottom), whose section seen from above is the lume. It reaches
        // spec.under out of the wall along the handle (edited from above), else a shape (spec.lumeShape) as
        // deep as the gap between the strap and the wall in the section drawn (without a gap there, e.g. the
        // handle leans and hides it, a little less than half the crest). Where the hole comes out above and
        // below are the openings of the lume.
        const crestTop = Math.max(...plan.map(p => p.dz));
        const depth = Math.min(drawn.under > 1 ? drawn.under : 0.45 * drawn.crest, crestTop - 2);
        // (the arms as thick along the length as the strap is at the crest, at most a fifth of it each)
        // spec.lumeShape 'none': no hole (the default of a lug); 'hole': a round hole inside it, closed all round (its
        // near edge is another curve, spec.underNear), as in a lug pierced for a cord
        const closed = spec.lumeShape === 'hole';
        const hasHole = lug ? !!spec.lumeShape && spec.lumeShape !== 'none' : spec.lumeShape !== 'none';
        const len = Math.max(1, xmax - xmin), cz = 0.5 * crestTop;
        const hr = Math.min(0.35 * crestTop, 0.18 * len), tl = 0.5 - hr / len, tr = 0.5 + hr / len;
        // (a round hole as two curves meeting at its tips, four Bezier arcs: its far edge and its near edge)
        const K = 0.5523, rt = hr / len, r1 = v => Math.round(v * 10) / 10;
        const circleNodes = sign => [
            { t: tl, z: r1(cz), hl: [0, 0], hr: [0, r1(sign * K * hr)] },
            { t: 0.5, z: r1(cz + sign * hr), hl: [-K * rt, 0], hr: [K * rt, 0] },
            { t: tr, z: r1(cz), hl: [0, r1(sign * K * hr)], hr: [0, 0] }
        ];
        const holePlan = !hasHole ? null : spec.under && spec.under.length ? spec.under
            : closed ? bezSample(circleNodes(1)) : shapePlan(spec.lumeShape, depth, clamp(Math.max(2, crestTop - depth) / len, 0, 0.2));
        // (the opening below may be another one than the opening above: then the hole runs from one to the other)
        const holeLow = holePlan && spec.under && spec.under.length && spec.underLow && spec.underLow.length ? spec.underLow : holePlan;
        const nearUp = closed ? (spec.underNear && spec.underNear.length ? spec.underNear : bezSample(circleNodes(-1))) : null;
        const nearLow = closed ? (spec.underNearLow && spec.underNearLow.length && spec.underNear && spec.underNear.length ? spec.underNearLow : nearUp) : null;
        // (a closed hole is only where its curves are, from tip to tip; spec.holeScale makes it larger or smaller about its
        // middle)
        const hs = closed ? clamp(spec.holeScale || 1, 0.2, 4) : 1;
        const zMid = (far, near) => (Math.max(...far.map(p => p.dz)) + Math.min(...near.map(p => p.dz))) / 2;
        const zcU = closed ? zMid(holePlan, nearUp) : 0, zcL = closed ? zMid(holeLow, nearLow) : 0;
        // the height of a curve of the hole at t (0 outside the hole), `far` giving its span and middle
        const hv = (plan, far, zc, t) => {
            if (!closed) return planAt(plan, t);
            const a = far[0].t, b = far[far.length - 1].t, tc = (a + b) / 2, q = tc + (t - tc) / hs;
            return q < a || q > b ? 0 : zc + hs * (planAt(plan, q) - zc);
        };
        const tanH = Math.tan(clamp(spec.holeTilt || 0, -60, 60) * Math.PI / 180);
        const asDrawn = spec.section === 'drawn';
        const phi = asDrawn ? 0 : clamp(spec.lean || 0, -90, 90) * Math.PI / 180, sinF = Math.sin(phi), cosF = Math.cos(phi);
        const N = xmax - xmin + 1;
        const dz = new Float32Array(N), un = new Float32Array(N), hole = new Float32Array(N), hh = new Float32Array(N), cyA = new Float32Array(N);
        const thick = new Float32Array(N), Rt = new Float32Array(N), Ru = new Float32Array(N);
        const ceL = new Float32Array(N), ceR = new Float32Array(N), secs = new Array(N);
        const yLo = new Float32Array(N), yHi = new Float32Array(N), holeU = new Float32Array(N), holeL = new Float32Array(N);
        const nearU = new Float32Array(N), nearL = new Float32Array(N), nearMin = new Float32Array(N);
        // A round or oval section is fixed: what was shaped by hand at some position (shoulders, points) does
        // not apply to it, or it would stop being round; square, strap and custom sections can be shaped
        const locked = asDrawn || spec.section === 'round' || spec.section === 'oval';
        const track = sectionTrack(locked ? { roundness: spec.roundness } : spec);
        const q = 1 - clamp(spec.roundness == null ? 0.6 : spec.roundness, 0, 1);
        let sumW = 0, n = 0, dzMax = 0, hhMax = 0;
        for (let i = 0; i < N; i++) {
            const x = xmin + i, t = N > 1 ? i / (N - 1) : 0;
            dz[i] = Math.max(0, planAt(plan, t));
            dzMax = Math.max(dzMax, dz[i]);
            const spans = G().verticalSpans(x + 0.5, poly);
            hh[i] = spans.length ? (spans[spans.length - 1][1] - spans[0][0]) / 2 : 0;
            hhMax = Math.max(hhMax, hh[i]);
            cyA[i] = spans.length ? (spans[spans.length - 1][1] + spans[0][0]) / 2 : 0;
            const strap = spec.thickness > 0 ? spec.thickness : Math.max(6, ratio * 2 * hh[i]);
            // solid down to the wall (back into it along its axis, far enough to stay on it when it leans); a
            // handle has the hole through it
            un[i] = -Math.max(0.5, (2 * hh[i] + dz[i]) * Math.abs(cosF));
            holeU[i] = hasHole ? clamp(hv(holePlan, holePlan, zcU, t), 0, Math.max(0, dz[i] - 2)) : 0;
            holeL[i] = hasHole ? clamp(hv(holeLow, holeLow, zcL, t), 0, Math.max(0, dz[i] - 2)) : 0;
            hole[i] = Math.max(holeU[i], holeL[i]);
            if (closed) {
                nearU[i] = clamp(hv(nearUp, holePlan, zcU, t), 0, holeU[i]);
                nearL[i] = clamp(hv(nearLow, holeLow, zcL, t), 0, holeL[i]);
                nearMin[i] = Math.min(nearU[i], nearL[i]);
            }
            thick[i] = lug || closed ? strap : Math.max(2, dz[i] - hole[i]);
            Rt[i] = Math.max(0.05, Math.min(thick[i] / 2, hh[i]));
            const sec = secs[i] = track(t);
            const h = Math.max(hh[i], 1e-3);
            ceL[i] = Math.min(1, (1 + sec.sl) * h / Rt[i]);
            ceR[i] = Math.min(1, (1 - sec.sr) * h / Rt[i]);
            Ru[i] = Math.max(0.05, Math.min(1, 1 - (sec.sr - sec.sl) / 2) * h);
            if (hh[i] > 0) { sumW += 2 * hh[i]; n++; }
            // what the turned strap covers on the drawing at x: its middle, and half its extent
            const lo = 0, a = hh[i], b = (dz[i] - lo) / 2, dm = (dz[i] + lo) / 2;
            const ell = Math.hypot(a * cosF, b * sinF), rect = a * Math.abs(cosF) + b * Math.abs(sinF);
            const half = ell * (1 - q) + rect * q, yc = cyA[i] - dm * sinF;
            yLo[i] = yc - half;
            yHi[i] = yc + half;
        }
        if (!n) return null;
        const meanW = sumW / n;
        const kFull = (('blend' in spec) ? spec.blend : 0.5) * (thick.reduce((a, v) => a + v, 0) / N) * BLEND_SCALE;
        const P = polygonGrid(poly, bb);
        // The outline seen from the front: the traced polygon, or its projection once the strap is turned
        let outline = null, bbF = bb, PF = P;
        if (Math.abs(phi) > 1e-3) {
            const idx = Array.from({ length: N }, (_, i) => i).filter(i => hh[i] > 0);
            outline = idx.map(i => [xmin + i + 0.5, yLo[i]]).concat(idx.slice().reverse().map(i => [xmin + i + 0.5, yHi[i]]))
                .map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
            const pf = outline.map(([x, y]) => ({ x, y }));
            bbF = G().bbox(pf);
            PF = polygonGrid(pf, bbF);
        }
        const pos = x => {
            const f = clamp(x - xmin - 0.5, 0, N - 1), i = Math.floor(f);
            return { i, i1: Math.min(N - 1, i + 1), t: f - i };
        };
        const at = (arr, k) => arr[k.i] * (1 - k.t) + arr[k.i1] * k.t;
        // The fillet only where the strap stands on the wall (the lume is not filled in)
        const kCol = attachK(Uint8Array.from(hole, (v, i) => (v <= 0.5 || (closed && nearMin[i] > 0.5) ? 1 : 0)), kFull);
        const kx = x => at(kCol, pos(x));
        const rMax = Math.max(...Array.from({ length: Math.ceil(bbF.y1) - Math.floor(bbF.y0) + 1 }, (_, i) => vessel.radiusAt(Math.floor(bbF.y0) + i + 0.5)));
        const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
        const reach = Math.hypot(dzMax, hhMax);
        let FW = null;   // the strap where it stands on the wall (see below)
        // the figure drawn next to the profile, over (distance from the axis, y), and the wall it stands on
        const figure = asDrawn ? sideGrid(side, scene.radius, scene.axisX, () => false) : null;
        // (a handle drawn off the wall is a lug first: the gap between it and the wall is filled, the hole opens it
        // again; innerRho the inner edge of the figure on each of its rows)
        let innerRho = null;
        if (figure && !lug && !closed && hasHole && drawn.under > 1) {
            const ax = scene.axisX, ring = side.rings[0];
            const sgn = ring.reduce((a, p) => a + p.x, 0) / ring.length < ax ? -1 : 1;
            innerRho = new Float32Array(Math.ceil(drawn.y1) - Math.floor(drawn.y0) + 1).fill(NaN);
            for (let j = 0; j < innerRho.length; j++) {
                for (const [xa, xb] of G().horizontalSpans(Math.floor(drawn.y0) + j + 0.5, ring)) {
                    const m = Math.min(sgn * (xa - ax), sgn * (xb - ax));
                    if (!(innerRho[j] <= m)) innerRho[j] = m;
                }
            }
        }
        const innerAt = y => {
            const j = Math.round(y - 0.5 - Math.floor(drawn.y0));
            return j >= 0 && j < innerRho.length ? innerRho[j] : NaN;
        };
        // the hole: out of the wall (r) less than its depth, leaning with spec.holeTilt; rounded along its edges
        const smax = (a, b, k) => -smin(-a, -b, k);
        // (how far out of the wall it reaches across the strap: from the opening above, at the top edge, to the one below)
        const holeHd = (k, uu) => {
            const s = clamp((uu / Math.max(1, at(hh, k)) + 1) / 2, 0, 1);
            return at(holeU, k) * (1 - s) + at(holeL, k) * s;
        };
        const nearHd = (k, uu) => {
            const s = clamp((uu / Math.max(1, at(hh, k)) + 1) / 2, 0, 1);
            return at(nearU, k) * (1 - s) + at(nearL, k) * s;
        };
        const holeCut = (k, r, uu, base) => {
            if (!hasHole) return base;
            const hd = holeHd(k, uu);
            if (hd <= 0) return base;
            let cut = hd - (r - uu * tanH);
            // (closed: the hole is between its far and its near edge; where they meet there is none)
            if (closed) {
                const nr = nearHd(k, uu);
                if (hd - nr <= 0.5) return base;
                cut = Math.min(cut, r - uu * tanH - nr);
            }
            return smax(base, cut, Math.min(0.5 * at(thick, k), 0.35 * at(hh, k)));
        };
        const part = {
            axis: 'x', spec, bb: bbF, bbFoot: bb, outline, sectionLocked: locked, asDrawn, theta: Math.asin(clamp((cx - scene.axisX) / Math.max(1, vessel.radiusAt(cy)), -MAX_SIN, MAX_SIN)),
            meanW, yTop: bbF.y0, yBot: bbF.y1, xmin, xmax, plan, lug, crestMax: Math.max(1, dzMax), phi,
            // where the underside is (the lume under the strap)
            underPlan: holePlan || [], underLowPlan: holeLow || [], underNearPlan: nearUp || [], underNearLowPlan: nearLow || [], circleNodes: closed ? { far: circleNodes(1), near: circleNodes(-1) } : null,
            // an opening of a closed hole (the upper one, or the lower) as a loop of [x, r] in the frame of the strap before it
            // is turned: out of the wall, far edge there, near edge back
            rimLoop: closed ? (low = false, n = 28) => {
                const far = low ? holeLow : holePlan, near = low ? nearLow : nearUp, zc = low ? zcL : zcU;
                const a = far[0].t, b = far[far.length - 1].t, tc = (a + b) / 2;
                const ts = Array.from({ length: n + 1 }, (_, i) => tc + (b - a) / 2 * hs * 0.999 * (2 * i / n - 1));
                const val = (plan, t) => hv(plan, far, zc, t);
                const x = t => xmin + t * (xmax - xmin) + 0.5;
                return ts.map(t => [x(t), val(far, t)]).concat(ts.slice().reverse().map(t => [x(t), val(near, t)]));
            } : null, holeTan: tanH, drawn,
            // the frame of the section at x: the axis it turns about (cy), its half width, its crest, its depth
            frameAt: x => {
                const k = pos(x);
                return { cy: at(cyA, k), hw: Math.max(1, at(hh, k)), dz: at(dz, k), depth: at(Rt, k) };
            },
            zTop: rMax + reach + 4, rhoMax: rMax + reach, halfU: (xmax - xmin) / 2,
            k: kFull, thick: thick.reduce((a, v) => a + v, 0) / N,
            // The fillet is full where the strap stands on the wall and fades out beyond that footprint (not
            // beyond the traced outline: a round strap touches the wall in a narrow band, and a fillet as
            // wide as the outline would leave a ledge on each side of it)
            kAt: (x, y) => taper(kx(x), FW ? FW.at(x, y) : PF.grid.at(x, y)),
            inside: PF.isInside,
            sdXY: (x, y) => PF.grid.at(x, y),
            sd(x, y, z) {
                const dv = vessel.sd(x, y, z), k = pos(x), { i, i1, t } = k;
                if (figure) {
                    // the figure as large as the crest there (the drawn one at its full height), about the
                    // middle of where it stands on the wall: smaller, it is also lower and shorter
                    const sc = Math.min(50, drawn.crest / Math.max(1e-3, at(dz, k)));
                    const ys = drawn.ya + (y - drawn.ya) * sc, rho = Math.hypot(x - scene.axisX, z);
                    const rs = vessel.radiusAt(ys) + (rho - vessel.radiusAt(y)) * sc;
                    const f = figure.at(rs, ys), uu = y - at(cyA, k);
                    if (!innerRho) return holeCut(k, dv, uu, Math.max(f / sc, P.grid.at(x, y)));
                    // the gap filled (a little into the figure), and the hole through it following the inner side of
                    // the figure: all of the gap where the hole is as deep as the drawn one (the figure as drawn),
                    // less of it towards the arms
                    const e = innerAt(ys), rw = vessel.radiusAt(ys);
                    if (Number.isNaN(e)) return Math.max(f / sc, P.grid.at(x, y));
                    const fill = Math.max(rs - (e + 3), drawn.y0 - ys, ys - drawn.y1);
                    const base = Math.max(Math.min(f, fill) / sc, P.grid.at(x, y)), hd = holeHd(k, uu);
                    if (hd <= 0) return base;
                    const cut = ((hd / drawn.under) * (e - rw) - (rs - rw)) / sc + uu * tanH;
                    return smax(base, cut, Math.min(0.5 * at(thick, k), 0.35 * at(hh, k)));
                }
                const d = at(dz, k), yc = at(cyA, k), hw = Math.max(1, at(hh, k));
                // turn back to the strap as it was before: across the strap (uu) and out of the wall (r)
                const p = y - yc;
                const uu = p * cosF + dv * sinF, r = -p * sinF + dv * cosF;
                const s = uu / hw;
                const u0 = at(un, k);
                const face = faceDepth(secs[i], s, ceL[i], ceR[i]) * (1 - t) + faceDepth(secs[i1], s, ceL[i1], ceR[i1]) * t;
                // depth below the crest and above the underside (a lug: far from it)
                const tOut = Math.max(0, d - r), tIn = Math.max(0, r - u0);
                const Rd = Math.max(0.05, Math.min(at(Rt, k), 0.5 * (tOut + tIn)));
                return holeCut(k, r, uu, Math.max(r - d, Rd * face - tOut, u0 - r, P.grid.at(x, yc + uu) + recess(tIn, at(Ru, k), Rd)));
            }
        };
        // the field of the strap on the surface of the wall, on a grid
        const pad = Math.ceil(kFull) + 6;
        const gx0 = Math.floor(bbF.x0) - pad, gy0 = Math.floor(bbF.y0) - pad;
        const GW = Math.ceil(bbF.x1) - gx0 + pad + 1, GH = Math.ceil(bbF.y1) - gy0 + pad + 1;
        const gs = Math.max(1, Math.ceil(Math.sqrt(GW * GH / 1e5)));
        const gw = Math.ceil(GW / gs), gh = Math.ceil(GH / gs);
        const data = new Float32Array(gw * gh);
        for (let j = 0; j < gh; j++) {
            for (let i = 0; i < gw; i++) {
                const x = gx0 + (i + 0.5) * gs, y = gy0 + (j + 0.5) * gs;
                data[j * gw + i] = part.sd(x, y, wallZ(scene, x, y));
            }
        }
        FW = new Grid(gx0, gy0, gw, gh, data, gs);
        return part;
    }

    // The field of an applied part from what the drawing gives (null when it is not possible). The same
    // part is asked for by the front view and by the 3D views: the last few are kept, by what shapes them
    const partCache = new Map();

    function partField(spec, part, scene, vessel) {
        const { shadow, bend, ...shape } = spec;
        const key = JSON.stringify([shape, part && part.id, part && part.rings.length, part && part.rings[0].length,
            scene.axisX, scene.radius && scene.radius.y0, scene.radius && scene.radius.y1, scene.radius && scene.radius.radius.length]);
        const hit = partCache.get(key);
        if (hit && hit.scene === scene) {
            partCache.delete(key);
            partCache.set(key, hit);
            return hit.pf;
        }
        const pf = buildPartField(spec, part, scene, vessel);
        partCache.set(key, { scene, pf });
        if (partCache.size > 12) partCache.delete(partCache.keys().next().value);
        return pf;
    }

    function buildPartField(spec, part, scene, vessel) {
        const poly = (spec.points || []).map(([x, y]) => ({ x, y }));
        if (poly.length < 3 || !scene.radius || scene.axisX === null) return null;
        const bb = G().bbox(poly);
        vessel = vessel || vesselField(scene);
        if (!part) return null;
        if (spec.axis === 'x') return horizontalField(spec, part, scene, poly, bb, vessel);
        const side = sidePart(spec, part, scene);
        return side ? verticalField(spec, side, scene, poly, bb) : null;
    }

    // Union of the vessel and some parts
    function unionOf(vessel, pfs) {
        return (x, y, z) => {
            let d = vessel ? vessel.sd(x, y, z) : Infinity;
            for (const p of pfs) d = vessel ? smin(d, p.sd(x, y, z), p.kAt(x, y)) : Math.min(d, p.sd(x, y, z));
            return d;
        };
    }

    // Outward unit normal of a field: its gradient
    function normalAt(F, x, y, z, e = 0.75) {
        const gx = F(x + e, y, z) - F(x - e, y, z), gy = F(x, y + e, z) - F(x, y - e, z), gz = F(x, y, z + e) - F(x, y, z - e);
        const l = Math.hypot(gx, gy, gz) || 1;
        return [gx / l, gy / l, gz / l];
    }

    // ------------------------------------------------------------------
    // Quad mesh: surface nets on the field
    // ------------------------------------------------------------------

    // The surface of F inside a box of the frame of a part (u across, y down, r outwards at the azimuth
    // theta) as a mesh of quads: a vertex in every cell of the grid the surface crosses, a quad on
    // every grid edge it crosses; the vertices are relaxed and put back on the surface.
    //   o = { ax, theta, u: [a, b], y: [a, b], r: [a, b], step }
    //   info(x, y, z) -> { h: share of the parts (0..1), part: index of the strongest part or -1 }
    function quadMesh(F, info, o) {
        const cT = Math.cos(o.theta), sT = Math.sin(o.theta);
        const toWorld = (u, y, r) => [o.ax + u * cT + r * sT, y, -u * sT + r * cT];
        const step = o.step;
        const nx = Math.max(2, Math.ceil((o.u[1] - o.u[0]) / step)), ny = Math.max(2, Math.ceil((o.y[1] - o.y[0]) / step)), nz = Math.max(2, Math.ceil((o.r[1] - o.r[0]) / step));
        const sx = 1, sy = nx + 1, sz = (nx + 1) * (ny + 1);
        const val = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
        for (let k = 0; k <= nz; k++) {
            for (let j = 0; j <= ny; j++) {
                for (let i = 0; i <= nx; i++) {
                    const w = toWorld(o.u[0] + i * step, o.y[0] + j * step, o.r[0] + k * step);
                    val[i * sx + j * sy + k * sz] = F(w[0], w[1], w[2]);
                }
            }
        }
        const cellId = new Int32Array(nx * ny * nz).fill(-1);
        const cellOf = (i, j, k) => i + nx * (j + ny * k);
        const grid = [];      // vertex positions in grid units
        const cornerOff = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
        const cubeEdges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
        const border = [];
        for (let k = 0; k < nz; k++) {
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const v = cornerOff.map(c => val[(i + c[0]) * sx + (j + c[1]) * sy + (k + c[2]) * sz]);
                    let neg = 0;
                    for (const x of v) if (x < 0) neg++;
                    if (neg === 0 || neg === 8) continue;
                    let px = 0, py = 0, pz = 0, cnt = 0;
                    for (const [a, b] of cubeEdges) {
                        if ((v[a] < 0) === (v[b] < 0)) continue;
                        const t = v[a] / (v[a] - v[b]);
                        px += cornerOff[a][0] + t * (cornerOff[b][0] - cornerOff[a][0]);
                        py += cornerOff[a][1] + t * (cornerOff[b][1] - cornerOff[a][1]);
                        pz += cornerOff[a][2] + t * (cornerOff[b][2] - cornerOff[a][2]);
                        cnt++;
                    }
                    cellId[cellOf(i, j, k)] = grid.length / 3;
                    grid.push(i + px / cnt, j + py / cnt, k + pz / cnt);
                    border.push(i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1);
                }
            }
        }
        // Quads
        const quads = [];
        const dims = [nx, ny, nz];
        for (let k = 0; k <= nz; k++) {
            for (let j = 0; j <= ny; j++) {
                for (let i = 0; i <= nx; i++) {
                    const p = [i, j, k], v0 = val[i * sx + j * sy + k * sz];
                    for (let a = 0; a < 3; a++) {
                        if (p[a] >= dims[a]) continue;
                        const q = p.slice();
                        q[a]++;
                        const v1 = val[q[0] * sx + q[1] * sy + q[2] * sz];
                        if ((v0 < 0) === (v1 < 0)) continue;
                        const b = (a + 1) % 3, c = (a + 2) % 3;
                        if (p[b] < 1 || p[c] < 1 || p[b] >= dims[b] || p[c] >= dims[c]) continue;
                        const cell = (db, dc) => {
                            const r = p.slice();
                            r[b] += db; r[c] += dc;
                            return cellId[cellOf(r[0], r[1], r[2])];
                        };
                        const c0 = cell(-1, -1), c1 = cell(0, -1), c2 = cell(0, 0), c3 = cell(-1, 0);
                        if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) continue;
                        if (v0 < 0) quads.push(c0, c1, c2, c3); else quads.push(c0, c3, c2, c1);
                    }
                }
            }
        }
        const V = grid.length / 3;
        const pos = new Float64Array(V * 3);
        for (let v = 0; v < V; v++) {
            const w = toWorld(o.u[0] + grid[3 * v] * step, o.y[0] + grid[3 * v + 1] * step, o.r[0] + grid[3 * v + 2] * step);
            pos[3 * v] = w[0]; pos[3 * v + 1] = w[1]; pos[3 * v + 2] = w[2];
        }
        // Neighbours along the quad edges, and the unique edges (for the wireframe)
        const nb = Array.from({ length: V }, () => new Set());
        const edgeKey = new Set(), wire = [];
        for (let t = 0; t < quads.length; t += 4) {
            for (let e = 0; e < 4; e++) {
                const a = quads[t + e], b = quads[t + (e + 1) % 4];
                nb[a].add(b); nb[b].add(a);
                const key = a < b ? a * V + b : b * V + a;
                if (!edgeKey.has(key)) { edgeKey.add(key); wire.push(a, b); }
            }
        }
        // Relax (average with the neighbours) and project back on the surface
        const project = (v, times) => {
            for (let s = 0; s < times; s++) {
                const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
                const d = F(x, y, z);
                const g = normalAt(F, x, y, z, 0.5 * step);
                pos[3 * v] = x - d * g[0]; pos[3 * v + 1] = y - d * g[1]; pos[3 * v + 2] = z - d * g[2];
            }
        };
        for (let it = 0; it < 3; it++) {
            const next = Float64Array.from(pos);
            for (let v = 0; v < V; v++) {
                if (border[v] || nb[v].size < 3) continue;
                let ax = 0, ay = 0, az = 0;
                for (const u of nb[v]) { ax += pos[3 * u]; ay += pos[3 * u + 1]; az += pos[3 * u + 2]; }
                const m = nb[v].size;
                next[3 * v] = 0.5 * pos[3 * v] + 0.5 * ax / m;
                next[3 * v + 1] = 0.5 * pos[3 * v + 1] + 0.5 * ay / m;
                next[3 * v + 2] = 0.5 * pos[3 * v + 2] + 0.5 * az / m;
            }
            pos.set(next);
            for (let v = 0; v < V; v++) project(v, 1);
        }
        for (let v = 0; v < V; v++) project(v, 1);
        const nrm = new Float32Array(V * 3), hArr = new Float32Array(V), partArr = new Int8Array(V);
        for (let v = 0; v < V; v++) {
            const g = normalAt(F, pos[3 * v], pos[3 * v + 1], pos[3 * v + 2], 0.5 * step);
            nrm[3 * v] = g[0]; nrm[3 * v + 1] = g[1]; nrm[3 * v + 2] = g[2];
            const inf = info(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
            hArr[v] = inf.h;
            partArr[v] = inf.part;
        }
        const idx = new Uint32Array(quads.length / 4 * 6);
        for (let t = 0, m = 0; t < quads.length; t += 4) {
            idx[m++] = quads[t]; idx[m++] = quads[t + 1]; idx[m++] = quads[t + 2];
            idx[m++] = quads[t]; idx[m++] = quads[t + 2]; idx[m++] = quads[t + 3];
        }
        return {
            pos: Float32Array.from(pos), nrm, idx, quads: Uint32Array.from(quads), wire: Uint32Array.from(wire),
            attr: hArr, part: partArr, tag: 'union', doubleSided: true, step
        };
    }

    window.ProspectField = {
        smin, share, vesselField, wallZ, planAt, defaultPlan, outerProfile, partField, unionOf, normalAt, quadMesh, BLEND_SCALE,
        sidePart, sectionTrack, faceDepth, defaultSection, drawnSection, shapePlan, bezFromPlan, bezSample, syncBez, bezEnsure
    };
})();
