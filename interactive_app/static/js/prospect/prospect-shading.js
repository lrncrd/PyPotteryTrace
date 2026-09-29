// Prospect Canvas - shading generated from the profile revolved around the symmetry axis
//
// The profile gives the radius r(y); every point of the prospect lies on the surface of
// revolution dx^2 + z^2 = r(y)^2 (dx measured from the axis), whose normal is
// (dx, -r r'(y), z). Lambert lighting gives a luminance; the shading density is high where
// the surface faces away from the light. The density is rendered either as stippling
// (error-diffusion dots, blue-noise like) or as a continuous grey tone.

(function () {
    const G = () => window.ProspectGeometry;

    // Light direction from a clock angle (0 = from the top, clockwise) and an elevation above
    // the drawing plane, in degrees. x right, y down, z towards the viewer.
    function lightVector(direction, elevation) {
        const a = direction * Math.PI / 180, e = elevation * Math.PI / 180;
        return [Math.cos(e) * Math.sin(a), -Math.cos(e) * Math.cos(a), Math.sin(e)];
    }

    const mulberry32 = seed => G().mulberry32(seed);

    // Rings of a prospect: a list of polygons, a single polygon or nothing
    function asRings(outline) {
        if (!outline) return null;
        return Array.isArray(outline[0]) ? outline : [outline];
    }

    function ringsPath(ctx, rings, dx = 0, dy = 0) {
        ctx.beginPath();
        for (const ring of rings) {
            ring.forEach((p, i) => (i ? ctx.lineTo(p.x - dx, p.y - dy) : ctx.moveTo(p.x - dx, p.y - dy)));
            ctx.closePath();
        }
    }

    // Inside mask of the rings (even-odd, so a hole stays out) over their bounding box, plus `pad` px
    function rasterizeRings(rings, pad = 0) {
        const b = G().bbox(rings.flat());
        const x0 = Math.floor(b.x0) - pad, y0 = Math.floor(b.y0) - pad;
        const w = Math.ceil(b.x1) - x0 + 1 + pad, h = Math.ceil(b.y1) - y0 + 1 + pad;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ringsPath(ctx, rings, x0, y0);
        ctx.fillStyle = '#000';
        ctx.fill('evenodd');
        const data = ctx.getImageData(0, 0, w, h).data;
        const inside = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) inside[i] = data[i * 4 + 3] > 127 ? 1 : 0;
        return { x0, y0, w, h, inside };
    }

    // Percentile range of a luminance histogram
    function histRange(hist, count, bins) {
        const pct = q => {
            const target = q * count;
            let acc = 0;
            for (let b = 0; b < bins; b++) {
                acc += hist[b];
                if (acc >= target) return (b + 0.5) / bins * 2 - 1;
            }
            return 1;
        };
        return { lo: pct(0.01), hi: pct(0.99) };
    }

    // Luminance range of a plain cylinder facing the viewer: the scale of an applied part when
    // there is no vessel to take it from
    function referenceRange(params) {
        const L = lightVector(params.direction, params.elevation);
        const bins = 2048, hist = new Uint32Array(bins);
        const n = 800;
        for (let i = 0; i < n; i++) {
            const dx = -1 + 2 * (i + 0.5) / n;
            const z = Math.max(Math.sqrt(1 - dx * dx), 0.05);
            const v = (dx * L[0] + z * L[2]) / Math.hypot(dx, z);
            hist[Math.min(bins - 1, Math.max(0, Math.floor((v + 1) / 2 * bins)))]++;
        }
        return histRange(hist, n, bins);
    }

    // Normalized luminance (0 = darkest, 1 = brightest) of every pixel of the vessel: a surface
    // of revolution around the axis, normal (dx, -r r', z). The 1st-99th percentile of the
    // prospect map to 0..1. Depends only on the geometry and the light.
    function computeLuminance(outline, radiusInfo, axisX, params) {
        const m = rasterizeRings(asRings(outline));
        const { x0, y0, w, h, inside } = m;
        const L = lightVector(params.direction, params.elevation);
        const lum = new Float32Array(w * h);
        const bins = 2048;
        const hist = new Uint32Array(bins);
        let count = 0;
        const { radius, dr } = radiusInfo;
        for (let j = 0; j < h; j++) {
            const y = Math.min(radius.length - 1, Math.max(0, y0 + j));
            const r = radius[y];
            const ny = -r * dr[y];
            for (let i = 0; i < w; i++) {
                const k = j * w + i;
                if (!inside[k]) continue;
                const dx = x0 + i - axisX;
                // Outside the revolved shape the surface is taken as grazing
                const z = Math.max(Math.sqrt(Math.max(0, r * r - dx * dx)), 0.05 * r);
                const n = Math.sqrt(dx * dx + ny * ny + z * z) || 1;
                const v = (dx * L[0] + ny * L[1] + z * L[2]) / n;
                lum[k] = v;
                hist[Math.min(bins - 1, Math.max(0, Math.floor((v + 1) / 2 * bins)))]++;
                count++;
            }
        }
        const range = histRange(hist, count, bins);
        const span = Math.max(1e-6, range.hi - range.lo);
        for (let k = 0; k < w * h; k++) {
            if (inside[k]) lum[k] = Math.min(1, Math.max(0, (lum[k] - range.lo) / span));
        }
        return { x0, y0, w, h, inside, lum, range };
    }

    // Separable box blur of a w x h float field (window 2r+1, edges clamped)
    function boxBlur(f, w, h, r) {
        const tmp = new Float64Array(w * h), out = new Float64Array(w * h);
        const n = 2 * r + 1;
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                let acc = 0;
                for (let k = -r; k <= r; k++) acc += f[j * w + Math.min(w - 1, Math.max(0, i + k))];
                tmp[j * w + i] = acc / n;
            }
        }
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                let acc = 0;
                for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, j + k)) * w + i];
                out[j * w + i] = acc / n;
            }
        }
        return out;
    }

    // Side view of an applied part (a handle seen from the side): the silhouette is inflated into a
    // rounded strap. The height grows with the distance d from the edge (the hole included)
    // along a circular arc of width b = bevel * (largest inscribed radius):
    //   H(d) = relief * b * sqrt(1 - (1 - d/b)^2),  flat beyond b.
    // Its normal is (-H' grad d, 1); bevel 1 is a round rod, a small bevel a flat strap with
    // rounded edges. The luminance uses the scale (range) of the vessel, so the tone matches.
    // Silhouette of a part with, for every pixel, its distance to the drawn edges only: the
    // closing line of an open outline is where the part joins the vessel, not an edge
    function edgeField(rings, pad = 2) {
        const m = rasterizeRings(asRings(rings), pad);
        const { x0, y0, w, h, inside } = m;
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.strokeStyle = '#000';
        cx.lineWidth = 2;
        for (const ring of asRings(rings)) {
            cx.beginPath();
            G().edgeLine(ring).forEach((p, i) => (i ? cx.lineTo(p.x - x0, p.y - y0) : cx.moveTo(p.x - x0, p.y - y0)));
            if (!ring.open) cx.closePath();
            cx.stroke();
        }
        const src = cx.getImageData(0, 0, w, h).data;
        const free = new Uint8Array(w * h);
        for (let k = 0; k < w * h; k++) free[k] = src[k * 4 + 3] > 40 ? 0 : 1;
        // Smoothed: the raster edge is quantized, and its gradient would streak the shading
        const dist = boxBlur(boxBlur(G().distanceTransform(free, w, h), w, h, 2), w, h, 2);
        // Largest inscribed radius (98th percentile: a few far pixels must not round the whole strap)
        const ds = [];
        for (let k = 0; k < w * h; k++) if (inside[k]) ds.push(dist[k]);
        ds.sort((p, q) => p - q);
        const dmax = ds.length ? ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.98))] : 1;
        return { x0, y0, w, h, inside, dist, dmax };
    }

    function computeInflateLuminance(rings, surface, params, range) {
        const { x0, y0, w, h, inside, dist, dmax } = edgeField(rings);
        const b = Math.max(1, surface.bevel * (dmax - 0.5));
        const L = lightVector(params.direction, params.elevation);
        const rg = range || referenceRange(params);
        const span = Math.max(1e-6, rg.hi - rg.lo);
        const lum = new Float32Array(w * h);
        const at = (i, j) => dist[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const k = j * w + i;
                if (!inside[k]) continue;
                const d = dist[k] - 0.5;
                let nx = 0, ny = 0, nz = 1;
                if (d < b) {
                    const t = 1 - Math.max(0, d) / b;
                    const s = Math.min(25, surface.relief * t / Math.sqrt(Math.max(1e-4, 1 - t * t)));
                    let gx = at(i + 1, j) - at(i - 1, j), gy = at(i, j + 1) - at(i, j - 1);
                    const gl = Math.hypot(gx, gy);
                    if (gl > 1e-6) { gx /= gl; gy /= gl; } else { gx = gy = 0; }
                    nx = -s * gx;
                    ny = -s * gy;
                    const nl = Math.sqrt(nx * nx + ny * ny + 1);
                    nx /= nl; ny /= nl; nz = 1 / nl;
                }
                const v = nx * L[0] + ny * L[1] + nz * L[2];
                lum[k] = Math.min(1, Math.max(0, (v - rg.lo) / span));
            }
        }
        return { x0, y0, w, h, inside, lum, range: rg };
    }

    // Shading density 0..1: lit areas (luminance above `lit`) stay blank
    function computeDensity(field, params) {
        const { w, h, inside, lum } = field;
        const density = new Float32Array(w * h);
        const lit = Math.max(0.01, params.lit);
        for (let k = 0; k < w * h; k++) {
            if (!inside[k]) continue;
            const v = Math.min(1, Math.max(0, (lit - lum[k]) / lit));
            density[k] = Math.pow(v, params.gamma);
            // Shadow cast on the wall by an applied part
            if (field.boost && field.boost[k] > density[k]) density[k] = field.boost[k];
        }
        return density;
    }

    function defaultDotRadius(radiusInfo) {
        return Math.max(0.9, (radiusInfo ? radiusInfo.height : 400) / 420);
    }

    // Stippling: density averaged on a grid of cell `spacing` over the part of each cell inside
    // the prospect (so the shading keeps its tone right up to the outline), binarized with
    // serpentine Floyd-Steinberg error diffusion; each dot is jittered inside its cell, and
    // border cells try several positions until one falls inside, clear of the outline. `blocked` (optional, field-sized) marks pixels
    // covered by decorations, where no dot may fall. Returns [cx, cy, r].
    function stipple(field, density, outline, params, dotRadius, blocked) {
        const { x0, y0, w, h, inside } = field;
        const dotR = dotRadius;
        const spacing = 3.6 * dotR / Math.max(0.2, params.density);
        const gw = Math.ceil(w / spacing), gh = Math.ceil(h / spacing);
        const n = gw * gh;
        const sum = new Float64Array(n), area = new Float64Array(n), cells = new Float64Array(n);
        const sx = new Float64Array(n), sy = new Float64Array(n);
        for (let j = 0; j < h; j++) {
            const gy = Math.min(gh - 1, Math.floor(j / spacing));
            for (let i = 0; i < w; i++) {
                const g = gy * gw + Math.min(gw - 1, Math.floor(i / spacing));
                const k = j * w + i;
                cells[g]++;
                if (inside[k]) { area[g]++; sum[g] += density[k]; sx[g] += i; sy[g] += j; }
            }
        }
        const grid = new Float64Array(n);
        // Slivers of cells barely touching the prospect count by their area
        for (let g = 0; g < n; g++) {
            grid[g] = area[g] > 0 ? sum[g] / (area[g] / cells[g] > 0.25 ? area[g] : cells[g]) : 0;
        }

        const rand = mulberry32(params.seed || 0);
        // Dots may touch the drawn outline: keep only the dot radius plus half the outline stroke
        const clearance = dotR * 1.3 + 0.6;
        const rings = asRings(outline);
        // (an open ring, e.g. a handle joining the vessel wall, has no edge along its closing line)
        const edges = rings ? rings.map(r => ({ pts: G().simplify(G().edgeLine(r), 0.5), closed: !r.open })) : null;
        const ok = (cx, cy) => {
            const li = Math.floor(cx - x0), lj = Math.floor(cy - y0);
            if (li < 0 || lj < 0 || li >= w || lj >= h) return false;
            const k = lj * w + li;
            if (!inside[k] || (blocked && blocked[k])) return false;
            return !edges || edges.every(e => G().distToPolyline(cx, cy, e.pts, e.closed) >= clearance);
        };
        const dots = [];
        for (let gy = 0; gy < gh; gy++) {
            const step = gy % 2 === 0 ? 1 : -1;
            for (let m = 0; m < gw; m++) {
                const gx = step === 1 ? m : gw - 1 - m;
                const g = gy * gw + gx;
                const value = grid[g];
                const on = value >= 0.5;
                const err = value - (on ? 1 : 0);
                if (on && area[g] > 0) {
                    // Full cells: jitter around the center; border cells: anywhere in the cell,
                    // first around the centroid of its inside part
                    const full = area[g] === cells[g];
                    const tries = full ? 4 : 10;
                    for (let attempt = 0; attempt < tries; attempt++) {
                        let cx, cy;
                        if (full) {
                            cx = x0 + (gx + 0.5 + (rand() - 0.5) * 0.7) * spacing;
                            cy = y0 + (gy + 0.5 + (rand() - 0.5) * 0.7) * spacing;
                        } else if (attempt < 3) {
                            cx = x0 + sx[g] / area[g] + 0.5 + (rand() - 0.5) * 0.4 * spacing;
                            cy = y0 + sy[g] / area[g] + 0.5 + (rand() - 0.5) * 0.4 * spacing;
                        } else {
                            cx = x0 + (gx + rand()) * spacing;
                            cy = y0 + (gy + rand()) * spacing;
                        }
                        if (!ok(cx, cy)) continue;
                        const d = density[Math.floor(cy - y0) * w + Math.floor(cx - x0)];
                        dots.push([cx, cy, dotR * (0.75 + 0.5 * d)]);
                        break;
                    }
                }
                if (gx + step >= 0 && gx + step < gw) grid[g + step] += err * 7 / 16;
                if (gy + 1 < gh) {
                    const below = g + gw;
                    if (gx - step >= 0 && gx - step < gw) grid[below - step] += err * 3 / 16;
                    grid[below] += err * 5 / 16;
                    if (gx + step >= 0 && gx + step < gw) grid[below + step] += err * 1 / 16;
                }
            }
        }
        return dots;
    }

    // Pixels of the field covered by decorations (grown by `margin`), so dots stay out of them
    function decorationMask(field, primLists, margin, outline) {
        const { x0, y0, w, h } = field;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.translate(-x0, -y0);
        if (outline) {
            // Decorations are cut by the outline: only their visible part keeps dots away
            ringsPath(ctx, asRings(outline));
            ctx.clip('evenodd');
        }
        ctx.fillStyle = ctx.strokeStyle = '#000';
        ctx.lineCap = ctx.lineJoin = 'round';
        let any = false;
        for (const prims of primLists) {
            for (const prim of prims) {
                any = true;
                ctx.beginPath();
                if (prim.kind === 'ellipse') {
                    ctx.ellipse(prim.cx, prim.cy, prim.rx + margin, prim.ry + margin, prim.angle, 0, Math.PI * 2);
                    ctx.fill();
                } else if (prim.kind === 'line') {
                    prim.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
                    ctx.lineWidth = prim.width + 2 * margin;
                    ctx.stroke();
                } else if (prim.kind === 'area') {
                    prim.ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
                    ctx.closePath();
                    ctx.fill();
                } else if (prim.kind === 'fill') {
                    // A ring: its stroke keeps the dots away, its floor is shaded by the mark itself
                    for (const ring of prim.rings) {
                        ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
                        ctx.closePath();
                    }
                    // (dots may touch the wall but not overlap it: their radius is up to 1.25 x the base radius)
                    ctx.lineWidth = 2 * margin * 0.7;
                    ctx.fill('evenodd');
                    ctx.stroke();
                }
            }
        }
        if (!any) return null;
        const data = ctx.getImageData(0, 0, w, h).data;
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3] > 0 ? 1 : 0;
        return mask;
    }

    // The floor of decorations (channels, impressions) is shaded by the mark itself: inside each
    // 'shade' region the density is the one given by the mark, instead of that of the vessel, so
    // it is rendered by the same stippling / tone as the rest of the prospect
    function applyShadeRegions(field, density, shades) {
        const { x0, y0, w, h, inside } = field;
        const cv = document.createElement('canvas');
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        for (const sh of shades) {
            let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
            for (const p of sh.ring) {
                if (p.x < bx0) bx0 = p.x;
                if (p.y < by0) by0 = p.y;
                if (p.x > bx1) bx1 = p.x;
                if (p.y > by1) by1 = p.y;
            }
            const ix0 = Math.max(x0, Math.floor(bx0)), iy0 = Math.max(y0, Math.floor(by0));
            const ix1 = Math.min(x0 + w - 1, Math.ceil(bx1)), iy1 = Math.min(y0 + h - 1, Math.ceil(by1));
            const cw = ix1 - ix0 + 1, ch = iy1 - iy0 + 1;
            if (cw < 1 || ch < 1) continue;
            cv.width = cw;
            cv.height = ch;
            ctx.setTransform(1, 0, 0, 1, -ix0, -iy0);
            ctx.fillStyle = '#000';
            ctx.beginPath();
            sh.ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.closePath();
            ctx.fill();
            // a little beyond the ring, so the pixels under its wall have the density of the mark too
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#000';
            ctx.stroke();
            const data = ctx.getImageData(0, 0, cw, ch).data;
            for (let j = 0; j < ch; j++) {
                for (let i = 0; i < cw; i++) {
                    if (data[(j * cw + i) * 4 + 3] < 128) continue;
                    const k = (iy0 + j - y0) * w + (ix0 + i - x0);
                    if (inside[k]) density[k] = Math.min(1, Math.max(0, sh.fn(ix0 + i + 0.5, iy0 + j + 0.5)));
                }
            }
        }
    }

    // Continuous grey tone over the prospect bounding box (transparent outside)
    function toneCanvas(field, density, params) {
        const { w, h, inside } = field;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        const dark = params.toneDarkness;
        for (let k = 0; k < w * h; k++) {
            if (!inside[k]) continue;
            const v = Math.round(255 * (1 - dark * density[k]));
            img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = v;
            img.data[k * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return c;
    }

    window.ProspectShading = { lightVector, computeLuminance, computeInflateLuminance, edgeField, referenceRange, computeDensity, defaultDotRadius, stipple, decorationMask, applyShadeRegions, toneCanvas };
})();
