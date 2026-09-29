// Prospect Canvas - decoration brushes
//
// A brush turns a guide polyline (drawn by the user) into drawing primitives:
//   { kind: 'line', pts: [{x, y}, ...], width }
//   { kind: 'ellipse', cx, cy, rx, ry, angle (rad), filled, width }
//   { kind: 'fill', rings: [[{x, y}, ...], ...] }   (even-odd; the first ring is the outer one)
//   { kind: 'area', ring: [{x, y}, ...] }           (not drawn: keeps the shading dots out of it)
//   { kind: 'shade', ring: [{x, y}, ...], fn(x, y) -> 0..1 }   (not drawn: the floor of a mark; its
//     shading density. The canvas renders it with the shading of the prospect, so it is dots of the
//     same size and spacing in stipple mode and a grey gradient in tone mode)
// Marks are NOT cut by the brushes: the canvas and the SVG clip every decoration to the outline
// of the prospect, so marks crossing the border appear cut, as on the vessel.
//
// Shading of the decorations: the light of the prospect falls on the walls of each mark.
// An incised/impressed mark has its shadow on the wall facing the light, a relief (applied,
// protruding) mark on the side away from it; that side of the stroke is drawn thicker.
//
// Sizes are image px. `defaults` are expressed in "units" (prospect height / 400) and scaled
// when a scene is opened, so the same brush suits scans of any resolution; fields marked
// `unitless` (counts, angles, percentages, seeds) are not scaled.
// Variability is deterministic: every random draw comes from the decoration's `seed`, so a
// decoration looks the same when the SVG is reopened; "New variation" only changes the seed.
//
// A stamping brush can also place a single mark (`single`: one mark at the middle of the guide;
// the Stamp tool of the canvas uses it).
// Adding a brush = adding an entry to BRUSHES (its schema builds the panel by itself) and a
// preset to PRESETS. Brushes that place marks along the path should use stampAlong().

(function () {
    const G = () => window.ProspectGeometry;

    const SEED_FIELD = { key: 'seed', label: 'Variation', type: 'seed', unitless: true, group: 'Variability' };
    // Overall size: multiplies every length of the brush (listed in its `scalable`)
    const SCALE_FIELD = { key: 'scale', label: 'Size ×', type: 'range', min: 0.3, max: 8, step: 0.05, unitless: true, group: 'Shape' };
    const RELIEF_FIELDS = [
        { key: 'relief', label: 'Mark', type: 'select', unitless: true, group: 'Relief',
            options: [['incised', 'Incised / impressed'], ['relief', 'Relief (protruding)']] },
        { key: 'shadow', label: 'Shadow weight', type: 'range', min: 0, max: 8, step: 0.1, group: 'Relief' }
    ];

    // Shadow (0..1) on the edge of a mark whose outward normal (seen from the stroke) is n.
    // Incised: the wall at that edge slopes down into the mark and faces -n, so it is in shadow
    // when n points towards the light. Relief: the wall faces +n, in shadow when n points away.
    function shadowFactor(nx, ny, light, relief) {
        const d = nx * light.x + ny * light.y;
        return Math.max(0, relief === 'relief' ? -d : d);
    }

    // Stroke of a polyline as a filled band whose shadowed side is thicker
    function shadedBand(pts, width, extra, light, relief) {
        const n = pts.length;
        const left = [], right = [];
        for (let i = 0; i < n; i++) {
            const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
            let tx = b.x - a.x, ty = b.y - a.y;
            const l = Math.hypot(tx, ty) || 1;
            tx /= l; ty /= l;
            const nx = -ty, ny = tx;  // left normal
            const hl = width / 2 + extra * shadowFactor(nx, ny, light, relief);
            const hr = width / 2 + extra * shadowFactor(-nx, -ny, light, relief);
            left.push({ x: pts[i].x + nx * hl, y: pts[i].y + ny * hl });
            right.push({ x: pts[i].x - nx * hr, y: pts[i].y - ny * hr });
        }
        return { kind: 'fill', rings: [left.concat(right.reverse())] };
    }

    // Edge of a raised cord: a stroke that only grows on its outer side, and only where that
    // side is away from the light (sgn = +1 for the left edge of the guide, -1 for the right)
    function shadedEdge(pts, width, extra, light, sgn) {
        const n = pts.length;
        const outer = [], inner = [];
        for (let i = 0; i < n; i++) {
            const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
            let tx = b.x - a.x, ty = b.y - a.y;
            const l = Math.hypot(tx, ty) || 1;
            tx /= l; ty /= l;
            const ox = -ty * sgn, oy = tx * sgn;  // outward normal
            const ho = width / 2 + extra * shadowFactor(ox, oy, light, 'relief');
            outer.push({ x: pts[i].x + ox * ho, y: pts[i].y + oy * ho });
            inner.push({ x: pts[i].x - ox * width / 2, y: pts[i].y - oy * width / 2 });
        }
        return { kind: 'fill', rings: [outer.concat(inner.reverse())] };
    }

    // Outline of an ellipse as a ring, thicker inside (incised) or outside (relief) on the
    // shadowed side
    function shadedEllipse(cx, cy, rx, ry, angle, width, extra, light, relief) {
        const N = 40;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const maxIn = Math.max(0, Math.min(rx, ry) * 0.85 - width / 2);
        const outer = [], inner = [];
        for (let k = 0; k < N; k++) {
            const t = (k / N) * Math.PI * 2;
            const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
            const px = cx + ex * ca - ey * sa, py = cy + ex * sa + ey * ca;
            let nx = Math.cos(t) / rx, ny = Math.sin(t) / ry;
            const l = Math.hypot(nx, ny) || 1;
            nx /= l; ny /= l;
            const wx = nx * ca - ny * sa, wy = nx * sa + ny * ca;  // outward normal, rotated
            const f = extra * shadowFactor(wx, wy, light, relief);
            const hin = width / 2 + (relief === 'relief' ? 0 : Math.min(f, maxIn));
            const hout = width / 2 + (relief === 'relief' ? f : 0);
            outer.push({ x: px + wx * hout, y: py + wy * hout });
            inner.push({ x: px - wx * hin, y: py - wy * hin });
        }
        return { kind: 'fill', rings: [outer, inner] };
    }

    // Shading of the floor of an oval/circular mark: an incised mark is dark next to the wall that
    // faces the light, a relief mark on the side away from it (like a small dome)
    function ovalShade(st, p, light, relief) {
        const ca = Math.cos(st.angle), sa = Math.sin(st.angle);
        // the light in the frame of the ellipse
        let lx = light.x * ca + light.y * sa, ly = -light.x * sa + light.y * ca;
        const l = Math.hypot(lx, ly) || 1;
        lx /= l; ly /= l;
        const sign = relief === 'relief' ? -1 : 1;
        const gain = Math.max(0, p.innerShade);
        const ring = [];
        for (let k = 0; k < 28; k++) {
            const t = k / 28 * Math.PI * 2;
            const ex = st.rx * Math.cos(t), ey = st.ry * Math.sin(t);
            ring.push({ x: st.x + ex * ca - ey * sa, y: st.y + ex * sa + ey * ca });
        }
        return {
            kind: 'shade', ring,
            fn(x, y) {
                const dx = x - st.x, dy = y - st.y;
                const qx = (dx * ca + dy * sa) / st.rx, qy = (-dx * sa + dy * ca) / st.ry;
                const u = sign * (qx * lx + qy * ly);  // 1 at the shadowed rim
                return Math.min(1, gain * Math.pow(Math.max(0, (u + 0.2) / 1.2), 1.4));
            }
        };
    }

    // Primitives of one oval/circular mark
    function ovalMark(st, p, light, relief) {
        if (!p.filled && light && p.shadow > 0) {
            const prims = [shadedEllipse(st.x, st.y, st.rx, st.ry, st.angle, p.strokeWidth, p.shadow, light, relief)];
            if (p.innerShade > 0) prims.push(ovalShade(st, p, light, relief));
            return prims;
        }
        return [{ kind: 'ellipse', cx: st.x, cy: st.y, rx: st.rx, ry: st.ry, angle: st.angle,
            filled: !!p.filled, width: p.strokeWidth }];
    }

    // Common engine of the stamping brushes: marks placed along the guide, in `rows` parallel
    // rows, with the variability parameters
    //   spacingJitter (%)  distance between marks       offsetJitter  shift across the path
    //   sizeJitter (%)     size of the marks            angleJitter (°)
    //   bigChance (%), bigScale   share of marks that are larger than the others
    // Marks whose stamp is entirely outside the outline are skipped; those crossing it are kept
    // (the clip of the canvas/SVG cuts them).
    // markFn({x, y, angle, rx, ry}) returns the primitives of one mark.
    function stampAlong(guide, p, outline, markFn) {
        const prims = [];
        const rows = Math.max(1, Math.round(p.rows || 1));
        const tilt = (p.angle || 0) * Math.PI / 180;
        const reach = Math.max(p.length, p.width) / 2 * (1 + (p.sizeJitter || 0) / 100) * Math.max(1, p.bigScale || 1)
            + (p.strokeWidth || 0) + (p.offsetJitter || 0);
        for (let i = 0; i < rows; i++) {
            const row = rows > 1 ? G().offsetPolyline(guide, (i - (rows - 1) / 2) * p.rowGap) : guide;
            if (row.length < 2) continue;
            const path = G().pathSampler(row);
            const rand = G().mulberry32((p.seed | 0) * 31 + i * 7919 + 1);
            let s = p.single ? path.total / 2 : p.spacing / 2;
            for (let guard = 0; s <= path.total && guard < 20000; guard++) {
                // the same draws for every mark, whether it is kept or not
                const rStep = rand(), rOff = rand(), rSize = rand(), rBig = rand(), rAng = rand();
                const pt = path.at(s);
                s += Math.max(0.3 * p.spacing, p.spacing * (1 + (p.spacingJitter || 0) / 100 * (rStep * 2 - 1)));
                const off = (p.offsetJitter || 0) * (rOff * 2 - 1);
                const x = pt.x - pt.ty * off, y = pt.y + pt.tx * off;
                const k = (1 + (p.sizeJitter || 0) / 100 * (rSize * 2 - 1)) * (rBig < (p.bigChance || 0) / 100 ? (p.bigScale || 1) : 1);
                if (outline && !G().pointInPolygon(x, y, outline) && G().distToPolyline(x, y, outline, true) > reach) continue;
                const angle = Math.atan2(pt.ty, pt.tx) + tilt + (p.angleJitter || 0) * Math.PI / 180 * (rAng * 2 - 1);
                prims.push(...markFn({ x, y, angle, rx: p.length / 2 * k, ry: p.width / 2 * k }));
                if (p.single) break;
            }
            if (p.single) break;
        }
        return prims;
    }

    // Profile of a channel end: half-width factor (0..1) at distance t (0 = tip, 1 = full width)
    // from the end, for the closed ends
    function endProfile(cap, t) {
        if (cap === 'round') return Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
        if (cap === 'pointed') return t;
        return 1;  // flat / open
    }

    // Smooth a polyline (moving average over r samples on each side, twice, ends kept) and give
    // every point a smooth unit tangent: a hand-drawn stroke is full of tiny wiggles that would
    // make the walls of a wide channel fold
    function smoothCenter(pts, r) {
        const n = pts.length;
        let cur = pts.map(q => ({ x: q.x, y: q.y }));
        for (let pass = 0; pass < 2 && r >= 1 && n > 2; pass++) {
            const next = [];
            for (let i = 0; i < n; i++) {
                const k = Math.min(r, i, n - 1 - i);
                let sx = 0, sy = 0;
                for (let j = i - k; j <= i + k; j++) { sx += cur[j].x; sy += cur[j].y; }
                next.push({ x: sx / (2 * k + 1), y: sy / (2 * k + 1) });
            }
            cur = next;
        }
        const w = Math.max(1, Math.min(3, Math.floor(n / 4)));
        return cur.map((q, i) => {
            const a = cur[Math.max(0, i - w)], b = cur[Math.min(n - 1, i + w)];
            let tx = b.x - a.x, ty = b.y - a.y;
            const l = Math.hypot(tx, ty) || 1;
            return { x: q.x, y: q.y, tx: tx / l, ty: ty / l };
        });
    }

    // Floor of a wide channel: dark next to the wall in shadow, fading across. Returned as a
    // region with its density, rendered later with the shading of the prospect.
    function channelRegion(dense, hwArr, loop, p, light) {
        const m = dense.length;
        if (!light || !(p.innerShade > 0) || !(p.shadow > 0) || m < 2) return null;
        const side = new Int8Array(m), strength = new Float64Array(m);
        for (let i = 0; i < m; i++) {
            const q = dense[i];
            const fl = shadowFactor(-q.ty, q.tx, light, p.relief), fr = shadowFactor(q.ty, -q.tx, light, p.relief);
            side[i] = fl >= fr ? 1 : -1;
            strength[i] = Math.max(fl, fr);
        }
        // nearest sample of the centerline, through a grid of cells
        const cell = Math.max(4, 2 * Math.max(...hwArr) + 2);
        const buckets = new Map();
        const key = (cx, cy) => cx * 100003 + cy;
        dense.forEach((q, i) => {
            const k = key(Math.floor(q.x / cell), Math.floor(q.y / cell));
            if (!buckets.has(k)) buckets.set(k, []);
            buckets.get(k).push(i);
        });
        return {
            kind: 'shade', ring: loop,
            fn(x, y) {
                const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
                let best = -1, bd = Infinity;
                for (let a = -1; a <= 1; a++) {
                    for (let b = -1; b <= 1; b++) {
                        const list = buckets.get(key(cx + a, cy + b));
                        if (!list) continue;
                        for (const i of list) {
                            const d = (dense[i].x - x) ** 2 + (dense[i].y - y) ** 2;
                            if (d < bd) { bd = d; best = i; }
                        }
                    }
                }
                if (best < 0) return 0;
                const q = dense[best], hw = hwArr[best];
                if (hw < 1e-6) return 0;
                const t = (x - q.x) * -q.ty + (y - q.y) * q.tx;  // across the channel, left is positive
                const a = Math.min(1, Math.max(0, (hw - t * side[best]) / (2 * hw)));  // 0 at the shadowed wall
                return Math.min(1, p.innerShade * strength[best] * Math.pow(1 - a, 1.4));
            }
        };
    }

    // Wide incision: a channel of constant width around the guide whose ends are closed flat,
    // rounded or pointed, or left open. Drawn as its outline; on the side facing the light
    // the wall is drawn thicker (incised) or, for relief, on the opposite side, and the floor
    // next to that wall is stippled.
    function channel(line, p, light) {
        const h = p.width / 2;
        const step = Math.max(0.5, Math.min(1.5, h * 0.15));
        const dense = smoothCenter(G().resample(line, step), 2);
        const m = dense.length;
        if (m < 2) return [];
        const S = [0];
        for (let i = 1; i < m; i++) S.push(S[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
        const total = S[m - 1];
        const closedStart = p.startCap === 'round' || p.startCap === 'pointed';
        const closedEnd = p.endCap === 'round' || p.endCap === 'pointed';
        // A pointed end is a leaf-like tip, three times as long as a rounded one
        const lenOf = cap => Math.max(1e-3, h * (p.capLength || 1) * (cap === 'pointed' ? 3 : 1));
        let capS = lenOf(p.startCap), capE = lenOf(p.endCap);
        const need = (closedStart ? capS : 0) + (closedEnd ? capE : 0);
        if (need > total) {  // short guide: the closed ends share it
            capS *= total / need;
            capE *= total / need;
        }
        const A = [], Bf = [], hwArr = [];
        for (let i = 0; i < m; i++) {
            const k = Math.min(endProfile(p.startCap, Math.min(1, S[i] / capS)), endProfile(p.endCap, Math.min(1, (total - S[i]) / capE)));
            const q = dense[i], hw = h * k;
            hwArr.push(hw);
            A.push({ x: q.x - q.ty * hw, y: q.y + q.tx * hw, hw });
            Bf.push({ x: q.x + q.ty * hw, y: q.y - q.tx * hw, hw });
        }
        const B = Bf.slice().reverse();
        // The two edges meet at a closed tip: keep one point
        const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-3;
        const seg = (a, b) => {  // interior points of the straight closure between two edge points
            const out = [], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.floor(L / step);
            for (let i = 1; i < n; i++) out.push({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n, hw: h });
            return out;
        };
        let cEnd = [], cStart = [];
        if (close(A[m - 1], B[0])) B.shift(); else cEnd = seg(A[m - 1], B[0]);
        if (close(B[B.length - 1], A[0])) B.pop(); else cStart = seg(B[B.length - 1], A[0]);
        const loop = A.concat(cEnd, B, cStart);

        const prims = [];
        if (p.filled) {
            prims.push({ kind: 'fill', rings: [loop] });
            return prims;
        }
        // Pieces of the outline: the whole loop, or cut where an end is left open
        const endOpen = p.endCap === 'open', startOpen = p.startCap === 'open';
        let pieces;
        if (!endOpen && !startOpen) pieces = [{ pts: loop, closed: true }];
        else if (endOpen && startOpen) pieces = [{ pts: A, closed: false }, { pts: B, closed: false }];
        else if (endOpen) pieces = [{ pts: B.concat(cStart, A), closed: false }];
        else pieces = [{ pts: A.concat(cEnd, B), closed: false }];
        const relief = p.relief;
        for (const piece of pieces) {
            const pts = piece.pts, n = pts.length;
            if (n < 2) continue;
            // Outward normal, miter and wall shadow of every vertex
            const nx = [], ny = [], mit = [];
            let f = [];
            for (let i = 0; i < n; i++) {
                const a = pts[piece.closed ? (i + n - 1) % n : Math.max(0, i - 1)];
                const c = pts[i];
                const b = pts[piece.closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
                let t1x = c.x - a.x, t1y = c.y - a.y, t2x = b.x - c.x, t2y = b.y - c.y;
                const l1 = Math.hypot(t1x, t1y), l2 = Math.hypot(t2x, t2y);
                if (l1 < 1e-9) { t1x = t2x; t1y = t2y; } else { t1x /= l1; t1y /= l1; }
                if (l2 < 1e-9) { t2x = t1x; t2y = t1y; } else { t2x /= l2; t2y /= l2; }
                // the interior is on the right of the travel direction
                let ox = -(t1y + t2y), oy = t1x + t2x;
                const lo = Math.hypot(ox, oy);
                if (lo < 1e-6) { ox = -t1y; oy = t1x; } else { ox /= lo; oy /= lo; }
                nx.push(ox); ny.push(oy);
                mit.push(1 / Math.max(0.6, ox * -t1y + oy * t1x));
                f.push(light && p.shadow > 0 ? p.shadow * shadowFactor(ox, oy, light, relief) : 0);
            }
            // Smooth the shadow along the outline: it must not jump at the corners of the ends
            const passes = Math.min(60, Math.max(3, Math.round(h / step * 1.5)));
            for (let pass = 0; pass < passes; pass++) {
                f = f.map((v, i) => {
                    const a = f[piece.closed ? (i + n - 1) % n : Math.max(0, i - 1)];
                    const b = f[piece.closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
                    return (a + 2 * v + b) / 4;
                });
            }
            const outer = [], inner = [];
            for (let i = 0; i < n; i++) {
                const c = pts[i];
                const hw = c.hw === undefined ? h : c.hw;
                const hin = p.strokeWidth / 2 + (relief === 'relief' ? 0 : Math.min(f[i], hw * 0.7));
                const hout = p.strokeWidth / 2 + (relief === 'relief' ? Math.min(f[i], hw * 0.7 + p.strokeWidth) : 0);
                outer.push({ x: c.x + nx[i] * hout * mit[i], y: c.y + ny[i] * hout * mit[i] });
                inner.push({ x: c.x - nx[i] * hin * mit[i], y: c.y - ny[i] * hin * mit[i] });
            }
            prims.push({ kind: 'fill', rings: piece.closed ? [outer, inner] : [outer.concat(inner.reverse())] });
        }
        const region = channelRegion(dense, hwArr, loop, p, light);
        if (region) prims.push(region);
        return prims;
    }

    // Fields shared by the stamping brushes
    const STAMP_SCHEMA = [
        SCALE_FIELD,
        { key: 'length', label: 'Mark length', type: 'range', min: 1, max: 40, step: 0.5, group: 'Shape' },
        { key: 'width', label: 'Mark width', type: 'range', min: 1, max: 30, step: 0.5, group: 'Shape' },
        { key: 'angle', label: 'Angle to path (°)', type: 'range', min: -90, max: 90, step: 1, unitless: true, group: 'Shape' },
        { key: 'filled', label: 'Filled', type: 'check', unitless: true, group: 'Shape' },
        { key: 'strokeWidth', label: 'Outline width', type: 'range', min: 0.3, max: 6, step: 0.1, group: 'Shape' },
        { key: 'single', label: 'Single mark (no path)', type: 'check', unitless: true, group: 'Layout' },
        { key: 'spacing', label: 'Spacing', type: 'range', min: 1, max: 60, step: 0.5, group: 'Layout' },
        { key: 'rows', label: 'Rows', type: 'range', min: 1, max: 4, step: 1, unitless: true, group: 'Layout' },
        { key: 'rowGap', label: 'Row spacing', type: 'range', min: 1, max: 60, step: 0.5, group: 'Layout' },
        { key: 'spacingJitter', label: 'Spacing variation (%)', type: 'range', min: 0, max: 80, step: 1, unitless: true, group: 'Variability' },
        { key: 'offsetJitter', label: 'Vertical offset', type: 'range', min: 0, max: 20, step: 0.1, group: 'Variability' },
        { key: 'sizeJitter', label: 'Size variation (%)', type: 'range', min: 0, max: 60, step: 1, unitless: true, group: 'Variability' },
        { key: 'bigChance', label: 'Larger marks (%)', type: 'range', min: 0, max: 60, step: 1, unitless: true, group: 'Variability' },
        { key: 'bigScale', label: 'Larger marks: size ×', type: 'range', min: 1, max: 2, step: 0.05, unitless: true, group: 'Variability' },
        { key: 'angleJitter', label: 'Angle variation (°)', type: 'range', min: 0, max: 45, step: 1, unitless: true, group: 'Variability' },
        SEED_FIELD
    ];
    const STAMP_SCALABLE = ['length', 'width', 'spacing', 'rowGap', 'strokeWidth', 'offsetJitter', 'shadow'];
    const STAMP_DEFAULTS = {
        scale: 1, length: 9, width: 3.5, angle: 60, filled: false, strokeWidth: 1,
        single: false, spacing: 7, rows: 1, rowGap: 10,
        spacingJitter: 0, offsetJitter: 0, sizeJitter: 0, bigChance: 0, bigScale: 1.25, angleJitter: 0,
        seed: 1, relief: 'incised', shadow: 1.5, innerShade: 1
    };

    const BRUSHES = {
        groove: {
            label: 'Groove',
            schema: [
                SCALE_FIELD,
                { key: 'lines', label: 'Lines', type: 'range', min: 1, max: 4, step: 1, unitless: true, group: 'Shape' },
                { key: 'gap', label: 'Line spacing', type: 'range', min: 1, max: 40, step: 0.5, group: 'Shape' },
                { key: 'width', label: 'Stroke width', type: 'range', min: 0.3, max: 8, step: 0.1, group: 'Shape' },
                { key: 'wobble', label: 'Irregularity', type: 'range', min: 0, max: 6, step: 0.1, group: 'Variability' },
                SEED_FIELD,
                ...RELIEF_FIELDS
            ],
            scalable: ['gap', 'width', 'wobble', 'shadow'],
            defaults: { scale: 1, lines: 1, gap: 5, width: 1.2, wobble: 0, seed: 1, relief: 'incised', shadow: 1.5 },
            build(guide, p, outline, light) {
                const prims = [];
                const n = Math.round(p.lines);
                const rand = G().mulberry32((p.seed | 0) * 31 + 5);
                for (let i = 0; i < n; i++) {
                    let line = G().offsetPolyline(guide, (i - (n - 1) / 2) * p.gap);
                    const phase1 = rand() * 6.283, phase2 = rand() * 6.283;
                    if (p.wobble > 0) {
                        // Slow irregularity of a hand-drawn line: two sines of different period
                        const dense = G().resample(line, 2);
                        let s = 0;
                        line = dense.map((q, k) => {
                            if (k) s += Math.hypot(q.x - dense[k - 1].x, q.y - dense[k - 1].y);
                            const w = p.wobble * (0.6 * Math.sin(s / (35 * p.width) + phase1) + 0.4 * Math.sin(s / (13 * p.width) + phase2));
                            return { x: q.x - q.ty * w, y: q.y + q.tx * w };
                        });
                    }
                    const runs = outline ? G().clipPolylineToPolygon(line, outline, 1) : [line];
                    for (const run of runs) {
                        const pts = G().simplify(run, 0.25);
                        if (light && p.shadow > 0) prims.push(shadedBand(G().resample(pts, 2), p.width, p.shadow, light, p.relief));
                        else prims.push({ kind: 'line', pts, width: p.width });
                    }
                }
                return prims;
            }
        },

        // Wide incision (channel) with closed or open, flat/rounded/pointed ends
        incision: {
            label: 'Wide incision',
            schema: [
                SCALE_FIELD,
                { key: 'width', label: 'Channel width', type: 'range', min: 2, max: 120, step: 0.5, group: 'Shape' },
                { key: 'strokeWidth', label: 'Outline width', type: 'range', min: 0.3, max: 6, step: 0.1, group: 'Shape' },
                { key: 'filled', label: 'Solid (filled)', type: 'check', unitless: true, group: 'Shape' },
                { key: 'lines', label: 'Parallel channels', type: 'range', min: 1, max: 6, step: 1, unitless: true, group: 'Shape' },
                { key: 'gap', label: 'Space between channels', type: 'range', min: 0, max: 80, step: 0.5, group: 'Shape' },
                { key: 'startCap', label: 'Start', type: 'select', unitless: true, group: 'Ends',
                    options: [['round', 'Closed, rounded'], ['pointed', 'Closed, pointed'], ['flat', 'Closed, flat'], ['open', 'Open']] },
                { key: 'endCap', label: 'End', type: 'select', unitless: true, group: 'Ends',
                    options: [['round', 'Closed, rounded'], ['pointed', 'Closed, pointed'], ['flat', 'Closed, flat'], ['open', 'Open']] },
                { key: 'capLength', label: 'Rounding length (× half width)', type: 'range', min: 0.3, max: 6, step: 0.1, unitless: true, group: 'Ends' },
                ...RELIEF_FIELDS,
                { key: 'innerShade', label: 'Inner shading', type: 'range', min: 0, max: 2, step: 0.05, unitless: true, group: 'Relief' },
                SEED_FIELD
            ],
            scalable: ['width', 'gap', 'strokeWidth', 'shadow'],
            defaults: { scale: 1, width: 8, strokeWidth: 1, filled: false, lines: 1, gap: 6, startCap: 'round', endCap: 'round', capLength: 1.2, relief: 'incised', shadow: 1.5, innerShade: 1, seed: 1 },
            build(guide, p, outline, light) {
                const prims = [];
                const n = Math.max(1, Math.round(p.lines));
                const h = p.width / 2;
                const step = Math.max(0.5, Math.min(1.5, h * 0.15));
                // A channel follows a soft path: rounding the corners of a clicked polyline and
                // smoothing a hand-drawn stroke avoids folds in its walls
                const soft = G().smoothPolyline(guide, 3);
                const base = smoothCenter(G().resample(soft, step), Math.min(40, Math.max(2, Math.round(h * 1.2 / step))));
                // Centers are a channel width plus the gap apart: channels never overlap
                const pitch = p.width + p.gap;
                for (let i = 0; i < n; i++) {
                    const line = G().offsetPolyline(base, (i - (n - 1) / 2) * pitch);
                    // An end outside the prospect is not an end: the channel goes on beyond the
                    // border, so it is not closed there
                    const q = Object.assign({}, p);
                    if (outline && line.length > 1) {
                        if (!G().pointInPolygon(line[0].x, line[0].y, outline)) q.startCap = 'open';
                        const e = line[line.length - 1];
                        if (!G().pointInPolygon(e.x, e.y, outline)) q.endCap = 'open';
                    }
                    prims.push(...channel(line, q, light));
                }
                return prims;
            }
        },

        // Oval or circular marks along the path: impressions (incised), bosses (relief)
        impressions: {
            label: 'Impressions',
            schema: [...STAMP_SCHEMA, ...RELIEF_FIELDS,
                { key: 'innerShade', label: 'Inner shading', type: 'range', min: 0, max: 2, step: 0.05, unitless: true, group: 'Relief' }],
            scalable: STAMP_SCALABLE,
            defaults: STAMP_DEFAULTS,
            build(guide, p, outline, light) {
                return stampAlong(guide, p, outline, st => ovalMark(st, p, light, p.relief));
            }
        },

        // Raised cord with finger impressions: two edges (swelling where the fingers press)
        // and impressions along the middle
        cord: {
            label: 'Digitate cord',
            scalable: [...STAMP_SCALABLE, 'cordWidth', 'edgeWave'],
            schema: [
                Object.assign({}, SCALE_FIELD, { group: 'Cord' }),
                { key: 'cordWidth', label: 'Cord width', type: 'range', min: 3, max: 60, step: 0.5, group: 'Cord' },
                { key: 'edgeWave', label: 'Edge swelling', type: 'range', min: 0, max: 8, step: 0.1, group: 'Cord' },
                { key: 'strokeWidth', label: 'Outline width', type: 'range', min: 0.3, max: 6, step: 0.1, group: 'Cord' },
                { key: 'shadow', label: 'Shadow weight', type: 'range', min: 0, max: 8, step: 0.1, group: 'Cord' },
                { key: 'impressions', label: 'Finger impressions', type: 'check', unitless: true, group: 'Impressions' },
                ...STAMP_SCHEMA.filter(f => ['length', 'width', 'angle', 'spacing'].includes(f.key)).map(f => Object.assign({}, f, { group: 'Impressions' })),
                ...STAMP_SCHEMA.filter(f => f.group === 'Variability')
            ],
            defaults: Object.assign({}, STAMP_DEFAULTS, {
                cordWidth: 14, edgeWave: 1, strokeWidth: 1, shadow: 1.5, impressions: true,
                length: 9, width: 4.5, angle: 60, spacing: 9, rows: 1, rowGap: 0, filled: false,
                spacingJitter: 8, offsetJitter: 0.4, sizeJitter: 8
            }),
            build(guide, p, outline, light) {
                const prims = [];
                const line = G().resample(guide, 2);
                if (line.length < 2) return prims;
                const path = G().pathSampler(line);
                const half = p.cordWidth / 2;
                const edges = [1, -1].map(sgn => line.map((q, i) => {
                    // swelling in step with the impressions: wave length = their spacing
                    const s = path.total * i / (line.length - 1);
                    const d = sgn * (half + p.edgeWave * Math.cos(2 * Math.PI * s / p.spacing));
                    return { x: q.x - q.ty * d, y: q.y + q.tx * d };
                }));
                edges.forEach((edge, k) => {
                    if (light && p.shadow > 0) prims.push(shadedEdge(edge, p.strokeWidth, p.shadow, light, k === 0 ? 1 : -1));
                    else prims.push({ kind: 'line', pts: edge, width: p.strokeWidth });
                });
                prims.push({ kind: 'area', ring: edges[0].concat(edges[1].slice().reverse()) });
                if (p.impressions) {
                    const q = Object.assign({}, p, { rows: 1, rowGap: 0, filled: false });
                    prims.push(...stampAlong(line, q, outline, st => ovalMark(st, q, light, 'incised')));
                }
                return prims;
            }
        }
    };

    // What the user picks in the brush panel
    const PRESETS = [
        { id: 'groove', group: 'Lines', label: 'Groove', icon: 'bi-dash-lg', brush: 'groove', params: { lines: 1 } },
        { id: 'double-groove', group: 'Lines', label: 'Double groove', icon: 'bi-pause-fill', brush: 'groove', params: { lines: 2 } },
        { id: 'incision', group: 'Lines', label: 'Wide incision', icon: 'bi-pill', brush: 'incision', params: {} },
        { id: 'incisions', group: 'Lines', label: 'Parallel incisions', icon: 'bi-list-nested', brush: 'incision', params: { lines: 3, width: 6, gap: 4 } },
        { id: 'ovals', group: 'Impressions', label: 'Oval impressions', icon: 'bi-three-dots', brush: 'impressions', params: {} },
        { id: 'circles', group: 'Impressions', label: 'Circular impressions', icon: 'bi-circle', brush: 'impressions',
            params: { length: 4.5, width: 4.5, angle: 0, spacing: 8, spacingJitter: 15, offsetJitter: 0.6, sizeJitter: 10, bigChance: 12, bigScale: 1.25 } },
        { id: 'dots', group: 'Impressions', label: 'Dot impressions', icon: 'bi-grip-horizontal', brush: 'impressions',
            params: { length: 3, width: 3, spacing: 6, angle: 0, filled: true } },
        { id: 'bosses', group: 'Applied', label: 'Small bosses', icon: 'bi-record-circle', brush: 'impressions',
            params: { length: 4.5, width: 4.5, angle: 0, spacing: 8, spacingJitter: 15, offsetJitter: 0.6, sizeJitter: 10, bigChance: 12, bigScale: 1.25, relief: 'relief' } },
        { id: 'cord', group: 'Applied', label: 'Digitate cord', icon: 'bi-hr', brush: 'cord', params: {} }
    ];

    // Brush parameters for a preset, sizes scaled to the scene unit
    function presetParams(presetId, unit) {
        const preset = PRESETS.find(p => p.id === presetId) || PRESETS[0];
        const brush = BRUSHES[preset.brush];
        const params = {};
        const merged = Object.assign({}, brush.defaults, preset.params);
        for (const field of brush.schema) {
            const v = merged[field.key];
            params[field.key] = (field.unitless || typeof v !== 'number') ? v : Math.round(v * unit * 10) / 10;
        }
        return { brush: preset.brush, params };
    }

    // light: unit vector towards the light in the drawing plane ({x, y}), or null for no shading.
    // outline: only used to skip work far outside the prospect; the clip cuts the marks.
    function build(decoration, outline, light) {
        const brush = BRUSHES[decoration.brush];
        if (!brush || !decoration.points || decoration.points.length < 2) return [];
        const guide = decoration.points.map(([x, y]) => ({ x, y }));
        // Decorations saved before a parameter existed get its default
        const params = Object.assign({}, brush.defaults, decoration.params);
        // Overall size multiplier
        const k = params.scale > 0 ? params.scale : 1;
        if (k !== 1 && brush.scalable) {
            for (const key of brush.scalable) if (typeof params[key] === 'number') params[key] *= k;
        }
        return brush.build(guide, params, decoration.clip === false ? null : outline, light);
    }

    window.ProspectBrushes = { BRUSHES, PRESETS, presetParams, build };
})();
