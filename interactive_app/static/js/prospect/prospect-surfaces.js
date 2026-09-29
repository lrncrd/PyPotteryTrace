// Prospect Canvas - front view of applied parts (handles, lugs)
//
// The surface of an applied part is not a solid apart from the vessel: prospect-field.js gives the
// smooth union of the wall and the part (the part from what the drawing gives of it: the traced front
// outline, the side view, the crest). Here that surface is looked at from the viewer of the drawing:
// each pixel is ray-marched along the view, and the normal is the gradient of the field, so the tone
// is that of the vessel (same light, same luminance range) and it flows from the wall into the part
// with no seam. The wall itself is modified where the part rises from it: `delta` is the change of
// luminance of the wall pixels around the part, and the part's own pixels (`mask`, inside the traced
// outline and in front of the wall) carry their own luminance. The shadow of the part falls on the wall.

(function () {
    const F = () => window.ProspectField;
    const G = () => window.ProspectGeometry;
    const S = () => window.ProspectShading;

    // Width proposed for a placed vertical handle: the thickness of its strap seen from the side
    function defaultWidth(part) {
        return Math.max(4, 2 * (S().edgeField(part.rings).dmax - 0.5));
    }

    const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

    // Raster of the front view: { x0, y0, w, h, mask, lum, delta, edges, meanW }. The raster covers the
    // outline of the part and the reach of its fillet; `edges` are the two side lines of the part.
    function buildFront(spec, part, scene, params, range) {
        const FD = F();
        const vessel = FD.vesselField(scene);
        const pf = FD.partField(spec, part, scene, vessel);
        if (!pf) return null;
        const union = (x, y, z) => FD.smin(vessel.sd(x, y, z), pf.sd(x, y, z), pf.kAt(x, y));
        // The shadow of the part on the wall (and on the fillet): soft shadow, marched towards the light
        // through the field of the part alone; its reach is a multiple of the thickness
        const strength = Math.min(0.95, 'shadow' in spec ? spec.shadow : 0.6);
        const reach = strength > 0 ? 1.6 * pf.thick + 10 : 0;
        const Lw = S().lightVector(params.direction, params.elevation);
        const m = Math.ceil(pf.k) + 3 + Math.ceil(reach * Math.hypot(Lw[0], Lw[1]));
        const bb = pf.bb;
        const x0 = Math.floor(bb.x0) - m, y0 = Math.floor(bb.y0) - m;
        const w = Math.ceil(bb.x1) - x0 + m + 1, h = Math.ceil(bb.y1) - y0 + m + 1;
        const L = Lw;
        const rg = range || S().referenceRange(params);
        const span = Math.max(1e-6, rg.hi - rg.lo);
        const bend = 'bend' in spec ? spec.bend : 0.5;
        const ax = scene.axisX;
        const mask = new Uint8Array(w * h), lum = new Float32Array(w * h), delta = new Float32Array(w * h);
        const shade = new Float32Array(w * h).fill(1);
        const shadowAt = (x, y, z) => {
            let res = 1, tm = 0, t = 2;
            for (let s = 0; s < 40 && t < reach; s++) {
                const d = pf.sd(x + L[0] * t, y + L[1] * t, z + L[2] * t);
                if (d < 0.1) { res = 0; tm = t; break; }
                const r = 6 * d / t;
                if (r < res) { res = r; tm = t; }
                if (res < 0.02) { res = 0; break; }
                t += Math.max(1, 0.8 * d);
            }
            // the shadow fades out towards the end of its reach
            const u = Math.min(1, Math.max(0, (tm - 0.4 * reach) / (0.6 * reach)));
            return 1 - (1 - res) * (1 - u * u * (3 - 2 * u));
        };
        // could the part be on the way to the light? (its outline, seen from the pixel)
        const maybeShadowed = (x, y) => {
            for (let i = 1; i <= 24; i++) {
                const t = reach * i / 24;
                if (pf.sdXY(x + L[0] * t, y + L[1] * t) < 6) return true;
            }
            return false;
        };
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const x = x0 + i + 0.5, y = y0 + j + 0.5;
                const wz = FD.wallZ(scene, x, y);
                // farther than the fillet from the outline: the wall, untouched (but for the shadow)
                if (pf.sdXY(x, y) > pf.k + 1) {
                    if (reach > 0 && wz > 0 && maybeShadowed(x, y)) shade[j * w + i] = 1 - strength * (1 - shadowAt(x, y, wz));
                    continue;
                }
                const zEnd = wz > 0 ? wz - 3 : -pf.zTop;
                let z = pf.zTop + pf.k + 2, hit = false;
                for (let s = 0; s < 60; s++) {
                    const d = union(x, y, z);
                    if (d < 0.03) { hit = true; break; }
                    z -= Math.max(0.25, 0.85 * d);
                    if (z < zEnd) break;
                }
                if (!hit) continue;
                const n = FD.normalAt(union, x, y, z);
                // the slope along a part is tempered by `bend` (a share of the part's, not of the wall's)
                const own = FD.share(vessel.sd(x, y, z), pf.sd(x, y, z), pf.kAt(x, y));
                n[1] *= 1 - own * (1 - bend);
                const nl = Math.hypot(n[0], n[1], n[2]) || 1;
                const v = (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / nl;
                // the wall behind, as the vessel shades it
                const r = vessel.radiusAt(y), dr = vessel.slopeAt(y), dx = x - ax;
                const zw = Math.max(Math.sqrt(Math.max(0, r * r - dx * dx)), 0.05 * r);
                const ny = -r * dr, wl = Math.sqrt(dx * dx + ny * ny + zw * zw) || 1;
                const vRef = (dx * L[0] + ny * L[1] + zw * L[2]) / wl;
                const k = j * w + i;
                lum[k] = clamp01((v - rg.lo) / span);
                delta[k] = (v - vRef) / span;
                if (reach > 0 && own < 0.35) shade[k] = 1 - strength * (1 - shadowAt(x, y, z));
                if (z - wz > 0.3 && pf.inside(x, y)) mask[k] = 1;
            }
        }
        // The contour: the traced outline itself, wherever the part stands out of the wall (a run of
        // it ends where the part merges into the wall)
        const edges = [];
        const at = (x, y) => {
            const i = Math.floor(x) - x0, j = Math.floor(y) - y0;
            return i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === 1;
        };
        const standsOut = (x, y) => at(x, y) || at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1);
        const poly = spec.points;
        let run = [], gap = [];   // (a gap of a few px in the contour is bridged)
        const flush = () => {
            if (run.length >= 3) { const pl = G().simplify(run, 0.4); pl.open = true; edges.push(pl); }
            run = [];
        };
        for (let i = 0; i < poly.length; i++) {
            const [ax0, ay0] = poly[i], [bx0, by0] = poly[(i + 1) % poly.length];
            const len = Math.hypot(bx0 - ax0, by0 - ay0), n = Math.max(1, Math.ceil(len));
            for (let t = 0; t <= n; t++) {
                const x = ax0 + (bx0 - ax0) * t / n, y = ay0 + (by0 - ay0) * t / n;
                if (standsOut(x, y)) { run.push(...gap, { x, y }); gap = []; }
                else if (run.length && gap.length < 20) gap.push({ x, y });
                else { gap = []; flush(); }
            }
        }
        flush();
        return { x0, y0, w, h, mask, lum, delta, shade, edges, meanW: pf.meanW };
    }

    // Add the fronts to the luminance field of the vessel: the field grows to hold them. The wall
    // pixels around a part take the change of luminance the part makes (`delta`); the pixels of the
    // part itself (`band`) are marked for the shadows.
    function compose(field, fronts) {
        const list = fronts.filter(Boolean);
        if (!list.length) return field;
        let X0 = field.x0, Y0 = field.y0, X1 = field.x0 + field.w, Y1 = field.y0 + field.h;
        for (const f of list) {
            X0 = Math.min(X0, f.x0); Y0 = Math.min(Y0, f.y0);
            X1 = Math.max(X1, f.x0 + f.w); Y1 = Math.max(Y1, f.y0 + f.h);
        }
        const w = X1 - X0, h = Y1 - Y0;
        const inside = new Uint8Array(w * h), lum = new Float32Array(w * h);
        const wall = new Uint8Array(w * h), band = new Uint8Array(w * h);
        for (let j = 0; j < field.h; j++) {
            for (let i = 0; i < field.w; i++) {
                const k = (field.y0 - Y0 + j) * w + (field.x0 - X0 + i);
                const s = j * field.w + i;
                if (field.inside[s]) { inside[k] = 1; wall[k] = 1; lum[k] = field.lum[s]; }
            }
        }
        for (const f of list) {
            for (let j = 0; j < f.h; j++) {
                for (let i = 0; i < f.w; i++) {
                    const s = j * f.w + i;
                    const k = (f.y0 - Y0 + j) * w + (f.x0 - X0 + i);
                    if (wall[k] && (f.delta[s] || f.shade[s] < 1)) lum[k] = clamp01((lum[k] + f.delta[s]) * f.shade[s]);
                    if (!f.mask[s]) continue;
                    // beyond the silhouette of the vessel the part has its own luminance
                    if (!wall[k]) lum[k] = f.lum[s] * f.shade[s];
                    inside[k] = 1; band[k] = 1;
                }
            }
        }
        return { x0: X0, y0: Y0, w, h, inside, lum, range: field.range, wall, band };
    }

    window.ProspectSurfaces = {
        outerProfile: (...a) => F().outerProfile(...a),
        planAt: (...a) => F().planAt(...a),
        defaultPlan: (...a) => F().defaultPlan(...a),
        wallZ: (...a) => F().wallZ(...a),
        buildFront, defaultWidth, compose
    };
})();
