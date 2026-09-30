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

    // Copy the computed pixel of every stride x stride block into the rest of the block (c values per pixel)
    function spread(a, w, h, stride, c = 1) {
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                if (j % stride === 0 && i % stride === 0) continue;
                const src = ((j - j % stride) * w + i - i % stride) * c, dst = (j * w + i) * c;
                for (let q = 0; q < c; q++) a[dst + q] = a[src + q];
            }
        }
    }

    // Geometry of the front view, with no light in it (so a change of the light does not march again).
    // For every pixel of the raster: `hit` 0 = the wall beyond the reach of the fillet, 1 = near the
    // part but nothing hit, 2 = the surface, at depth `z` with normal `nrm` and share of the part `own`;
    // `wz` the depth of the wall; `mask` the part's own pixels (inside the traced outline and in front of
    // the wall); `runs` the stretches of the traced outline where the part stands out of the wall, with
    // their outward normals. `stride` 2 computes one pixel in four (a preview while dragging).
    function frontGeometry(spec, part, scene, stride = 1) {
        const FD = F();
        const vessel = FD.vesselField(scene);
        const pf = FD.partField(spec, part, scene, vessel);
        if (!pf) return null;
        const union = (x, y, z) => FD.smin(vessel.sd(x, y, z), pf.sd(x, y, z), pf.kAt(x, y));
        // the raster holds the longest shadow the part can cast (light grazing the drawing)
        const m = Math.ceil(pf.k) + 3 + Math.ceil(1.6 * pf.thick + 10);
        const bb = pf.bb;
        const x0 = Math.floor(bb.x0) - m, y0 = Math.floor(bb.y0) - m;
        const w = Math.ceil(bb.x1) - x0 + m + 1, h = Math.ceil(bb.y1) - y0 + m + 1;
        const hit = new Uint8Array(w * h), mask = new Uint8Array(w * h);
        const zs = new Float32Array(w * h), wzs = new Float32Array(w * h), own = new Float32Array(w * h);
        const nrm = new Float32Array(3 * w * h);
        const stepMax = Math.max(2, 0.5 * pf.thick);
        for (let j = 0; j < h; j += stride) {
            for (let i = 0; i < w; i += stride) {
                const x = x0 + i + 0.5, y = y0 + j + 0.5, k = j * w + i;
                const wz = FD.wallZ(scene, x, y);
                wzs[k] = wz;
                // farther than the fillet from the outline: the wall, untouched (but for the shadow)
                if (pf.sdXY(x, y) > pf.k + 1) continue;
                hit[k] = 1;
                const zEnd = wz > 0 ? wz - 3 : -pf.zTop;
                let z = pf.zTop + pf.k + 2, zOut = z, found = false;
                // Steps of at least 1 px (a ray grazing the side of the part would crawl along it and stop
                // short) and at most half the thickness (the field overestimates the distance near the
                // rounded face, the step must not cross the part); the step that crosses the surface is
                // then halved down to it
                for (let s = 0; s < 80; s++) {
                    const d = union(x, y, z);
                    if (d < 0.03) { found = true; break; }
                    zOut = z;
                    z -= Math.max(1, Math.min(0.85 * d, stepMax));
                    if (z < zEnd) break;
                }
                if (!found) continue;
                for (let s = 0; s < 6 && zOut - z > 0.1; s++) {
                    const zm = (z + zOut) / 2;
                    if (union(x, y, zm) < 0.03) z = zm; else zOut = zm;
                }
                const n = FD.normalAt(union, x, y, z);
                hit[k] = 2; zs[k] = z;
                nrm[3 * k] = n[0]; nrm[3 * k + 1] = n[1]; nrm[3 * k + 2] = n[2];
                own[k] = FD.share(vessel.sd(x, y, z), pf.sd(x, y, z), pf.kAt(x, y));
                if (z - wz > 0.3 && pf.inside(x, y)) mask[k] = 1;
            }
        }
        if (stride > 1) {
            for (const a of [hit, mask, zs, wzs, own]) spread(a, w, h, stride);
            spread(nrm, w, h, stride, 3);
        }
        // The normals of the part averaged over 3 x 3 px: where the face of the section meets its rounded
        // side the field has a crease, and the gradient there spikes on single pixels (a seam of dots)
        const sm = Float32Array.from(nrm);
        for (let j = 1; j < h - 1; j++) {
            for (let i = 1; i < w - 1; i++) {
                const k = j * w + i;
                if (!mask[k]) continue;
                let a = 0, b = 0, c = 0;
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        const q = k + dj * w + di;
                        if (mask[q]) { a += nrm[3 * q]; b += nrm[3 * q + 1]; c += nrm[3 * q + 2]; }
                    }
                }
                const l = Math.hypot(a, b, c) || 1;
                sm[3 * k] = a / l; sm[3 * k + 1] = b / l; sm[3 * k + 2] = c / l;
            }
        }
        nrm.set(sm);
        // The contour: the traced outline itself, wherever the part stands out of the wall (a run of
        // it ends where the part merges into the wall). It is tested 2 px inside the outline: on the
        // outline itself the rounded side of the section recedes and the run would break.
        const at = (x, y) => {
            const i = Math.floor(x) - x0, j = Math.floor(y) - y0;
            return i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === 1;
        };
        const standsOut = (x, y) => at(x, y) || at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1);
        // how far the part stands out of the wall there (the weight of the contour follows it)
        const height = (x, y) => {
            const i = Math.floor(x) - x0, j = Math.floor(y) - y0, k = j * w + i;
            return i >= 0 && j >= 0 && i < w && j < h && mask[k] ? zs[k] - wzs[k] : 0;
        };
        const poly = spec.points;
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
            const [ax0, ay0] = poly[i], [bx0, by0] = poly[(i + 1) % poly.length];
            area += ax0 * by0 - bx0 * ay0;
        }
        const orient = area > 0 ? 1 : -1;   // outward normal of a side a -> b: orient * (dy, -dx)
        const runs = [];
        let run = [], gap = [], c = 0;      // (a gap of a few px in the contour is bridged)
        const flush = () => { if (run.length >= 3) runs.push(run); run = []; };
        for (let i = 0; i < poly.length; i++) {
            const [ax0, ay0] = poly[i], [bx0, by0] = poly[(i + 1) % poly.length];
            const len = Math.hypot(bx0 - ax0, by0 - ay0), n = Math.max(1, Math.ceil(len));
            const nx = orient * (by0 - ay0) / (len || 1), ny = -orient * (bx0 - ax0) / (len || 1);
            for (let t = 0; t < n; t++, c++) {
                const x = ax0 + (bx0 - ax0) * t / n, y = ay0 + (by0 - ay0) * t / n;
                const p = { x, y, nx, ny, dz: height(x - 2 * nx, y - 2 * ny) };
                if (standsOut(x - 2 * nx, y - 2 * ny)) {
                    if (!run.length) run.start = c;
                    run.push(...gap, p);
                    gap = [];
                } else if (run.length && gap.length < 40) gap.push(p);
                else { gap = []; flush(); }
            }
        }
        if (run.length && run.start === 0) {
            run.closed = true;              // the whole outline stands out
            runs.push(run);
        } else if (run.length && runs.length && runs[0].start === 0) {
            runs[0] = Object.assign(run.concat(gap, runs[0]), { start: run.start });   // the run goes on past the first vertex
        } else flush();
        return { pf, vessel, x0, y0, w, h, stride, hit, mask, zs, wzs, own, nrm, runs, thick: pf.thick, meanW: pf.meanW };
    }

    // The front view under a light: { x0, y0, w, h, mask, lum, delta, shade, edges, meanW }. `edges` are
    // the contour runs, with a width per point (`w`, px of the drawing): heavier on the side away from
    // the light, fading out where the part enters the wall. `preview` 2 shades one pixel in four.
    function shadeFront(geo, spec, scene, params, range, preview = 1) {
        const { pf, vessel, x0, y0, w, h, hit, mask, zs, wzs, own, nrm } = geo;
        const stride = Math.max(geo.stride, preview);
        // The shadow of the part on the wall (and on the fillet): soft shadow, marched towards the light
        // through the field of the part alone; its reach is a multiple of the thickness
        const strength = Math.min(0.95, 'shadow' in spec ? spec.shadow : 0.6);
        const reach = strength > 0 ? 1.6 * pf.thick + 10 : 0;
        const L = S().lightVector(params.direction, params.elevation);
        const rg = range || S().referenceRange(params);
        const span = Math.max(1e-6, rg.hi - rg.lo);
        const bend = 'bend' in spec ? spec.bend : 0.5;
        const ax = scene.axisX;
        const lum = new Float32Array(w * h), delta = new Float32Array(w * h);
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
        for (let j = 0; j < h; j += stride) {
            for (let i = 0; i < w; i += stride) {
                const x = x0 + i + 0.5, y = y0 + j + 0.5, k = j * w + i;
                if (hit[k] === 0) {
                    if (reach > 0 && wzs[k] > 0 && maybeShadowed(x, y)) shade[k] = 1 - strength * (1 - shadowAt(x, y, wzs[k]));
                    continue;
                }
                if (hit[k] === 1) continue;
                // the slope along a part is tempered by `bend` (a share of the part's, not of the wall's)
                const n0 = nrm[3 * k], n1 = nrm[3 * k + 1] * (1 - own[k] * (1 - bend)), n2 = nrm[3 * k + 2];
                const nl = Math.hypot(n0, n1, n2) || 1;
                const v = (n0 * L[0] + n1 * L[1] + n2 * L[2]) / nl;
                // the wall behind, as the vessel shades it
                const r = vessel.radiusAt(y), dr = vessel.slopeAt(y), dx = x - ax;
                const zw = Math.max(Math.sqrt(Math.max(0, r * r - dx * dx)), 0.05 * r);
                const ny = -r * dr, wl = Math.sqrt(dx * dx + ny * ny + zw * zw) || 1;
                const vRef = (dx * L[0] + ny * L[1] + zw * L[2]) / wl;
                lum[k] = clamp01((v - rg.lo) / span);
                delta[k] = (v - vRef) / span;
                if (reach > 0 && own[k] < 0.35) shade[k] = 1 - strength * (1 - shadowAt(x, y, zs[k]));
            }
        }
        if (stride > 1) for (const a of [lum, delta, shade]) spread(a, w, h, stride);
        // Contour weight: 0.6 px on the lit side to 1.8 px on the side away from the light, thinning
        // down where the part comes close to the wall (at its roots the drawing has no edge)
        const lxy = Math.hypot(L[0], L[1]) || 1;
        const smooth = t => t * t * (3 - 2 * t);
        const edges = geo.runs.map(run => {
            const pts = run.filter((p, i) => i % 2 === 0 || i === run.length - 1);
            const s = [0];
            for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
            const total = s[s.length - 1], fade = Math.max(1, Math.min(24, 0.25 * total));
            const edge = pts.map(p => ({ x: p.x, y: p.y }));
            edge.open = !run.closed;
            edge.w = pts.map((p, i) => {
                const dark = clamp01(-(p.nx * L[0] + p.ny * L[1]) / lxy);
                const f = run.closed ? 1 : clamp01(Math.min(s[i], total - s[i]) / fade);
                return (0.6 + 1.2 * dark) * smooth(f) * smooth(clamp01(p.dz / (0.35 * geo.thick)));
            });
            return edge;
        });
        return { x0, y0, w, h, mask, lum, delta, shade, edges, meanW: geo.meanW };
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
        frontGeometry, shadeFront, defaultWidth, compose
    };
})();
