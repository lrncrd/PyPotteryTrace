// Prospect Canvas - geometry helpers
// Reads the prospect scene (outline, profile, axis) from the unified SVG and provides the
// polyline utilities used by the shading and the decoration brushes. Coordinates are image px.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    let measureSvg = null;

    // Elements drawn by the Prospect Canvas (and the older server-side stippling): never part
    // of the traced geometry
    function isProspectArt(el) {
        return !!(el && el.closest && el.closest('g.prospect-art, g.shading'));
    }

    // Flatten an SVG path "d" into polylines (one per subpath), sampled every `step` px,
    // using the browser's own path geometry so every command (C, S, Q, A...) is handled
    function flattenPathD(d, step = 2) {
        if (!d) return [];
        if (!measureSvg) {
            measureSvg = document.createElementNS(SVG_NS, 'svg');
            measureSvg.setAttribute('width', '0');
            measureSvg.setAttribute('height', '0');
            measureSvg.style.position = 'absolute';
            measureSvg.style.visibility = 'hidden';
            document.body.appendChild(measureSvg);
        }
        const polylines = [];
        // Paths written by Trace use absolute commands, so subpaths can be measured one by one
        const subpaths = d.trim().split(/(?=M)/).filter(s => s.trim().length > 1);
        for (const sub of subpaths) {
            const el = document.createElementNS(SVG_NS, 'path');
            el.setAttribute('d', sub);
            measureSvg.appendChild(el);
            let length = 0;
            try { length = el.getTotalLength(); } catch (e) { length = 0; }
            const pts = [];
            if (length > 0) {
                const n = Math.max(2, Math.ceil(length / step));
                for (let i = 0; i <= n; i++) {
                    const p = el.getPointAtLength((i / n) * length);
                    pts.push({ x: p.x, y: p.y });
                }
            } else {
                const m = sub.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
                if (m && m.length >= 2) pts.push({ x: parseFloat(m[0]), y: parseFloat(m[1]) });
            }
            measureSvg.removeChild(el);
            if (pts.length) polylines.push(pts);
        }
        return polylines;
    }

    function polygonArea(poly) {
        let a = 0;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
        }
        return Math.abs(a / 2);
    }

    function bbox(pts) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pts) {
            if (p.x < x0) x0 = p.x;
            if (p.y < y0) y0 = p.y;
            if (p.x > x1) x1 = p.x;
            if (p.y > y1) y1 = p.y;
        }
        return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
    }

    function pointInPolygon(x, y, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) {
                inside = !inside;
            }
        }
        return inside;
    }

    function distToSegment(px, py, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = a.x + t * dx - px, qy = a.y + t * dy - py;
        return Math.sqrt(qx * qx + qy * qy);
    }

    function distToPolyline(px, py, pts, closed = false) {
        let best = Infinity;
        const n = pts.length;
        if (n === 1) return Math.hypot(px - pts[0].x, py - pts[0].y);
        for (let i = 0; i < n - 1; i++) best = Math.min(best, distToSegment(px, py, pts[i], pts[i + 1]));
        if (closed && n > 2) best = Math.min(best, distToSegment(px, py, pts[n - 1], pts[0]));
        return best;
    }

    // Inside intervals [x0, x1] of the horizontal line at y
    function horizontalSpans(y, poly) {
        const xs = [];
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if ((a.y > y) !== (b.y > y)) xs.push((b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x);
        }
        xs.sort((p, q) => p - q);
        const spans = [];
        for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
        return spans;
    }

    function polylineLength(pts) {
        let len = 0;
        for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        return len;
    }

    // Evenly spaced points along a polyline (arc length), each with its unit tangent
    function resample(pts, step) {
        if (pts.length < 2) return pts.map(p => ({ x: p.x, y: p.y, tx: 1, ty: 0 }));
        const out = [];
        let seg = 0, segStart = 0;
        const total = polylineLength(pts);
        const n = Math.max(1, Math.round(total / step));
        const lens = [0];
        for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
        for (let k = 0; k <= n; k++) {
            const s = (k / n) * total;
            while (seg < pts.length - 2 && lens[seg + 1] < s) seg++;
            segStart = lens[seg];
            const a = pts[seg], b = pts[seg + 1];
            const L = Math.max(1e-9, lens[seg + 1] - segStart);
            const t = Math.max(0, Math.min(1, (s - segStart) / L));
            out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), tx: (b.x - a.x) / L, ty: (b.y - a.y) / L });
        }
        return out;
    }

    // Points at arc-length positions start, start+spacing, ... with their unit tangent
    function pointsAlong(pts, spacing, start = spacing / 2) {
        const out = [];
        if (pts.length < 2 || spacing <= 0) return out;
        let acc = 0, next = start;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            const L = Math.hypot(b.x - a.x, b.y - a.y);
            if (L === 0) continue;
            while (next <= acc + L) {
                const t = (next - acc) / L;
                out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), tx: (b.x - a.x) / L, ty: (b.y - a.y) / L });
                next += spacing;
            }
            acc += L;
        }
        return out;
    }

    // Random numbers from a seed (mulberry32): the same seed always gives the same sequence
    function mulberry32(seed) {
        let s = seed >>> 0;
        return function () {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Position and unit tangent at any arc length of a polyline: { total, at(s) }
    function pathSampler(pts) {
        const lens = [0];
        for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
        const total = lens[lens.length - 1];
        return {
            total,
            at(s) {
                s = Math.max(0, Math.min(total, s));
                let lo = 0, hi = pts.length - 2;
                while (lo < hi) {
                    const mid = (lo + hi + 1) >> 1;
                    if (lens[mid] <= s) lo = mid; else hi = mid - 1;
                }
                const a = pts[lo], b = pts[lo + 1];
                const L = (lens[lo + 1] - lens[lo]) || 1e-9;
                const t = (s - lens[lo]) / L;
                return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), tx: (b.x - a.x) / L, ty: (b.y - a.y) / L };
            }
        };
    }

    // Parallel polyline at signed distance d (normal = tangent rotated +90°), with miter joins
    function offsetPolyline(pts, d) {
        if (d === 0 || pts.length < 2) return pts.map(p => ({ x: p.x, y: p.y }));
        const n = pts.length;
        const out = [];
        for (let i = 0; i < n; i++) {
            const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(n - 1, i + 1)];
            let t1x = b.x - a.x, t1y = b.y - a.y, t2x = c.x - b.x, t2y = c.y - b.y;
            const l1 = Math.hypot(t1x, t1y) || 1, l2 = Math.hypot(t2x, t2y) || 1;
            t1x /= l1; t1y /= l1; t2x /= l2; t2y /= l2;
            if (i === 0) { t1x = t2x; t1y = t2y; }
            if (i === n - 1) { t2x = t1x; t2y = t1y; }
            let nx = -(t1y + t2y), ny = t1x + t2x;
            const ln = Math.hypot(nx, ny);
            if (ln < 1e-6) { nx = -t1y; ny = t1x; } else { nx /= ln; ny /= ln; }
            const cos = Math.max(0.3, nx * -t1y + ny * t1x);  // limit the miter at sharp zig-zag corners
            out.push({ x: b.x + nx * d / cos, y: b.y + ny * d / cos });
        }
        return out;
    }

    // Split a polyline into the runs that fall inside the polygon (sampled every `step` px)
    function clipPolylineToPolygon(pts, poly, step = 1) {
        const dense = resample(pts, step);
        const runs = [];
        let run = null;
        for (const p of dense) {
            if (pointInPolygon(p.x, p.y, poly)) {
                if (!run) { run = []; runs.push(run); }
                run.push({ x: p.x, y: p.y });
            } else {
                run = null;
            }
        }
        return runs.filter(r => r.length >= 2);
    }

    // Keep only the corners of a densely sampled polyline (Ramer-Douglas-Peucker)
    function simplify(pts, eps) {
        if (pts.length < 3) return pts.slice();
        const keep = new Uint8Array(pts.length);
        keep[0] = keep[pts.length - 1] = 1;
        const stack = [[0, pts.length - 1]];
        while (stack.length) {
            const [i0, i1] = stack.pop();
            let best = -1, bestD = eps;
            for (let i = i0 + 1; i < i1; i++) {
                const d = distToSegment(pts[i].x, pts[i].y, pts[i0], pts[i1]);
                if (d > bestD) { bestD = d; best = i; }
            }
            if (best >= 0) {
                keep[best] = 1;
                stack.push([i0, best], [best, i1]);
            }
        }
        return pts.filter((_, i) => keep[i]);
    }

    // Chaikin corner cutting, for freehand strokes
    function smoothPolyline(pts, iterations = 2) {
        let cur = pts;
        for (let k = 0; k < iterations && cur.length > 2; k++) {
            const next = [cur[0]];
            for (let i = 0; i < cur.length - 1; i++) {
                const a = cur[i], b = cur[i + 1];
                next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
                next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
            }
            next.push(cur[cur.length - 1]);
            cur = next;
        }
        return cur;
    }

    function gaussianSmooth(values, sigma) {
        const n = values.length;
        const radius = Math.max(1, Math.ceil(3 * sigma));
        const kernel = [];
        let sum = 0;
        for (let i = -radius; i <= radius; i++) {
            const w = Math.exp(-(i * i) / (2 * sigma * sigma));
            kernel.push(w);
            sum += w;
        }
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const j = Math.min(n - 1, Math.max(0, i + k));  // edge padding
                acc += values[j] * kernel[k + radius];
            }
            out[i] = acc / sum;
        }
        return out;
    }

    // Radius r(y) of the vessel for every image row, and dr/dy, from the profile polylines:
    // on each row the outermost distance from the axis. Rows above/below the profile continue
    // it with its end slope (a prospect often reaches a little lower than the drawn section,
    // and a vertical wall there would show as a light band).
    function radiusByRow(profilePolylines, axisX, height) {
        const pts = profilePolylines.flat();
        if (!pts.length) return null;
        let y0 = Infinity, y1 = -Infinity;
        for (const p of pts) {
            const y = Math.round(p.y);
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
        y0 = Math.max(0, y0);
        y1 = Math.min(height - 1, y1);
        if (y1 <= y0) return null;
        const r = new Float64Array(y1 - y0 + 1).fill(-1);
        const reach = (y, x) => {
            if (y >= y0 && y <= y1) r[y - y0] = Math.max(r[y - y0], Math.abs(axisX - x));
        };
        // Every row crossed by a segment gets that segment's x: with a closed section, sampled
        // points alone can leave rows where only the inner wall is hit, and r(y) would jump
        for (const pl of profilePolylines) {
            for (let i = 0; i < pl.length; i++) {
                const a = pl[i], b = pl[Math.min(pl.length - 1, i + 1)];
                const ya = Math.min(a.y, b.y), yb = Math.max(a.y, b.y);
                reach(Math.round(a.y), a.x);
                for (let y = Math.ceil(ya); y <= Math.floor(yb); y++) {
                    const t = yb > ya ? (y - a.y) / (b.y - a.y) : 0;
                    reach(y, a.x + t * (b.x - a.x));
                }
            }
        }
        // Interpolate the rows without profile points
        let last = -1;
        for (let i = 0; i < r.length; i++) {
            if (r[i] < 0) continue;
            if (last < 0) { for (let k = 0; k < i; k++) r[k] = r[i]; }
            else { for (let k = last + 1; k < i; k++) r[k] = r[last] + (r[i] - r[last]) * (k - last) / (i - last); }
            last = i;
        }
        for (let k = last + 1; k < r.length; k++) r[k] = r[last];
        // Hand-drawn wobble would stripe the shading
        const rs = gaussianSmooth(r, Math.max(3, (y1 - y0) / 80));
        const radius = new Float64Array(height);
        const dr = new Float64Array(height);
        for (let i = 0; i < rs.length; i++) {
            const a = rs[Math.max(0, i - 1)], b = rs[Math.min(rs.length - 1, i + 1)];
            radius[y0 + i] = rs[i];
            dr[y0 + i] = (b - a) / ((i > 0 && i < rs.length - 1) ? 2 : 1);
        }
        // End slopes measured a little inside the section (the smoothing flattens the very end)
        const k = Math.min(rs.length - 1, Math.max(3, Math.round((y1 - y0) / 40)));
        const topSlope = (rs[k] - rs[0]) / k;
        const bottomSlope = (rs[rs.length - 1] - rs[rs.length - 1 - k]) / k;
        for (let y = 0; y < y0; y++) {
            radius[y] = Math.max(1, rs[0] - topSlope * (y0 - y));
            dr[y] = radius[y] > 1 ? topSlope : 0;
        }
        for (let y = y1 + 1; y < height; y++) {
            radius[y] = Math.max(1, rs[rs.length - 1] + bottomSlope * (y - y1));
            dr[y] = radius[y] > 1 ? bottomSlope : 0;
        }
        return { radius, dr, y0, y1, height: y1 - y0 };
    }

    // ------------------------------------------------------------------
    // Scene: what the canvas needs from the unified SVG
    // ------------------------------------------------------------------

    function pathD(pathEl, dOverrides) {
        return (dOverrides && dOverrides.get(pathEl)) || pathEl.getAttribute('d') || '';
    }

    function layerPolylines(svgEl, layerSelector, dOverrides) {
        const out = [];
        svgEl.querySelectorAll(`${layerSelector} path`).forEach(p => {
            if (isProspectArt(p)) return;
            out.push(...flattenPathD(pathD(p, dOverrides)));
        });
        return out;
    }

    // Axis x: the session rotation center, else the middle of the Diameter line, else a
    // vertical Symmetry line
    function findAxisX(svgEl, dOverrides, sessionAxisX) {
        if (Number.isFinite(sessionAxisX)) return sessionAxisX;
        const diam = layerPolylines(svgEl, 'g[id="layer_Diameter"]', dOverrides).flat();
        if (diam.length >= 2) {
            const b = bbox(diam);
            if (b.w > 0) return (b.x0 + b.x1) / 2;
        }
        const sym = layerPolylines(svgEl, 'g[id="layer_Symmetry_Line"]', dOverrides).flat();
        if (sym.length >= 2) {
            const b = bbox(sym);
            if (b.h > 0 && b.w < 2) return (b.x0 + b.x1) / 2;
        }
        return null;
    }

    // dOverrides: Map(pathElement -> current "d"), so unsaved SVG Editor edits are used
    function readScene(svgEl, width, height, dOverrides, sessionAxisX) {
        const prospects = [];
        svgEl.querySelectorAll('g[id="layer_Prospectus"] > g[id^="element_"]').forEach(g => {
            let outline = null, outlineD = null;
            g.querySelectorAll('path').forEach(p => {
                if (isProspectArt(p)) return;
                for (const pl of flattenPathD(pathD(p, dOverrides), 1.5)) {
                    if (pl.length < 3) continue;
                    if (!outline || polygonArea(pl) > polygonArea(outline)) { outline = pl; outlineD = pathD(p, dOverrides); }
                }
            });
            if (outline) {
                const id = g.getAttribute('id');
                prospects.push({ id, name: id.replace(/^element_/, '').replace(/_/g, ' '), group: g, outline, outlineD, bbox: bbox(outline) });
            }
        });
        const axisX = findAxisX(svgEl, dOverrides, sessionAxisX);
        // The profile section only (not its mirrored copy)
        const profile = layerPolylines(svgEl, 'g[id="layer_Profile"]', dOverrides);
        const radius = (axisX !== null && profile.length) ? radiusByRow(profile, axisX, Math.ceil(height)) : null;
        return { width, height, prospects, axisX, profile, radius };
    }

    window.ProspectGeometry = {
        isProspectArt, flattenPathD, polygonArea, bbox, pointInPolygon, distToSegment, distToPolyline,
        horizontalSpans, polylineLength, resample, pointsAlong, mulberry32, pathSampler, offsetPolyline, clipPolylineToPolygon,
        simplify, smoothPolyline, radiusByRow, readScene
    };
})();
