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

    // The edge of the part where, inside its traced outline, it stands against the wall: the underside of a
    // strap seen over the lume. The sides between a pixel of the part and a pixel of the wall are joined into
    // polylines of the same kind as the runs of the outline ({ x, y, nx, ny, dz }, outward normal, height).
    function innerEdgeRuns(mask, zs, wzs, w, h, x0, y0, sc, inside) {
        const V = w + 1, edges = [], at = new Map();
        const add = (ax, ay, bx, by, nx, ny, dz) => {
            const id = edges.length, a = ay * V + ax, b = by * V + bx;
            edges.push({ a, b, ax, ay, bx, by, nx, ny, dz, used: false });
            for (const v of [a, b]) { if (!at.has(v)) at.set(v, []); at.get(v).push(id); }
        };
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const k = j * w + i;
                if (!mask[k]) continue;
                const dz = zs[k] - wzs[k];
                for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const ni = i + di, nj = j + dj;
                    if (ni < 0 || nj < 0 || ni >= w || nj >= h || mask[nj * w + ni] || !inside(x0 + (ni + 0.5) * sc, y0 + (nj + 0.5) * sc)) continue;
                    if (di) add(i + (di > 0 ? 1 : 0), j, i + (di > 0 ? 1 : 0), j + 1, di, 0, dz);
                    else add(i, j + (dj > 0 ? 1 : 0), i + 1, j + (dj > 0 ? 1 : 0), 0, dj, dz);
                }
            }
        }
        const point = (vx, vy, e) => ({ x: x0 + vx * sc, y: y0 + vy * sc, nx: e.nx, ny: e.ny, dz: e.dz });
        // walk from a vertex along the sides not used yet
        const walk = (from, out, forward) => {
            let v = from;
            for (;;) {
                const e = (at.get(v) || []).map(id => edges[id]).find(q => !q.used);
                if (!e) return v;
                e.used = true;
                const [vx, vy, nv] = e.a === v ? [e.bx, e.by, e.b] : [e.ax, e.ay, e.a];
                if (forward) out.push(point(vx, vy, e)); else out.unshift(point(vx, vy, e));
                v = nv;
            }
        };
        const runs = [];
        for (const e0 of edges) {
            if (e0.used) continue;
            e0.used = true;
            const pts = [point(e0.ax, e0.ay, e0), point(e0.bx, e0.by, e0)];
            const end = walk(e0.b, pts, true), start = walk(e0.a, pts, false);
            const run = G().simplify(pts, 0.8 * sc);
            if (G().polylineLength(run) < 16) continue;
            run.closed = end === start;
            runs.push(run);
        }
        return runs;
    }

    // Geometry of the front view, with no light in it (so a change of the light does not march again).
    // For every pixel of the raster: `hit` 0 = the wall beyond the reach of the fillet, 1 = near the
    // part but nothing hit, 2 = the surface, at depth `z` with normal `nrm` and share of the part `own`;
    // `wz` the depth of the wall; `mask` the part's own pixels (inside the traced outline and in front of
    // the wall); `runs` the stretches of the traced outline where the part stands out of the wall, with
    // their outward normals. The raster has one sample every `s` px: 1 for a small part, more for a large
    // one (about PART_SAMPLES samples over the part, at most MAX_SAMPLES in all with the room for its
    // shadow); `stride` 2 doubles it (a preview while dragging).
    const PART_SAMPLES = 60000, MAX_SAMPLES = 600000;

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
        const W = Math.ceil(bb.x1) - x0 + m + 1, H = Math.ceil(bb.y1) - y0 + m + 1;
        const sc = Math.max(1, Math.ceil(Math.sqrt((bb.x1 - bb.x0) * (bb.y1 - bb.y0) / PART_SAMPLES)), Math.ceil(Math.sqrt(W * H / MAX_SAMPLES))) * stride;
        const w = Math.ceil(W / sc), h = Math.ceil(H / sc);
        const hit = new Uint8Array(w * h), mask = new Uint8Array(w * h);
        const zs = new Float32Array(w * h), wzs = new Float32Array(w * h), own = new Float32Array(w * h);
        const nrm = new Float32Array(3 * w * h);
        const stepMax = Math.max(2, 0.5 * pf.thick);
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const x = x0 + (i + 0.5) * sc, y = y0 + (j + 0.5) * sc, k = j * w + i;
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
            const i = Math.floor((x - x0) / sc), j = Math.floor((y - y0) / sc);
            return i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === 1;
        };
        const standsOut = (x, y) => at(x, y) || at(x - sc, y) || at(x + sc, y) || at(x, y - sc) || at(x, y + sc);
        // how far the part stands out of the wall there (the weight of the contour follows it)
        const height = (x, y) => {
            const i = Math.floor((x - x0) / sc), j = Math.floor((y - y0) / sc), k = j * w + i;
            return i >= 0 && j >= 0 && i < w && j < h && mask[k] ? zs[k] - wzs[k] : 0;
        };
        // (a turned arch: what is seen from the front is its projection, not the polygon it was traced as)
        const poly = pf.outline || spec.points;
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
                const p = { x, y, nx, ny, dz: height(x - 2 * sc * nx, y - 2 * sc * ny) };
                if (standsOut(x - 2 * sc * nx, y - 2 * sc * ny)) {
                    if (!run.length) run.start = c;
                    run.push(...gap, p);
                    gap = [];
                } else if (run.length && gap.length < 40 * sc) gap.push(p);
                else { gap = []; flush(); }
            }
        }
        if (run.length && run.start === 0) {
            run.closed = true;              // the whole outline stands out
            runs.push(run);
        } else if (run.length && runs.length && runs[0].start === 0) {
            runs[0] = Object.assign(run.concat(gap, runs[0]), { start: run.start });   // the run goes on past the first vertex
        } else flush();
        // A strap with a lume: its underside is an edge too (a lug is solid, it has none); a part as drawn next
        // to the profile: its own edge, where it is smaller than the outline traced
        if (pf.axis === 'x' && (!pf.lug || pf.asDrawn)) runs.push(...innerEdgeRuns(mask, zs, wzs, w, h, x0, y0, sc, pf.inside));
        return { pf, vessel, x0, y0, w, h, s: sc, hit, mask, zs, wzs, own, nrm, runs, thick: pf.thick, meanW: pf.meanW };
    }

    // The front view under a light: { x0, y0, w, h, mask, lum, delta, shade, edges, meanW }. `edges` are
    // the contour runs, with a width per point (`w`, px of the drawing): heavier on the side away from
    // the light, fading out where the part enters the wall. `preview` 2 shades one sample in four.
    function shadeFront(geo, spec, scene, params, range, preview = 1) {
        const { pf, vessel, x0, y0, w, h, s: sc, hit, mask, zs, wzs, own, nrm } = geo;
        const stride = preview;
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
        // Depth of a hole: what lies deeper than its surroundings is darker, more so the nearer the rim is and the
        // higher it stands (an occlusion estimated from the depth around each point, 8 directions and 3 distances)
        const cavity = pf.axis === 'x' && pf.underPlan.length > 0 && !pf.rimLoop;
        const surf = q => (hit[q] === 2 ? zs[q] : wzs[q]);
        const occlusion = (i, j, k) => {
            const z0 = surf(k);
            let sum = 0;
            for (let a = 0; a < 8; a++) {
                const cx = Math.cos(a * Math.PI / 4), cy = Math.sin(a * Math.PI / 4);
                let best = 0;
                for (const d of [2, 5, 11]) {
                    const r = Math.max(1, Math.round(d / sc)), ii = Math.round(i + cx * r), jj = Math.round(j + cy * r);
                    if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
                    const q = jj * w + ii;
                    if (hit[q] === 0 || (hit[q] === 1 && !wzs[q])) continue;
                    best = Math.max(best, (surf(q) - z0) / (r * sc));
                }
                sum += Math.min(1, best);
            }
            return sum / 8;
        };
        for (let j = 0; j < h; j += stride) {
            for (let i = 0; i < w; i += stride) {
                const x = x0 + (i + 0.5) * sc, y = y0 + (j + 0.5) * sc, k = j * w + i;
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
                if (cavity) {
                    const ao = Math.min(1, 1.6 * occlusion(i, j, k));
                    if (mask[k]) lum[k] *= 1 - 0.85 * ao;
                    else shade[k] *= 1 - 0.85 * ao;
                }
            }
        }
        if (stride > 1) for (const a of [lum, delta, shade]) spread(a, w, h, stride);
        // The opening of a closed hole, where the hole really is (the front is an elevation: a vertical hole has no other
        // trace), as a flattened ellipse on the face of the strap that looks at the viewer (seen a little from above),
        // dark inside. Turned over, the lower face is the one that looks at the viewer. The opening on the other face
        // is only seen through the first one: its rim where it lies inside it.
        const rimEdges = [];
        if (pf.rimLoop) {
            const SIN_E = 0.4, cF = Math.cos(pf.phi), sF = Math.sin(pf.phi);
            const top = SIN_E * cF - 0.92 * sF >= 0;
            const ringOf = isTop => {
                const pts = pf.rimLoop(!isTop).map(([x, r]) => {
                    const fr = pf.frameAt(x), u = (isTop ? -1 : 1) * 0.85 * fr.hw;
                    return { x, p: fr.cy + u * cF - r * sF, dv: u * sF + r * cF };
                });
                const dvMean = pts.reduce((a, q) => a + q.dv, 0) / pts.length;
                return pts.map(q => ({ x: q.x, y: q.p + (q.dv - dvMean) * SIN_E }));
            };
            const ring = ringOf(top), bb = G().bbox(ring), ySpan = Math.max(1e-3, bb.y1 - bb.y0);
            for (let j = Math.max(0, Math.floor((bb.y0 - y0) / sc)); j < Math.min(h, Math.ceil((bb.y1 - y0) / sc)); j++) {
                for (let i = Math.max(0, Math.floor((bb.x0 - x0) / sc)); i < Math.min(w, Math.ceil((bb.x1 - x0) / sc)); i++) {
                    const k = j * w + i, x = x0 + (i + 0.5) * sc, y = y0 + (j + 0.5) * sc;
                    if (hit[k] !== 2 || !G().pointInPolygon(x, y, ring)) continue;
                    // (darkest on the far wall, at the top)
                    lum[k] *= 0.15 + 0.4 * (y - bb.y0) / ySpan;
                    mask[k] = 1;
                }
            }
            const edge = ring.map(q => ({ x: q.x, y: q.y }));
            edge.open = false;
            edge.w = ring.map(q => 0.6 + 1.1 * (1 - (q.y - bb.y0) / ySpan));
            rimEdges.push(edge);
            // the other opening, seen through this one
            let run = [];
            const flush = () => {
                if (run.length >= 3) { const e = run.map(q => ({ x: q.x, y: q.y })); e.open = true; e.w = run.map(() => 0.6); rimEdges.push(e); }
                run = [];
            };
            for (const q of ringOf(!top)) { if (G().pointInPolygon(q.x, q.y, ring)) run.push(q); else flush(); }
            flush();
        }
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
        edges.push(...rimEdges);
        return { x0, y0, w, h, s: sc, mask, lum, delta, shade, edges, meanW: geo.meanW, inside: pf.inside };
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
            X1 = Math.max(X1, f.x0 + f.w * f.s); Y1 = Math.max(Y1, f.y0 + f.h * f.s);
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
            const fs = f.s, FW = f.w * fs, FH = f.h * fs;
            // (a coarse raster: the change of the wall and the shadow are interpolated between its samples)
            const lerp = (a, u, v) => {
                const fu = Math.min(f.w - 1, Math.max(0, u)), fv = Math.min(f.h - 1, Math.max(0, v));
                const i = Math.min(f.w - 2, Math.floor(fu)), j = Math.min(f.h - 2, Math.floor(fv));
                if (i < 0 || j < 0) return a[Math.round(fv) * f.w + Math.round(fu)];
                const tu = fu - i, tv = fv - j, q = j * f.w + i;
                return (a[q] * (1 - tu) + a[q + 1] * tu) * (1 - tv) + (a[q + f.w] * (1 - tu) + a[q + f.w + 1] * tu) * tv;
            };
            for (let J = 0; J < FH; J++) {
                const v = (J + 0.5) / fs - 0.5, sj = Math.floor(J / fs);
                for (let I = 0; I < FW; I++) {
                    const s = sj * f.w + Math.floor(I / fs);
                    const k = (f.y0 - Y0 + J) * w + (f.x0 - X0 + I);
                    if (wall[k]) {
                        const u = (I + 0.5) / fs - 0.5;
                        const dl = fs > 1 ? lerp(f.delta, u, v) : f.delta[s], sd = fs > 1 ? lerp(f.shade, u, v) : f.shade[s];
                        if (dl || sd < 1) lum[k] = clamp01((lum[k] + dl) * sd);
                    }
                    // (on a coarse raster the traced outline, not the block, is the edge of the part)
                    if (!f.mask[s] || (fs > 1 && !f.inside(f.x0 + I + 0.5, f.y0 + J + 0.5))) continue;
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
