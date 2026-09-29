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
//     dz(t) and dz(t) - b, where dz(t) is the crest along the length (the top view edits it).
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

    // How far the side of a section recedes at depth t below a face, for corners of radius R
    function recess(t, R) {
        if (t >= R) return 0;
        if (t <= 0) return R;
        const u = R - t;
        return R - Math.sqrt(Math.max(1e-6, R * R - u * u));
    }

    // Intersection of two fields with the corner rounded by R
    function roundedIntersection(a, b, R) {
        const qa = a + R, qb = b + R;
        return Math.hypot(Math.max(qa, 0), Math.max(qb, 0)) + Math.min(Math.max(qa, qb), 0) - R;
    }

    // A field sampled on a pixel grid, bilinear; beyond the grid the distance to it is added
    class Grid {
        constructor(x0, y0, w, h, data) {
            this.x0 = x0; this.y0 = y0; this.w = w; this.h = h; this.data = data;
        }

        at(x, y) {
            const mx = this.w - 1, my = this.h - 1;
            let fx = x - this.x0 - 0.5, fy = y - this.y0 - 0.5, ox = 0, oy = 0;
            if (fx < 0) { ox = -fx; fx = 0; } else if (fx > mx) { ox = fx - mx; fx = mx; }
            if (fy < 0) { oy = -fy; fy = 0; } else if (fy > my) { oy = fy - my; fy = my; }
            const i = Math.min(mx - 1, Math.floor(fx)), j = Math.min(my - 1, Math.floor(fy));
            const tx = fx - i, ty = fy - j, d = this.data, w = this.w;
            const k = j * w + i;
            const v = (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - ty) + (d[k + w] * (1 - tx) + d[k + w + 1] * tx) * ty;
            return ox || oy ? v + Math.hypot(ox, oy) : v;
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

    // ------------------------------------------------------------------
    // Applied parts
    // ------------------------------------------------------------------

    // rho_out(y) of a part (side view), per image row
    function outerProfile(part, axisX, height) {
        return G().radiusByRow([G().edgeLine(part.outline)], axisX, height, false);
    }

    // Raster of the front polygon: inside test and signed distance
    function polygonGrid(poly, bb) {
        const pad = 12;
        const x0 = Math.floor(bb.x0) - pad, y0 = Math.floor(bb.y0) - pad;
        const w = Math.ceil(bb.x1) - x0 + pad + 1, h = Math.ceil(bb.y1) - y0 + pad + 1;
        const path = ctx => {
            ctx.beginPath();
            poly.forEach((p, i) => (i ? ctx.lineTo(p.x - x0, p.y - y0) : ctx.moveTo(p.x - x0, p.y - y0)));
            ctx.closePath();
        };
        const fill = alphaOf(w, h, ctx => { path(ctx); ctx.fillStyle = '#000'; ctx.fill(); });
        const edge = alphaOf(w, h, ctx => { path(ctx); ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke(); });
        const inside = new Uint8Array(w * h);
        for (let k = 0; k < w * h; k++) inside[k] = fill[k] > 127 ? 1 : 0;
        return { grid: new Grid(x0, y0, w, h, signedDistance(inside, edge, w, h, 2)), inside, x0, y0, w, h };
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

    // Vertical handle: front polygon x side view
    function verticalField(spec, part, scene, poly, bb) {
        const ax = scene.axisX, wall = scene.radius, H = wall.radius.length;
        const rho = outerProfile(part, ax, H);
        if (!rho) return null;
        const holes = part.rings.slice(1).map(r => G().edgeLine(r));
        const inner = holes.length ? G().radiusByRow(holes, ax, H, false) : null;
        const beta = spec.roundness;
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
        const Rrow = new Float32Array(H).fill(0.05), hwRow = new Float32Array(H);
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
        // handle (with the local thickness the flat face would narrow where the strap is thick)
        const thickRef = spec.thickness > 0 ? spec.thickness : all.slice().sort((p, q) => p - q)[Math.floor(all.length / 2)];
        for (let y = yTop; y <= yBot; y++) if (hwRow[y] > 0) Rrow[y] = Math.max(0.05, Math.min(beta * hwRow[y], hwRow[y], thickRef / 2));
        const P = polygonGrid(poly, bb);
        const side = sideGrid(part, wall, ax, y => inner && inner.radius[clamp(Math.round(y), 0, H - 1)] > 0.5);
        const meanW = sumW / n;
        const median = a => { const c = a.slice().sort((p, q) => p - q); return c[Math.floor(c.length / 2)]; };
        // the fillet is a fraction of the thickness of the strap
        const kFull = (('blend' in spec) ? spec.blend : 0.5) * median(strap.length ? strap : all) * BLEND_SCALE;
        // what the side view says: the thickness of the strap and the size of the lume
        let stats = `side view: strap ${Math.round(median(strap.length ? strap : all))} px thick`;
        if (holes.length) { const hb = G().bbox(holes.flat()); stats += `, lume ${Math.round(hb.w)} x ${Math.round(hb.h)} px`; }
        return {
            axis: 'y', spec, bb, theta: Math.asin(sinT), meanW, yTop, yBot, xmin: bb.x0, xmax: bb.x1, stats,
            zTop: rhoMax + maxHw + 2, rhoMax, halfU: maxHw,
            k: kFull, thick: median(strap.length ? strap : all),
            kAt: (x, y) => taper(kFull, P.grid.at(x, y)),
            inside: (px, py) => {
                const i = Math.floor(px) - P.x0, j = Math.floor(py) - P.y0;
                return i >= 0 && j >= 0 && i < P.w && j < P.h && P.inside[j * P.w + i] === 1;
            },
            sdXY: (x, y) => P.grid.at(x, y),
            sd(x, y, z) {
                const rp = (x - ax) * sinT + z * cosT;
                const f = clamp(y - 0.5, 0, H - 1), i = Math.floor(f), t = f - i, i1 = Math.min(H - 1, i + 1);
                let b = side.at(rp, y);
                if (spec.thickness > 0) b = Math.max(b, rho.radius[i] * (1 - t) + rho.radius[i1] * t - spec.thickness - rp);
                // The corners of the section are rounded in the radial direction only: with the
                // distance to the whole side figure the strap would narrow towards the tip of an arm
                const R = Rrow[i] * (1 - t) + Rrow[i1] * t;
                // depth below the outer face along rho': the distance to the contour (consistent with b)
                // over the cosine of its slope; near the tip of an arm the depth is large, no rounding
                const sl = side.rows.at(side.rows.slope, y);
                const tOut = Math.max(0, -b) * Math.sqrt(1 + sl * sl), tIn = side.inner.at(rp, y);
                return Math.max(b, P.grid.at(x, y) + Math.max(recess(tOut, R), recess(tIn, R)));
            }
        };
    }

    // Horizontal handle or lug: front polygon x band between two offsets of the wall
    function horizontalField(spec, scene, poly, bb, vessel) {
        const beta = spec.roundness;
        const xmin = Math.ceil(bb.x0), xmax = Math.floor(bb.x1);
        if (xmax - xmin < 3) return null;
        const plan = spec.plan && spec.plan.length ? spec.plan : defaultPlan(0.35 * (xmax - xmin));
        const N = xmax - xmin + 1;
        const dz = new Float32Array(N), hh = new Float32Array(N), thick = new Float32Array(N), Rr = new Float32Array(N);
        let sumW = 0, n = 0, dzMax = 0;
        for (let i = 0; i < N; i++) {
            const x = xmin + i;
            dz[i] = Math.max(0, planAt(plan, N > 1 ? i / (N - 1) : 0));
            dzMax = Math.max(dzMax, dz[i]);
            const spans = G().verticalSpans(x + 0.5, poly);
            hh[i] = spans.length ? (spans[spans.length - 1][1] - spans[0][0]) / 2 : 0;
            thick[i] = spec.thickness > 0 ? spec.thickness : Math.max(6, 1.2 * hh[i]);
            Rr[i] = Math.max(0.05, Math.min(beta * hh[i], hh[i], thick[i] / 2));
            if (hh[i] > 0) { sumW += 2 * hh[i]; n++; }
        }
        if (!n) return null;
        const meanW = sumW / n;
        const kFull = (('blend' in spec) ? spec.blend : 0.5) * (thick.reduce((a, v) => a + v, 0) / N) * BLEND_SCALE;
        const P = polygonGrid(poly, bb);
        const at = (arr, x) => {
            const f = clamp(x - xmin - 0.5, 0, N - 1), i = Math.floor(f), t = f - i;
            return arr[i] * (1 - t) + arr[Math.min(N - 1, i + 1)] * t;
        };
        const rMax = Math.max(...Array.from({ length: Math.ceil(bb.y1) - Math.floor(bb.y0) + 1 }, (_, i) => vessel.radiusAt(Math.floor(bb.y0) + i + 0.5)));
        const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
        return {
            axis: 'x', spec, bb, theta: Math.asin(clamp((cx - scene.axisX) / Math.max(1, vessel.radiusAt(cy)), -MAX_SIN, MAX_SIN)),
            meanW, yTop: bb.y0, yBot: bb.y1, xmin, xmax, plan,
            zTop: rMax + dzMax + 4, rhoMax: rMax + dzMax, halfU: (xmax - xmin) / 2,
            k: kFull, thick: thick.reduce((a, v) => a + v, 0) / N,
            kAt: (x, y) => taper(kFull, P.grid.at(x, y)),
            inside: (px, py) => {
                const i = Math.floor(px) - P.x0, j = Math.floor(py) - P.y0;
                return i >= 0 && j >= 0 && i < P.w && j < P.h && P.inside[j * P.w + i] === 1;
            },
            sdXY: (x, y) => P.grid.at(x, y),
            sd(x, y, z) {
                const dv = vessel.sd(x, y, z);
                const d = at(dz, x), b = at(thick, x);
                return roundedIntersection(P.grid.at(x, y), Math.max(dv - d, d - b - dv), at(Rr, x));
            }
        };
    }

    // The field of an applied part from what the drawing gives (null when it is not possible)
    function partField(spec, part, scene, vessel) {
        const poly = (spec.points || []).map(([x, y]) => ({ x, y }));
        if (poly.length < 3 || !scene.radius || scene.axisX === null) return null;
        const bb = G().bbox(poly);
        vessel = vessel || vesselField(scene);
        return spec.axis === 'x' ? horizontalField(spec, scene, poly, bb, vessel) : (part ? verticalField(spec, part, scene, poly, bb) : null);
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
        smin, share, vesselField, wallZ, planAt, defaultPlan, outerProfile, partField, unionOf, normalAt, quadMesh, BLEND_SCALE
    };
})();
