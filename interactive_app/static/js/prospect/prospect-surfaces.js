// Prospect Canvas - front view of applied parts (handles)
//
// A handle is drawn in the section as a side view (its silhouette, in the Handle layer). Seen from
// the front it is a band. The user outlines it on the original drawing (a polygon of tapped
// points: its two ends and its sides, so it may be asymmetric); the side view gives what the
// outline cannot: how far the handle stands out of the vessel at every height, rho_out(y), the
// distance from the axis of the outermost point of its outer contour.
//
// On each row y the band spans [xl, xr] (the polygon), its middle is c = (xl + xr) / 2 and its
// width W = xr - xl. The middle of the band lies at azimuth theta(y) = asin((c - axis) / rho_out(y)),
// and across the band, u in [-w/2, w/2] with w = W / cos(theta),
//     x = axis + rho_out(y) sin(theta) + u cos(theta)
//     z = (rho_out(y) - depth(u)) cos(theta) - u sin(theta)
// where depth(u) is the recession of the cross-section towards the edges (a rod or a strap with
// rounded edges). The outer surface F = rho - rho_out(y) + depth(u) = 0 has normal
// (1, -rho_out'(y), depth'(u)) in (rho, y, u), turned into the view frame. It is shaded like the
// vessel (same light, same luminance range), and hidden where it is inside the wall (z below the
// wall of the vessel): it joins the wall there, with no line.

(function () {
    const G = () => window.ProspectGeometry;
    const S = () => window.ProspectShading;

    const MAX_SIN = 0.97;

    // Recession depth(u) of the surface at distance u from the middle of a band of the given
    // width, and its slope. roundness 1 = a round rod (circular section of radius w/2), small = a
    // flat strap whose edges are rounded on a radius roundness * w/2
    function section(width, roundness) {
        const h = width / 2;
        const b = Math.max(0.5, Math.min(1, roundness) * h);
        const flat = h - b;
        return {
            depth(u) {
                const t = Math.abs(u) - flat;
                return t <= 0 ? 0 : b - Math.sqrt(Math.max(0, b * b - t * t));
            },
            slope(u) {
                const t = Math.abs(u) - flat;
                if (t <= 0) return 0;
                return Math.sign(u) * Math.min(12, t / Math.sqrt(Math.max(1e-3, b * b - t * t)));
            }
        };
    }

    // rho_out(y) of a part (side view), per image row
    function outerProfile(part, axisX, height) {
        return G().radiusByRow([G().edgeLine(part.outline)], axisX, height, false);
    }

    // Raster of the front view: { x0, y0, w, h, mask, lum, edges, meanW }. `edges` are the two side
    // lines of the band (open polylines) over the rows where it stands out of the wall.
    function buildFront(spec, part, scene, params, range) {
        const poly = (spec.points || []).map(([x, y]) => ({ x, y }));
        if (poly.length < 3) return null;
        const axisX = scene.axisX;
        const wall = scene.radius;
        const rho = outerProfile(part, axisX, wall.radius.length);
        if (!rho) return null;
        const bend = 'bend' in spec ? spec.bend : 0.5;
        const L = S().lightVector(params.direction, params.elevation);
        const rg = range || S().referenceRange(params);
        const span = Math.max(1e-6, rg.hi - rg.lo);
        const bb = G().bbox(poly);
        const yTop = Math.max(rho.y0, Math.ceil(bb.y0)), yBot = Math.min(rho.y1, Math.floor(bb.y1));
        if (yBot <= yTop) return null;

        // The band on every row
        const rows = new Map();
        let sumW = 0;
        for (let y = yTop; y <= yBot; y++) {
            const p = rho.radius[y];
            if (p <= 0.5) continue;
            const spans = G().horizontalSpans(y + 0.5, poly);
            if (!spans.length) continue;
            const xl = spans[0][0], xr = spans[spans.length - 1][1];
            if (xr - xl < 1) continue;
            const sinT = Math.max(-MAX_SIN, Math.min(MAX_SIN, ((xl + xr) / 2 - axisX) / p));
            const cosT = Math.sqrt(1 - sinT * sinT);
            const hw = (xr - xl) / (2 * cosT);
            rows.set(y, { p, dp: rho.dr[y] * bend, xl, xr, sinT, cosT, hw, xc: axisX + p * sinT, sec: section(2 * hw, spec.roundness) });
            sumW += xr - xl;
        }
        if (!rows.size) return null;

        // How far the band stands out of the wall at a point (px, towards the viewer)
        const elevation = (x, y, u, r) => {
            const zh = (r.p - r.sec.depth(u)) * r.cosT - u * r.sinT;
            const wr = wall.radius[Math.min(wall.radius.length - 1, y)];
            const dx = x - axisX;
            return zh - Math.sqrt(Math.max(0, wr * wr - dx * dx));
        };
        // The band shows where it is in front of the wall
        const front = (x, y, u, r) => elevation(x, y, u, r) > 0.3;

        // A handle joins the vessel gradually: its tone fades into that of the wall where it
        // barely stands out of it, and towards the two ends that were outlined
        const meanW = sumW / rows.size;
        const blendLen = Math.max(1, ('blend' in spec ? spec.blend : 0.5) * 0.7 * meanW);
        const smooth = t => t * t * (3 - 2 * t);

        const x0 = Math.floor(bb.x0) - 2, y0 = yTop;
        const w = Math.ceil(bb.x1) - x0 + 3, h = yBot - yTop + 1;
        const mask = new Uint8Array(w * h);
        const lum = new Float32Array(w * h);
        const weight = new Float32Array(w * h);
        for (const [y, r] of rows) {
            const j = y - y0;
            for (let i = 0; i < w; i++) {
                const x = x0 + i;
                if (x < r.xl - 0.5 || x > r.xr + 0.5) continue;
                const u = (x - r.xc) / r.cosT;
                const e = elevation(x, y, u, r);
                if (e <= 0.3) continue;
                const nu = r.sec.slope(u);
                const nx = r.sinT + nu * r.cosT, ny = -r.dp, nz = r.cosT - nu * r.sinT;
                const v = (nx * L[0] + ny * L[1] + nz * L[2]) / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
                mask[j * w + i] = 1;
                lum[j * w + i] = Math.min(1, Math.max(0, (v - rg.lo) / span));
                weight[j * w + i] = smooth(Math.min(1, e / blendLen)) * smooth(Math.min(1, Math.min(y - yTop, yBot - y) / blendLen));
            }
        }

        // The two side lines, where the band stands out of the wall
        const runs = { left: [[]], right: [[]] };
        for (let y = yTop; y <= yBot; y++) {
            const r = rows.get(y);
            for (const side of ['left', 'right']) {
                const list = runs[side];
                const xe = r ? (side === 'left' ? r.xl : r.xr) : 0;
                if (r && front(xe, y, (xe - r.xc) / r.cosT, r)) list[list.length - 1].push({ x: xe, y: y + 0.5 });
                else if (list[list.length - 1].length) list.push([]);
            }
        }
        const edges = [];
        for (const side of ['left', 'right']) {
            for (const run of runs[side]) {
                if (run.length < 3) continue;
                const smooth = G().smoothPolyline(run, 2);
                smooth.open = true;
                edges.push(smooth);
            }
        }
        return { x0, y0, w, h, mask, lum, weight, edges, meanW };
    }

    // Add the fronts to the luminance field of the vessel: the field grows to hold them, the
    // pixels of the bands take their own luminance. `wall` keeps the vessel's own pixels.
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
                    if (!f.mask[s]) continue;
                    const k = (f.y0 - Y0 + j) * w + (f.x0 - X0 + i);
                    // on the vessel the tone of the band is mixed with that of the wall under it
                    lum[k] = wall[k] ? lum[k] + (f.lum[s] - lum[k]) * f.weight[s] : f.lum[s];
                    inside[k] = 1; band[k] = 1;
                }
            }
        }
        return { x0: X0, y0: Y0, w, h, inside, lum, range: field.range, wall, band };
    }

    // Shadow the bands cast on the wall: the mask of each band is swept away from the light over
    // `len` px, fading out, and raises the density of the wall pixels it reaches
    function castShadows(field, specs, light2d) {
        if (!field.band) return;
        const boost = new Float32Array(field.w * field.h);
        let any = false;
        for (const spec of specs) {
            if (!spec.front) continue;
            const len = Math.round(spec.shadow * 0.6 * spec.front.meanW);
            if (len < 1) continue;
            any = true;
            const dx = -light2d.x, dy = -light2d.y;
            const f = spec.front;
            // Wall pixels within reach of the band's box
            const bx0 = Math.max(0, f.x0 - field.x0 - len - 1), bx1 = Math.min(field.w, f.x0 - field.x0 + f.w + len + 1);
            const by0 = Math.max(0, f.y0 - field.y0 - len - 1), by1 = Math.min(field.h, f.y0 - field.y0 + f.h + len + 1);
            for (let j = by0; j < by1; j++) {
                for (let i = bx0; i < bx1; i++) {
                    const k = j * field.w + i;
                    if (!field.wall[k] || field.band[k]) continue;
                    let best = 0;
                    for (let s = 1; s <= len && best < 1; s++) {
                        const si = Math.round(i - dx * s), sj = Math.round(j - dy * s);
                        if (si < 0 || sj < 0 || si >= field.w || sj >= field.h) break;
                        const sk = sj * field.w + si;
                        if (field.band[sk]) { best = Math.pow(1 - s / (len + 1), 2); break; }
                    }
                    if (best > 0) boost[k] = Math.max(boost[k], 0.6 * best);
                }
            }
        }
        field.boost = any ? boost : null;
    }

    window.ProspectSurfaces = { section, outerProfile, buildFront, compose, castShadows };
})();
