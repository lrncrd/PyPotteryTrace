// Prospect Canvas - controller of the "Prospect Canvas" tab
//
// Works on the document loaded in the SVG Editor (window.svgEditor.svgData.element): it reads
// the prospect outline, the profile and the axis from it, lets the user shade and decorate the
// prospect, and writes the result back into that document (g.prospect-art), so the SVG Editor
// save and the Post-Processing tab see it.
//
// Input is Pointer Events only (mouse, touch and pen share one code path). Two fingers always
// pan/zoom; once a pen has been used, a single finger pans instead of drawing (palm rejection).

(function () {
    const G = () => window.ProspectGeometry;
    const S = () => window.ProspectShading;
    const B = () => window.ProspectBrushes;
    const M = () => window.ProspectModel;

    const SHADING_SCHEMA = [
        { key: 'direction', label: 'Light direction (°)', min: 0, max: 359, step: 1, geometry: true },
        { key: 'elevation', label: 'Light elevation (°)', min: 5, max: 85, step: 1, geometry: true },
        { key: 'lit', label: 'Lit threshold', min: 0.2, max: 1, step: 0.01 },
        { key: 'gamma', label: 'Contrast', min: 0.4, max: 3, step: 0.05 },
        { key: 'density', label: 'Dot density', min: 0.4, max: 2.5, step: 0.05, mode: 'stipple' },
        { key: 'dotScale', label: 'Dot size', min: 0.4, max: 3, step: 0.05, mode: 'stipple' },
        { key: 'toneDarkness', label: 'Tone darkness', min: 0.1, max: 1, step: 0.01, mode: 'tone' }
    ];

    // Section of an applied part seen from the side (geometry: changes the luminance field)
    const SURFACE_SCHEMA = [
        { key: 'bevel', label: 'Edge rounding', min: 0.05, max: 1, step: 0.05 },
        { key: 'relief', label: 'Edge steepness', min: 0.2, max: 2, step: 0.05 }
    ];

    // Front view of a handle (see prospect-surfaces.js)
    // `axis`: only for that sweep ('y' vertical, 'x' horizontal or lug); `derived`: only while the outline is a
    // placed shape (get/set read and write it)
    const FRONT_SCHEMA = [
        { key: 'gw', label: 'Width of the placed shape', min: 6, max: 800, step: 1, derived: true,
            get: f => Math.round(f.gen.w), set: (f, v) => { f.gen.w = v; } },
        { key: 'gh', label: 'Height of the placed shape', min: 6, max: 500, step: 1, derived: true, axis: 'x',
            get: f => Math.round(f.gen.h), set: (f, v) => { f.gen.h = v; } },
        { key: 'crest', label: 'Height of the crest above the wall', min: 0, max: 400, step: 1, axis: 'x',
            get: f => Math.round(Math.max(...f.plan.map(p => p.dz))),
            set: (f, v) => {
                const m = Math.max(...f.plan.map(p => p.dz)) || 1;
                f.plan.forEach(p => { p.dz = Math.round(p.dz * v / m * 10) / 10; });
            } },
        { key: 'thickness', label: 'Thickness (0 = from the side view)', min: 0, max: 200, step: 1 },
        // (the section edited from above replaces it)
        { key: 'roundness', label: 'Edge rounding', min: 0.1, max: 1, step: 0.05, hide: f => !!(f.sections && f.sections.length) },
        { key: 'bend', label: 'Arch shading', min: 0, max: 1.5, step: 0.05 },
        { key: 'blend', label: 'Blend into the wall', min: 0, max: 2.5, step: 0.05 },
        { key: 'shadow', label: 'Shadow on the wall', min: 0, max: 1.5, step: 0.05 }
    ];

    const TOOL_KEYS ={ v: 'select', h: 'pan', b: 'band', p: 'polyline', f: 'freehand', s: 'stamp' };
    const HIT_PX = 10;  // screen px

    class ProspectCanvas {
        constructor() {
            this.canvas = document.getElementById('prospect-canvas');
            if (!this.canvas) return;
            this.ctx = this.canvas.getContext('2d');
            this.container = document.getElementById('prospect-canvas-container');

            this.svgElement = null;     // SVG Editor document the scene was read from
            this.scene = null;
            this.prospect = null;       // current prospect of the scene
            this.models = new Map();    // element id -> { model, history }
            this.field = null;          // luminance field of the current prospect (with its handles)
            this.baseField = null;      // the same without the handles
            this.vesselCache = null;
            this.fieldKey = '';
            this.frontRasters = new Map();
            this.frontEdges = [];
            this.density = null;
            this.dots = [];
            this.tone = null;
            this.decoPrims = new Map(); // decoration id -> primitives
            this.contextLines = [];     // other layers, drawn faint for reference

            this.bgImage = null;
            this.bgSessionId = null;
            this.showBg = true;
            this.bgOpacity = 0.35;

            this.scale = 1;
            this.ox = 0;
            this.oy = 0;

            this.tool = 'band';
            this.presetId = 'double-groove';
            this.presetParams = {};
            this.selectedId = null;

            this.pointers = new Map();  // pointerId -> {x, y, type}
            this.gesture = null;        // pan / pinch state
            this.action = null;         // current drawing / dragging action
            this.polyPts = [];          // vertices of the polyline being drawn
            this.hover = null;          // image-space cursor
            this.penSeen = false;
            this.spaceDown = false;
            this.dirty = false;

            this.buildShadingControls();
            this.buildSurfaceControls();
            this.buildFrontControls();
            this.selectedFrontId = null;
            this.frontPts = [];         // vertices of the handle outline being tapped
            this.snapshots = new Map(); // element id -> what was drawn for it, to show all the elements
            this.showAll = true;
            this.setupEvents();

            // The tab is available whenever the SVG Editor is (it works on the same document)
            const editorBtn = document.getElementById('svg-editor-tab-btn');
            const ownBtn = document.getElementById('prospect-canvas-tab-btn');
            if (editorBtn && ownBtn) {
                const sync = () => { ownBtn.disabled = editorBtn.disabled; };
                sync();
                new MutationObserver(sync).observe(editorBtn, { attributes: true, attributeFilter: ['disabled'] });
            }
            new ResizeObserver(() => this.resize()).observe(this.container);
        }

        get active() {
            const tab = document.getElementById('prospect-canvas-tab');
            return !!(tab && tab.classList.contains('active'));
        }

        get entry() { return this.prospect ? this.models.get(this.prospect.id) : null; }
        get model() { return this.entry ? this.entry.model : null; }

        // ------------------------------------------------------------------
        // Activation / scene
        // ------------------------------------------------------------------

        activate() {
            this.resize();
            const editor = window.svgEditor;
            if (!editor || !editor.svgData) {
                this.showMessage('Vectorize a drawing first: the Prospect Canvas works on the SVG shown in the SVG Editor.');
                return;
            }
            if (this.svgElement !== editor.svgData.element) {
                this.svgElement = editor.svgData.element;
                this.models.clear();
                this.prospect = null;
                this.selectedId = null;
                this.fieldKey = '';
                this.vesselCache = null;
            }
            this.loadBackground();
            this.readScene();
        }

        // Called when leaving the tab: keep the document in sync without saving to disk
        deactivate() {
            this.cancelDrawing();
            this.commitToDocument();
        }

        readScene() {
            this.vesselCache = null;
            this.frontCache = null;
            const editor = window.svgEditor;
            const dOverrides = new Map();
            (editor.paths || []).forEach(p => { if (p.element && p.currentD) dOverrides.set(p.element, p.currentD); });
            const rc = window.app && window.app.rotationCenter;
            this.scene = G().readScene(this.svgElement, editor.svgData.width, editor.svgData.height,
                dOverrides, rc ? rc.x : undefined);

            // Faint reference lines: every traced path except the prospects themselves
            this.contextLines = [];
            this.svgElement.querySelectorAll('g[id^="layer_"]:not([id="layer_Prospectus"]) path').forEach(p => {
                if (G().isProspectArt(p)) return;
                // The paths of an applied part are drawn again as its outline: same flattening, so the
                // faint copy lies exactly under the black one
                const own = p.closest('g[id="layer_Handle"], g[id="layer_Application"]');
                this.contextLines.push(...G().flattenPathD(dOverrides.get(p) || p.getAttribute('d'), own ? 1.5 : 3));
            });

            // Front views (Prospectus) first, then the side views of applied parts (Handle, Application)
            this.items = this.scene.prospects.concat(this.scene.parts);
            const select = document.getElementById('prospect-element-select');
            select.innerHTML = '';
            this.items.forEach(pr => {
                const opt = document.createElement('option');
                opt.value = pr.id;
                opt.textContent = pr.name;
                select.appendChild(opt);
            });

            if (!this.items.length) {
                this.prospect = null;
                this.showMessage('No Prospectus element in this drawing. In Segmentation, assign the front view to the Prospectus category and vectorize again.');
                this.updateUI();
                return;
            }
            this.hideMessage();
            const keep = this.prospect && this.items.find(p => p.id === this.prospect.id);
            const current = (keep || this.items[0]).id;
            // Every element is prepared, so that all of them can be shown together
            this.snapshots.clear();
            for (const it of this.items) if (it.id !== current) this.loadItem(it.id);
            this.prospect = null;
            this.setProspect(current, !keep);
        }

        // Makes an element the current one: its model, decorations and shading (no commit to the
        // document, no view change)
        loadItem(id) {
            this.prospect = this.items.find(p => p.id === id);
            // Even-odd: the hole of a handle is not part of it
            this.outlinePath = new Path2D();
            for (const ring of this.prospect.rings) {
                ring.forEach((pt, i) => (i ? this.outlinePath.lineTo(pt.x, pt.y) : this.outlinePath.moveTo(pt.x, pt.y)));
                this.outlinePath.closePath();
            }
            if (!this.models.has(id)) {
                const model = M().readModel(this.prospect.group);
                const history = new (M().History)();
                history.reset(model);
                this.models.set(id, { model, history });
            }
            // Brush sizes follow the size of the prospect
            this.unit = Math.max(0.5, this.prospect.bbox.h / 400);
            this.presetParams = {};
            B().PRESETS.forEach(p => { this.presetParams[p.id] = B().presetParams(p.id, this.unit); });
            this.selectedId = null;
            this.selectedFrontId = null;
            this.frontPts = [];
            this.fieldKey = '';
            this.rebuildAllDecorations();
            this.recomputeShading();
        }

        setProspect(id, fit = true) {
            if (this.prospect && this.prospect.id !== id) this.commitToDocument();
            this.loadItem(id);
            document.getElementById('prospect-element-select').value = id;
            if (fit) this.fitView();
            this.updateUI();
            this.redraw();
        }

        // What the canvas shows for an element that is not the current one
        saveSnapshot() {
            if (!this.prospect) return;
            this.snapshots.set(this.prospect.id, {
                item: this.prospect, model: this.model, dots: this.dots, tone: this.tone,
                frontEdges: this.frontEdges, decoPrims: new Map(this.decoPrims), outlinePath: this.outlinePath
            });
        }

        // The element under a point (image space), other than the current one
        hitOtherItem(x, y) {
            for (const it of this.items) {
                if (it === this.prospect) continue;
                let n = 0;
                for (const ring of it.rings) if (G().pointInPolygon(x, y, ring)) n++;
                if (n % 2 === 1) return it;
            }
            return null;
        }

        loadBackground() {
            const sessionId = window.app && window.app.sessionId;
            if (!sessionId || sessionId === this.bgSessionId) return;
            this.bgSessionId = sessionId;
            const img = new Image();
            img.onload = () => { this.bgImage = img; this.redraw(); };
            img.src = `/api/image/${sessionId}`;
        }

        // ------------------------------------------------------------------
        // Shading
        // ------------------------------------------------------------------

        get shadingAvailable() {
            if (!this.scene || !this.prospect) return false;
            return this.prospect.kind === 'applied' || !!this.scene.radius;
        }

        // Height that scales the dots: the vessel's, so a handle has the same dots as the body
        get referenceHeight() {
            if (this.scene.radius) return this.scene.radius.height;
            const all = this.scene.prospects.concat(this.scene.parts);
            return Math.max(...all.map(p => p.bbox.h), 1);
        }

        // The vessel is the largest front view of the drawing
        get vessel() {
            if (!this.scene || !this.scene.radius) return null;
            return this.scene.prospects.reduce((m, p) => (!m || p.bbox.h > m.bbox.h ? p : m), null);
        }

        // Luminance field of the vessel (cached): its range is also the scale of the applied
        // parts, so their tone matches the body of the vessel
        vesselField(sh) {
            const vessel = this.vessel;
            if (!vessel) return null;
            const key = `${vessel.id}|${sh.direction}|${sh.elevation}|${vessel.outline.length}|${this.scene.axisX}`;
            if (!this.vesselCache || this.vesselCache.key !== key) {
                this.vesselCache = { key, field: S().computeLuminance(vessel.outline, this.scene.radius, this.scene.axisX, sh) };
            }
            return this.vesselCache.field;
        }

        vesselRange(sh) {
            const f = this.vesselField(sh);
            return f ? f.range : null;
        }

        // Front views of the handles on the current vessel: raster + side lines of each one. The
        // geometry of a handle is marched again only when the handle or the vessel changes; a change of
        // the light only shades it again, and the other sliders reuse it all. `stride` 2 is a preview
        // while dragging (not kept).
        buildFronts(sh, stride = 1) {
            this.frontRasters = new Map();
            this.frontEdges = [];
            const model = this.model;
            if (!model || this.prospect.kind !== 'prospect' || !this.scene.radius || this.scene.axisX === null) return;
            const SU = window.ProspectSurfaces, scene = this.scene, R = scene.radius;
            const range = this.vesselRange(sh);
            if (!this.frontCache) this.frontCache = new Map();
            for (const spec of model.fronts) {
                // a horizontal handle or a lug has no side view to draw from
                const part = scene.parts.find(p => p.id === spec.part) || null;
                if (!part && spec.axis !== 'x' && !spec.side) continue;
                const { shadow, bend, ...shape } = spec;
                const geoKey = JSON.stringify([shape, scene.axisX, R.y0, R.y1, R.radius.length, part && part.id, part && part.rings.length]);
                const lightKey = JSON.stringify([shadow, bend, sh.direction, sh.elevation, range && range.lo, range && range.hi, stride]);
                let c = this.frontCache.get(spec.id);
                if (!c || c.geoKey !== geoKey) {
                    c = { geoKey, geo: SU.frontGeometry(spec, part, scene, stride), lightKey: null, front: null };
                    if (stride === 1) this.frontCache.set(spec.id, c);
                }
                if (c.lightKey !== lightKey) {
                    c.front = c.geo && SU.shadeFront(c.geo, spec, scene, sh, range, stride);
                    c.lightKey = lightKey;
                }
                const front = c.front;
                if (!front) continue;
                this.frontRasters.set(spec.id, front);
                this.frontEdges.push(...front.edges);
            }
        }

        recomputeShading(stride = 1) {
            this.computeShading(stride);
            this.saveSnapshot();
            if (window.prospect3d) window.prospect3d.invalidate();
        }

        computeShading(stride = 1) {
            this.dots = [];
            this.tone = null;
            this.frontEdges = [];
            this.frontRasters = new Map();
            if (!this.shadingAvailable || !this.model) return;
            const sh = this.model.shading;
            this.buildFronts(sh, stride);
            if (sh.mode === 'none') return;
            const applied = this.prospect.kind === 'applied';
            const su = this.model.surface;
            let field;
            if (this.prospect === this.vessel) {
                field = this.vesselField(sh);
            } else {
                const key = `${this.prospect.id}|${sh.direction}|${sh.elevation}|${this.prospect.outline.length}|${this.scene.axisX}` +
                    (applied ? `|${su.bevel}|${su.relief}` : '');
                if (key !== this.fieldKey) {
                    this.baseField = applied
                        ? S().computeInflateLuminance(this.prospect.rings, su, sh, this.vesselRange(sh))
                        : S().computeLuminance(this.prospect.outline, this.scene.radius, this.scene.axisX, sh);
                    this.fieldKey = key;
                }
                field = this.baseField;
            }
            // Handles in front view join the field; their shadow falls on the wall
            const SU = window.ProspectSurfaces;
            if (this.frontRasters.size) {
                field = SU.compose(field, [...this.frontRasters.values()]);
            }
            this.field = field;
            const rings = this.prospect.rings.concat(this.frontEdges);
            this.density = S().computeDensity(this.field, sh);
            // The floor of the decorations is shaded by the marks themselves
            const shades = [];
            for (const prims of this.decoPrims.values()) for (const pr of prims) if (pr.kind === 'shade') shades.push(pr);
            if (shades.length) S().applyShadeRegions(this.field, this.density, shades);
            if (sh.mode === 'stipple') {
                const dotR = S().defaultDotRadius({ height: this.referenceHeight }) * sh.dotScale;
                // No dots on or inside the decorations
                const blocked = S().decorationMask(this.field, this.decoPrims.values(), dotR * 1.5, this.prospect.rings);
                this.dots = S().stipple(this.field, this.density, rings, sh, dotR, blocked);
            } else if (sh.mode === 'tone') {
                this.tone = { canvas: S().toneCanvas(this.field, this.density, sh), x: this.field.x0, y: this.field.y0 };
            }
        }

        buildShadingControls() {
            const box = document.getElementById('prospect-shading-controls');
            if (!box) return;
            box.innerHTML = '';
            SHADING_SCHEMA.forEach(f => {
                const group = document.createElement('div');
                group.className = 'form-group prospect-control';
                if (f.mode) group.dataset.mode = f.mode;
                group.innerHTML = `<label>${f.label}: <span class="prospect-value" id="prospect-sh-${f.key}-value"></span></label>
                    <input type="range" class="slider" id="prospect-sh-${f.key}" min="${f.min}" max="${f.max}" step="${f.step}">`;
                box.appendChild(group);
                const input = group.querySelector('input');
                let frame = null;
                input.addEventListener('input', () => {
                    if (!this.model) return;
                    this.model.shading[f.key] = parseFloat(input.value);
                    document.getElementById(`prospect-sh-${f.key}-value`).textContent = input.value;
                    if (frame) return;
                    frame = requestAnimationFrame(() => {
                        frame = null;
                        if (f.geometry) this.rebuildAllDecorations();
                        // the light: the handles are shaded at half resolution while sliding
                        this.recomputeShading(f.geometry ? 2 : 1);
                        this.redraw();
                    });
                });
                input.addEventListener('change', () => {
                    if (f.geometry) {
                        this.recomputeShading();
                        this.redraw();
                    }
                    this.pushHistory();
                });
            });
        }

        buildSurfaceControls() {
            const box = document.getElementById('prospect-surface-controls');
            if (!box) return;
            box.innerHTML = '';
            SURFACE_SCHEMA.forEach(f => {
                const group = document.createElement('div');
                group.className = 'form-group prospect-control';
                group.innerHTML = `<label>${f.label}: <span class="prospect-value" id="prospect-su-${f.key}-value"></span></label>
                    <input type="range" class="slider" id="prospect-su-${f.key}" min="${f.min}" max="${f.max}" step="${f.step}">`;
                box.appendChild(group);
                const input = group.querySelector('input');
                let frame = null;
                input.addEventListener('input', () => {
                    if (!this.model) return;
                    this.model.surface[f.key] = parseFloat(input.value);
                    document.getElementById(`prospect-su-${f.key}-value`).textContent = input.value;
                    if (frame) return;
                    frame = requestAnimationFrame(() => {
                        frame = null;
                        this.recomputeShading();
                        this.redraw();
                    });
                });
                input.addEventListener('change', () => this.pushHistory());
            });
        }

        // ------------------------------------------------------------------
        // Handles in front view
        // ------------------------------------------------------------------

        get selectedFront() {
            return this.model && this.selectedFrontId ? this.model.fronts.find(f => f.id === this.selectedFrontId) : null;
        }

        get handlesAvailable() {
            return !!(this.scene && this.prospect && this.prospect.kind === 'prospect' &&
                this.scene.radius && this.scene.axisX !== null);
        }

        // Pointer on the selected front: a vertex is dragged (tapped twice it is removed), an edge
        // gets a new vertex. Returns true when the front took the pointer.
        startFrontDrag(ip) {
            const front = this.selectedFront;
            if (!front) return false;
            const tol = HIT_PX / this.scale;
            // A placed shape (proposed by the 3D) moves as a whole; its outline is edited after "Adopt"
            if (front.source === 'derived') {
                const r = this.frontRasters.get(front.id);
                const poly = front.points.map(([x, y]) => ({ x, y }));
                if (G().pointInPolygon(ip.x, ip.y, poly) || G().distToPolyline(ip.x, ip.y, poly, true) <= tol || (r && this.hitFront(ip.x, ip.y) === front.id)) {
                    this.action = { type: 'fmove', id: front.id, last: ip, moved: false };
                    return true;
                }
                return false;
            }
            const vi = front.points.findIndex(([x, y]) => Math.hypot(x - ip.x, y - ip.y) <= tol);
            if (vi >= 0) {
                const now = Date.now();
                if (this.lastVertexTap && this.lastVertexTap.id === front.id && this.lastVertexTap.index === vi && now - this.lastVertexTap.time < 400 && front.points.length > 3) {
                    front.points.splice(vi, 1);
                    this.lastVertexTap = null;
                    this.recomputeShading();
                    this.pushHistory();
                    return true;
                }
                this.lastVertexTap = { id: front.id, index: vi, time: now };
                this.action = { type: 'fvertex', id: front.id, index: vi, moved: false };
                return true;
            }
            const n = front.points.length;
            for (let i = 0; i < n; i++) {
                const a = front.points[i], b = front.points[(i + 1) % n];
                if (G().distToSegment(ip.x, ip.y, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }) <= tol) {
                    front.points.splice(i + 1, 0, [ip.x, ip.y]);
                    this.action = { type: 'fvertex', id: front.id, index: i + 1, moved: true };
                    return true;
                }
            }
            return false;
        }

        dragFrontVertex(a, ip) {
            const front = this.model.fronts.find(f => f.id === a.id);
            if (!front) return;
            front.points[a.index] = [ip.x, ip.y];
            a.moved = true;
            this.buildFronts(this.model.shading, 2);
        }

        // The front under a point, if any (its band)
        hitFront(x, y) {
            for (const [id, r] of this.frontRasters) {
                const i = Math.floor(x - r.x0), j = Math.floor(y - r.y0);
                if (i >= 0 && j >= 0 && i < r.w && j < r.h && r.mask[j * r.w + i]) return id;
            }
            return null;
        }

        // A tap of the handle tool: a vertex of the outline (a tap on the first one closes it)
        addFrontPoint(ip) {
            const pts = this.frontPts;
            if (pts.length >= 3 && Math.hypot(pts[0].x - ip.x, pts[0].y - ip.y) * this.scale <= 12) {
                this.finishFront();
                return;
            }
            const last = pts[pts.length - 1];
            if (!last || Math.hypot(last.x - ip.x, last.y - ip.y) * this.scale > 3) pts.push(ip);
        }

        get frontKind() {
            const el = document.getElementById('prospect-front-kind');
            return el ? el.value : 'vertical';
        }

        // Defaults of a new applied part of the chosen type
        newFront(points, source, gen, extra = {}) {
            const kind = this.frontKind;
            const SU = window.ProspectSurfaces;
            const spec = {
                id: `front_${Date.now().toString(36)}`,
                kind: kind === 'lug' ? 'lug' : 'handle',
                axis: kind === 'vertical' ? 'y' : 'x',
                part: kind === 'vertical' ? document.getElementById('prospect-front-part').value || null : null,
                points, source, gen: gen || null,
                roundness: kind === 'horizontal' ? 0.6 : 1,
                thickness: 0,
                bend: 0.5,
                blend: 0.5,
                shadow: 0.6
            };
            Object.assign(spec, extra);
            if (spec.axis === 'x') {
                const b = G().bbox(points.map(([x, y]) => ({ x, y })));
                spec.plan = SU.defaultPlan(Math.round((kind === 'lug' ? 0.5 : 0.35) * b.w));
            }
            return spec;
        }

        addFront(spec) {
            this.model.fronts.push(spec);
            this.selectedFrontId = spec.id;
            this.setTool('select');
            this.recomputeShading();
            this.pushHistory();
            this.updateUI();
            this.redraw();
        }

        // The outline is done: the front view of the chosen part, traced on the drawing
        finishFront() {
            const pts = this.frontPts;
            this.frontPts = [];
            const kind = this.frontKind;
            if (pts.length < 3 || !this.handlesAvailable) {
                this.updateUI();
                this.redraw();
                return;
            }
            // a vertical handle without a side view: one is made up from the extent of the outline
            let extra = {};
            if (kind === 'vertical' && !this.scene.parts.some(p => p.id === document.getElementById('prospect-front-part').value)) {
                const b = G().bbox(pts), th = Math.round(Math.min(0.8 * b.w, 0.2 * b.h));
                extra = { side: { y0: Math.round(b.y0 + th / 2), y1: Math.round(b.y1 - th / 2), reach: Math.round(0.35 * b.h), apex: 0.5, thick: th } };
            }
            this.addFront(this.newFront(pts.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]), 'traced', null, extra));
        }

        // Outline of a placed shape { shape, cx, cy, w, h, y0, y1 }
        genPolygon(g) {
            const r1 = v => Math.round(v * 10) / 10;
            if (g.shape === 'band') {
                // a strap that widens where it joins the wall, with round ends
                const H = Math.max(1, g.y1 - g.y0), n = 32, rc = Math.min(0.25 * g.w, 0.2 * H);
                const flare = d => Math.exp(-((d / (0.12 * H)) ** 2));
                const cap = d => Math.sqrt(1 - (1 - Math.min(1, d / rc)) ** 2);
                const half = y => g.w / 2 * (1 + 0.35 * (flare(y - g.y0) + flare(g.y1 - y))) * cap(Math.min(y - g.y0, g.y1 - y));
                // (denser towards the ends, where the outline turns)
                const ys = Array.from({ length: n + 1 }, (_, i) => g.y0 + H * (1 - Math.cos(Math.PI * i / n)) / 2);
                return ys.map(y => [g.cx + half(y), y]).concat(ys.slice().reverse().map(y => [g.cx - half(y), y]))
                    .map(p => [r1(p[0]), r1(p[1])]);
            }
            const pts = [];
            if (g.shape === 'ellipse') {
                for (let i = 0; i < 28; i++) {
                    const a = 2 * Math.PI * i / 28;
                    pts.push([r1(g.cx + g.w / 2 * Math.cos(a)), r1(g.cy + g.h / 2 * Math.sin(a))]);
                }
                return pts;
            }
            // a pill: a rectangle with round ends
            const R = Math.min(g.h / 2, g.w / 2), n = 8;
            const corner = (cx, cy, a0) => {
                for (let k = 0; k <= n; k++) {
                    const a = a0 + Math.PI / 2 * k / n;
                    pts.push([r1(cx + R * Math.cos(a)), r1(cy + R * Math.sin(a))]);
                }
            };
            corner(g.cx + g.w / 2 - R, g.cy + g.h / 2 - R, 0);
            corner(g.cx - g.w / 2 + R, g.cy + g.h / 2 - R, Math.PI / 2);
            corner(g.cx - g.w / 2 + R, g.cy - g.h / 2 + R, Math.PI);
            corner(g.cx + g.w / 2 - R, g.cy - g.h / 2 + R, 1.5 * Math.PI);
            return pts;
        }

        // A default shape of the chosen type, with its middle at the point: the 3D proposes an outline
        placeApplied(ip) {
            if (!this.handlesAvailable) return;
            const kind = this.frontKind;
            const V = this.vessel ? this.vessel.bbox : this.prospect.bbox;
            let gen, extra = {};
            if (kind === 'vertical') {
                const part = this.scene.parts.find(p => p.id === document.getElementById('prospect-front-part').value);
                let w;
                if (part) w = window.ProspectSurfaces.defaultWidth(part);
                else {
                    // no side view in the drawing: a loop a third of the vessel high, centred on the point
                    const R = this.scene.radius, h = Math.min(0.3 * V.h, 0.8 * (R.y1 - R.y0));
                    const y0 = Math.round(Math.max(R.y0 + 2, ip.y - h / 2)), y1 = Math.round(Math.min(R.y1 - 2, y0 + h));
                    const th = Math.round(0.14 * (y1 - y0));
                    extra = { side: { y0, y1, reach: Math.round(0.35 * (y1 - y0)), apex: 0.5, thick: th } };
                    w = 1.2 * th;
                }
                gen = { shape: 'band', cx: ip.x, w: Math.round(w), y0: 0, y1: 0 };
                const spec = this.newFront([], 'derived', gen, extra);
                if (!this.refitBand(spec)) return;
                this.addFront(spec);
                return;
            } else if (kind === 'lug') {
                gen = { shape: 'ellipse', cx: ip.x, cy: ip.y, w: Math.round(0.1 * V.w), h: Math.round(0.08 * V.h) };
            } else {
                gen = { shape: 'pill', cx: ip.x, cy: ip.y, w: Math.round(0.22 * V.w), h: Math.round(0.09 * V.h) };
            }
            this.addFront(this.newFront(this.genPolygon(gen), 'derived', gen));
        }

        // A placed band follows the side view it is the front of (its ends): after placing it, and when
        // the ends are moved in the Side view. Returns false when there is no side view to follow.
        refitBand(front) {
            if (front.source !== 'derived' || !front.gen || front.gen.shape !== 'band') return true;
            const FD = window.ProspectField, scene = this.scene;
            const side = FD.sidePart(front, scene.parts.find(p => p.id === front.part) || null, scene);
            const rho = side && FD.outerProfile(side, scene.axisX, scene.radius.radius.length);
            if (!rho) return false;
            front.gen.y0 = rho.y0;
            front.gen.y1 = rho.y1;
            front.points = this.genPolygon(front.gen);
            return true;
        }

        // The proposed outline becomes the user's own (traced): from now on the drawing rules
        adoptFront() {
            const f = this.selectedFront;
            if (!f || f.source !== 'derived') return;
            f.source = 'traced';
            f.gen = null;
            this.pushHistory();
            this.updateUI();
            this.redraw();
        }

        deleteFront(id) {
            this.model.fronts = this.model.fronts.filter(f => f.id !== id);
            if (this.selectedFrontId === id) this.selectedFrontId = null;
            this.recomputeShading();
            this.pushHistory();
            this.updateUI();
            this.redraw();
        }

        buildFrontControls() {
            const box = document.getElementById('prospect-front-controls');
            if (!box) return;
            box.innerHTML = '';
            FRONT_SCHEMA.forEach(f => {
                const group = document.createElement('div');
                group.className = 'form-group prospect-control';
                group.id = `prospect-fr-${f.key}-group`;
                group.innerHTML = `<label>${f.label}: <span class="prospect-value" id="prospect-fr-${f.key}-value"></span></label>
                    <input type="range" class="slider" id="prospect-fr-${f.key}" min="${f.min}" max="${f.max}" step="${f.step}">`;
                box.appendChild(group);
                const input = group.querySelector('input');
                let frame = null;
                input.addEventListener('input', () => {
                    const front = this.selectedFront;
                    if (!front) return;
                    const v = parseFloat(input.value);
                    if (f.set) f.set(front, v); else front[f.key] = v;
                    if (front.source === 'derived' && front.gen) {
                        front.points = this.genPolygon(front.gen);
                        this.refitBand(front);
                    }
                    document.getElementById(`prospect-fr-${f.key}-value`).textContent = input.value;
                    if (frame) return;
                    frame = requestAnimationFrame(() => {
                        frame = null;
                        this.recomputeShading(2);
                        this.redraw();
                    });
                });
                input.addEventListener('change', () => {
                    this.recomputeShading();
                    this.redraw();
                    this.pushHistory();
                });
            });
        }

        frontLabel(f, i) {
            const part = this.scene.parts.find(p => p.id === f.part);
            const name = f.axis === 'x' ? (f.kind === 'lug' ? 'Lug' : 'Horizontal handle') : (part ? part.name : f.side ? 'Handle (side view made up)' : 'Handle');
            return `${i + 1}. ${name}${f.source === 'derived' ? ' (placed)' : ''}`;
        }

        updateHandlesPanel() {
            const panel = document.getElementById('prospect-handles-panel');
            if (!panel) return;
            panel.style.display = this.handlesAvailable ? '' : 'none';
            if (!this.handlesAvailable) return;
            const select = document.getElementById('prospect-front-part');
            const current = select.value;
            select.innerHTML = '';
            this.scene.parts.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                select.appendChild(opt);
            });
            // without a side view in the drawing, one is made up (and edited in the Side view)
            const none = document.createElement('option');
            none.value = '';
            none.textContent = 'None: made up (edit it in the Side view)';
            select.appendChild(none);
            if (this.scene.parts.some(p => p.id === current) || current === '') select.value = current;
            const kindSel = document.getElementById('prospect-front-kind');
            const vertical = kindSel.value === 'vertical';
            document.getElementById('prospect-front-part-group').style.display = vertical ? '' : 'none';
            const list = document.getElementById('prospect-fronts-list');
            list.innerHTML = '';
            this.model.fronts.forEach((f, i) => {
                const row = document.createElement('div');
                row.className = 'prospect-deco-row' + (f.id === this.selectedFrontId ? ' active' : '');
                row.innerHTML = `<span class="prospect-deco-name">${this.frontLabel(f, i)}</span>
                    <button class="toolbar-btn" title="Delete"><i class="bi bi-trash"></i></button>`;
                row.querySelector('.prospect-deco-name').addEventListener('click', () => {
                    this.selectedFrontId = f.id;
                    this.updateUI();
                });
                row.querySelector('button').addEventListener('click', () => this.deleteFront(f.id));
                list.appendChild(row);
            });
            const front = this.selectedFront;
            document.getElementById('prospect-front-controls').style.display = front ? '' : 'none';
            document.getElementById('prospect-front-adopt').style.display = front && front.source === 'derived' ? '' : 'none';
            if (front) {
                FRONT_SCHEMA.forEach(f => {
                    const group = document.getElementById(`prospect-fr-${f.key}-group`);
                    const show = (!f.axis || f.axis === (front.axis || 'y')) && (!f.derived || front.source === 'derived') && !(f.hide && f.hide(front));
                    group.style.display = show ? '' : 'none';
                    if (!show) return;
                    const v = f.get ? f.get(front) : front[f.key];
                    document.getElementById(`prospect-fr-${f.key}`).value = v;
                    document.getElementById(`prospect-fr-${f.key}-value`).textContent = v;
                });
            }
        }

        // Shading back to its defaults (the mode and the dot pattern are kept)
        resetShading() {
            if (!this.model) return;
            const keep = { mode: this.model.shading.mode, seed: this.model.shading.seed };
            const fresh = M().defaultModel(this.prospect.id);
            this.model.shading = Object.assign(fresh.shading, keep);
            this.model.surface = fresh.surface;
            this.rebuildAllDecorations();
            this.recomputeShading();
            this.pushHistory();
            this.updateUI();
            this.redraw();
        }

        setShadingMode(mode) {
            if (!this.model) return;
            this.model.shading.mode = mode;
            this.recomputeShading();
            this.pushHistory();
            this.updateUI();
            this.redraw();
        }

        reseed() {
            if (!this.model) return;
            this.model.shading.seed = (this.model.shading.seed + 1) % 100000;
            this.recomputeShading();
            this.pushHistory();
            this.redraw();
        }

        // ------------------------------------------------------------------
        // Decorations
        // ------------------------------------------------------------------

        // Direction towards the light in the drawing plane: the decorations are shaded by it too
        get light2d() {
            if (!this.model) return null;
            const sh = this.model.shading;
            const L = S().lightVector(sh.direction, sh.elevation);
            const n = Math.hypot(L[0], L[1]) || 1;
            return { x: L[0] / n, y: L[1] / n };
        }

        rebuildDecoration(deco) {
            this.decoPrims.set(deco.id, B().build(deco, this.prospect.outline, this.light2d));
        }

        rebuildAllDecorations() {
            this.decoPrims.clear();
            if (this.model) this.model.decorations.forEach(d => this.rebuildDecoration(d));
        }

        addDecoration(points, extraParams) {
            if (!this.model || points.length < 2) return;
            const preset = this.presetParams[this.presetId];
            const deco = {
                id: `deco_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
                brush: preset.brush,
                preset: this.presetId,
                params: Object.assign({}, preset.params, 'seed' in preset.params ? { seed: 1 + Math.floor(Math.random() * 999999) } : {}, extraParams),
                points: points.map(p => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]),
                clip: true
            };
            this.model.decorations.push(deco);
            this.rebuildDecoration(deco);
            this.recomputeShading();
            this.pushHistory();
            this.updateUI();
            this.redraw();
        }

        // Brush parameters back to the defaults of the preset (of the selected decoration, or of
        // the brush about to be used); the variation and a single mark are kept
        resetBrush() {
            const sel = this.selected;
            const id = sel ? sel.preset : this.presetId;
            const fresh = B().presetParams(id, this.unit);
            if (sel) {
                const keep = {};
                ['seed', 'single'].forEach(k => { if (k in sel.params) keep[k] = sel.params[k]; });
                sel.params = Object.assign({}, fresh.params, keep);
                this.rebuildDecoration(sel);
                this.recomputeShading();
                this.pushHistory();
            } else {
                this.presetParams[id] = fresh;
            }
            this.updateBrushPanel();
            this.redraw();
        }

        get selected() {
            return this.model && this.selectedId ? this.model.decorations.find(d => d.id === this.selectedId) : null;
        }

        select(id) {
            this.selectedId = id;
            this.updateUI();
            this.redraw();
        }

        deleteSelected() {
            if (!this.selected) return;
            this.model.decorations = this.model.decorations.filter(d => d.id !== this.selectedId);
            this.decoPrims.delete(this.selectedId);
            this.selectedId = null;
            this.recomputeShading();
            this.pushHistory();
            this.updateUI();
            this.redraw();
        }

        // Decoration under a screen point: distance to its guide or to one of its primitives
        hitDecoration(x, y) {
            if (!this.model) return null;
            const tol = HIT_PX / this.scale;
            for (let i = this.model.decorations.length - 1; i >= 0; i--) {
                const d = this.model.decorations[i];
                const guide = d.points.map(([px, py]) => ({ x: px, y: py }));
                if (G().distToPolyline(x, y, guide) <= tol) return d;
                for (const prim of this.decoPrims.get(d.id) || []) {
                    if (prim.kind === 'line' && G().distToPolyline(x, y, prim.pts) <= tol) return d;
                    if (prim.kind === 'ellipse' && Math.hypot(x - prim.cx, y - prim.cy) <= prim.rx + tol) return d;
                    if ((prim.kind === 'area' || prim.kind === 'shade') && G().pointInPolygon(x, y, prim.ring)) return d;
                    if (prim.kind === 'fill' && (G().pointInPolygon(x, y, prim.rings[0]) ||
                        G().distToPolyline(x, y, prim.rings[0], true) <= tol)) return d;
                }
            }
            return null;
        }

        // ------------------------------------------------------------------
        // History
        // ------------------------------------------------------------------

        pushHistory() {
            if (!this.entry) return;
            this.entry.history.push(this.model);
            this.dirty = true;
            this.updateUndoButtons();
        }

        restore(model) {
            if (!model) return;
            this.entry.model = model;
            if (this.selectedId && !model.decorations.find(d => d.id === this.selectedId)) this.selectedId = null;
            if (this.selectedFrontId && !model.fronts.find(f => f.id === this.selectedFrontId)) this.selectedFrontId = null;
            this.rebuildAllDecorations();
            this.recomputeShading();
            this.dirty = true;
            this.updateUI();
            this.redraw();
        }

        undo() { if (this.entry) this.restore(this.entry.history.undo()); }
        redo() { if (this.entry) this.restore(this.entry.history.redo()); }

        // ------------------------------------------------------------------
        // Output
        // ------------------------------------------------------------------

        commitToDocument() {
            if (!this.prospect || !this.model) return;
            const sh = this.model.shading;
            if (sh.mode === 'tone' && !this.tone && this.shadingAvailable) this.recomputeShading();
            M().writeArt(this.prospect.group, this.model, {
                dots: this.shadingAvailable ? this.dots : [],
                tone: this.shadingAvailable ? this.tone : null,
                decorations: this.decoPrims,
                frontEdges: this.frontEdges,
                clipD: this.prospect.outlineD || (this.prospect.outline.map((q, i) => `${i ? 'L' : 'M'} ${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join(' ') + ' Z')
            });
        }

        async save() {
            if (!window.svgEditor || !window.svgEditor.svgData) return;
            this.cancelDrawing();
            this.commitToDocument();
            await window.svgEditor.exportModifiedSVG();
            this.dirty = false;
        }

        // ------------------------------------------------------------------
        // View
        // ------------------------------------------------------------------

        resize() {
            const rect = this.container.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = Math.round(rect.width * dpr);
            this.canvas.height = Math.round(rect.height * dpr);
            this.canvas.style.width = `${rect.width}px`;
            this.canvas.style.height = `${rect.height}px`;
            this.cssW = rect.width;
            this.cssH = rect.height;
            // Until the user moves the view, keep the prospect fitted (the tab may be measured
            // before its layout is final)
            if (this.prospect && !this.userMoved) this.fitView();
            this.redraw();
        }

        fitView() {
            if (!this.prospect || !this.cssW) return;
            let b = this.prospect.bbox;
            if (this.showAll && this.items.length > 1) {
                // all the elements together
                const x0 = Math.min(...this.items.map(i => i.bbox.x0)), y0 = Math.min(...this.items.map(i => i.bbox.y0));
                const x1 = Math.max(...this.items.map(i => i.bbox.x1)), y1 = Math.max(...this.items.map(i => i.bbox.y1));
                b = { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
            }
            const pad = 40;
            this.scale = Math.min((this.cssW - 2 * pad) / b.w, (this.cssH - 2 * pad) / b.h);
            this.ox = this.cssW / 2 - (b.x0 + b.w / 2) * this.scale;
            this.oy = this.cssH / 2 - (b.y0 + b.h / 2) * this.scale;
            this.userMoved = false;
            this.redraw();
        }

        zoomAt(factor, sx, sy) {
            const ns = Math.min(40, Math.max(0.05, this.scale * factor));
            this.ox = sx - (sx - this.ox) * ns / this.scale;
            this.oy = sy - (sy - this.oy) * ns / this.scale;
            this.scale = ns;
            this.userMoved = true;
            this.redraw();
        }

        toImage(sx, sy) { return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale }; }

        // ------------------------------------------------------------------
        // Rendering
        // ------------------------------------------------------------------

        redraw() {
            if (this.redrawPending) return;
            this.redrawPending = true;
            requestAnimationFrame(() => {
                this.redrawPending = false;
                this.draw();
            });
        }

        draw() {
            const ctx = this.ctx;
            const dpr = window.devicePixelRatio || 1;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            if (!this.scene) return;
            ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.ox, dpr * this.oy);
            const px = 1 / this.scale;  // one screen px in image units

            if (this.showBg && this.bgImage) {
                ctx.globalAlpha = this.bgOpacity;
                ctx.drawImage(this.bgImage, 0, 0);
                ctx.globalAlpha = 1;
            }

            ctx.strokeStyle = 'rgba(100, 116, 139, 0.45)';
            ctx.lineWidth = px;
            for (const pl of this.contextLines) this.strokePolyline(pl);
            if (this.scene.axisX !== null) {
                ctx.setLineDash([6 * px, 4 * px]);
                ctx.beginPath();
                ctx.moveTo(this.scene.axisX, 0);
                ctx.lineTo(this.scene.axisX, this.scene.height);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            if (!this.prospect) return;

            // The other elements of the drawing, as they will be
            if (this.showAll) {
                for (const snap of this.snapshots.values()) {
                    if (snap.item === this.prospect) continue;
                    const mode = snap.model.shading.mode;
                    if (snap.tone && mode === 'tone') {
                        ctx.drawImage(snap.tone.canvas, snap.tone.x, snap.tone.y);
                    } else if (snap.dots.length && mode === 'stipple') {
                        ctx.fillStyle = '#000000';
                        ctx.beginPath();
                        for (const [cx, cy, r] of snap.dots) {
                            ctx.moveTo(cx + r, cy);
                            ctx.arc(cx, cy, r, 0, Math.PI * 2);
                        }
                        ctx.fill();
                    }
                    ctx.save();
                    ctx.clip(snap.outlinePath, 'evenodd');
                    for (const deco of snap.model.decorations) this.drawPrims(snap.decoPrims.get(deco.id) || [], '#000000');
                    ctx.restore();
                    ctx.strokeStyle = '#000000';
                    ctx.lineWidth = Math.max(px, 1);
                    for (const ring of snap.item.rings) this.strokePolyline(G().edgeLine(ring), !ring.open);
                    ctx.fillStyle = '#000000';
                    for (const edge of snap.frontEdges) this.fillEdge(edge, px);
                }
            }

            // Shading
            if (this.tone && this.model.shading.mode === 'tone') {
                ctx.drawImage(this.tone.canvas, this.tone.x, this.tone.y);
            } else if (this.dots.length && this.model.shading.mode === 'stipple') {
                ctx.fillStyle = '#000000';
                ctx.beginPath();
                for (const [cx, cy, r] of this.dots) {
                    ctx.moveTo(cx + r, cy);
                    ctx.arc(cx, cy, r, 0, Math.PI * 2);
                }
                ctx.fill();
            }

            // Decorations, cut by the outline like on the vessel
            const sel = this.selected;
            ctx.save();
            ctx.clip(this.outlinePath, 'evenodd');
            for (const deco of this.model.decorations) this.drawPrims(this.decoPrims.get(deco.id) || [], '#000000');
            if (sel) this.drawPrims(this.decoPrims.get(sel.id) || [], '#2563eb');
            const preview = this.previewGuide();
            if (preview && preview.length >= 2) {
                const preset = this.presetParams[this.presetId];
                const params = this.tool === 'stamp' ? Object.assign({}, preset.params, { single: true }) : preset.params;
                const prims = B().build({ brush: preset.brush, params, points: preview.map(p => [p.x, p.y]) }, this.prospect.outline, this.light2d);
                ctx.globalAlpha = this.action || this.polyPts.length ? 1 : 0.55;
                this.drawPrims(prims, '#2563eb');
                ctx.globalAlpha = 1;
            }
            ctx.restore();

            // Outline
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = Math.max(px, 1);
            for (const ring of this.prospect.rings) this.strokePolyline(G().edgeLine(ring), !ring.open);
            ctx.fillStyle = '#000000';
            for (const edge of this.frontEdges) this.fillEdge(edge, px);
            // The outline of the selected handle front view, with its vertices
            const selFront = this.selectedFront;
            if (selFront) {
                ctx.strokeStyle = '#2563eb';
                ctx.lineWidth = px;
                ctx.setLineDash([4 * px, 3 * px]);
                this.strokePolyline(selFront.points.map(([x, y]) => ({ x, y })), true);
                ctx.setLineDash([]);
                ctx.fillStyle = '#ffffff';
                // the vertices of a traced outline are handles; a placed shape moves as a whole
                if (selFront.source !== 'derived') {
                    for (const [x, y] of selFront.points) {
                        ctx.beginPath();
                        ctx.arc(x, y, 5 * px, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                    }
                }
            }
            // The outline being tapped
            if (this.frontPts.length) {
                const pts = this.hover && this.hoverType === 'mouse' ? this.frontPts.concat([this.hover]) : this.frontPts;
                ctx.strokeStyle = '#2563eb';
                ctx.lineWidth = px;
                ctx.setLineDash([4 * px, 3 * px]);
                this.strokePolyline(pts, this.frontPts.length >= 3);
                ctx.setLineDash([]);
                ctx.fillStyle = '#ffffff';
                this.frontPts.forEach((p, i) => {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, (i === 0 ? 7 : 5) * px, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                });
            }

            // Selection
            if (sel) {
                const guide = sel.points.map(([x, y]) => ({ x, y }));
                ctx.strokeStyle = '#2563eb';
                ctx.lineWidth = px;
                ctx.setLineDash([4 * px, 3 * px]);
                this.strokePolyline(guide);
                ctx.setLineDash([]);
                ctx.fillStyle = '#ffffff';
                for (const p of guide) {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 5 * px, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            }

            // Guide of the decoration being drawn (or of the band under the cursor)
            if (preview && preview.length >= 2) {
                ctx.strokeStyle = 'rgba(37, 99, 235, 0.6)';
                ctx.lineWidth = px;
                ctx.setLineDash([4 * px, 3 * px]);
                this.strokePolyline(preview);
                ctx.setLineDash([]);
            }
        }

        // A contour of a handle: a stroke of varying weight (px of the drawing, at least one screen px)
        fillEdge(edge, px, ctx = this.ctx) {
            const k = Math.max(px, 1);
            ctx.beginPath();
            G().ribbon(edge, edge.w.map(v => v * k)).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.closePath();
            ctx.fill();
        }

        strokePolyline(pts, closed = false, ctx = this.ctx) {
            if (!pts || pts.length < 2) return;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            if (closed) ctx.closePath();
            ctx.stroke();
        }

        drawPrims(prims, color, ctx = this.ctx) {
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            for (const prim of prims) {
                if (prim.kind === 'line') {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = prim.width;
                    this.strokePolyline(prim.pts, false, ctx);
                } else if (prim.kind === 'fill') {
                    ctx.beginPath();
                    for (const ring of prim.rings) {
                        ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
                        ctx.closePath();
                    }
                    ctx.fillStyle = color;
                    ctx.fill('evenodd');
                } else if (prim.kind === 'ellipse') {
                    ctx.beginPath();
                    ctx.ellipse(prim.cx, prim.cy, prim.rx, prim.ry, prim.angle, 0, Math.PI * 2);
                    if (prim.filled) {
                        ctx.fillStyle = color;
                        ctx.fill();
                    } else {
                        ctx.strokeStyle = color;
                        ctx.lineWidth = prim.width;
                        ctx.stroke();
                    }
                }
            }
        }

        // Guide of the decoration being drawn (image space), or null
        previewGuide() {
            if (this.action && this.action.type === 'band') return this.bandGuide(this.action.x, this.action.y);
            if (this.action && this.action.type === 'stamp') return this.stampGuide(this.action.x, this.action.y);
            if (this.action && this.action.type === 'freehand') return this.action.pts;
            if (this.tool === 'polyline' && this.polyPts.length) {
                return this.hover ? this.polyPts.concat([this.hover]) : this.polyPts;
            }
            // A mouse has no "pressed" state before the click: show where the band would go
            if (this.tool === 'band' && this.hover && this.hoverType === 'mouse' && !this.gesture) {
                return this.bandGuide(this.hover.x, this.hover.y);
            }
            if (this.tool === 'stamp' && this.hover && this.hoverType === 'mouse' && !this.gesture) {
                return this.stampGuide(this.hover.x, this.hover.y);
            }
            return null;
        }

        // A single mark: a short horizontal guide, the mark sits at its middle
        stampGuide(x, y) {
            return [{ x: x - 4, y }, { x: x + 4, y }];
        }

        // Horizontal guide across the prospect at height y (the span under x, else the widest)
        bandGuide(x, y) {
            const spans = G().horizontalSpans(y, this.prospect.outline);
            if (!spans.length) return null;
            let span = spans.find(([a, b]) => x >= a && x <= b);
            if (!span) span = spans.reduce((m, s) => (s[1] - s[0] > m[1] - m[0] ? s : m));
            // The band goes on beyond the border (the clip cuts it): a wide channel must not show
            // its closed end, also when the border is slanted
            const margin = Math.max(20, 0.1 * this.prospect.bbox.w);
            return [{ x: span[0] - margin, y }, { x: span[1] + margin, y }];
        }

        // ------------------------------------------------------------------
        // Input
        // ------------------------------------------------------------------

        setupEvents() {
            const c = this.canvas;
            c.style.touchAction = 'none';
            c.addEventListener('pointerdown', e => this.onPointerDown(e));
            c.addEventListener('pointermove', e => this.onPointerMove(e));
            c.addEventListener('pointerup', e => this.onPointerUp(e));
            c.addEventListener('pointercancel', e => this.onPointerUp(e, true));
            c.addEventListener('pointerleave', () => { this.hover = null; this.redraw(); });
            c.addEventListener('dblclick', e => { e.preventDefault(); if (this.tool === 'polyline' || this.tool === 'handle') this.finishPolyline(); });
            c.addEventListener('contextmenu', e => {
                e.preventDefault();
                if (this.tool === 'polyline' && this.polyPts.length) this.finishPolyline();
            });
            c.addEventListener('wheel', e => {
                e.preventDefault();
                const r = c.getBoundingClientRect();
                this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
            }, { passive: false });

            document.addEventListener('keydown', e => this.onKeyDown(e));
            document.addEventListener('keyup', e => { if (e.code === 'Space') this.spaceDown = false; });

            document.querySelectorAll('[data-prospect-tool]').forEach(btn => {
                btn.addEventListener('click', () => this.setTool(btn.dataset.prospectTool));
            });
            document.querySelectorAll('input[name="prospect-shading-mode"]').forEach(r => {
                r.addEventListener('change', () => this.setShadingMode(r.value));
            });
            const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
            on('prospect-element-select', 'change', e => this.setProspect(e.target.value));
            on('prospect-reseed-btn', 'click', () => this.reseed());
            on('prospect-front-place', 'click', () => this.setTool('handle'));
            on('prospect-front-derive', 'click', () => this.setTool('place'));
            on('prospect-front-adopt', 'click', () => this.adoptFront());
            on('prospect-front-kind', 'change', () => this.updateHandlesPanel());
            on('prospect-bg-toggle', 'change', e => { this.showBg = e.target.checked; this.redraw(); });
            on('prospect-show-all', 'change', e => { this.showAll = e.target.checked; this.fitView(); });
            on('prospect-bg-opacity', 'input', e => { this.bgOpacity = parseFloat(e.target.value); this.redraw(); });
            on('prospect-zoom-in', 'click', () => this.zoomAt(1.25, this.cssW / 2, this.cssH / 2));
            on('prospect-zoom-out', 'click', () => this.zoomAt(0.8, this.cssW / 2, this.cssH / 2));
            on('prospect-fit', 'click', () => this.fitView());
            on('prospect-undo', 'click', () => this.undo());
            on('prospect-redo', 'click', () => this.redo());
            on('prospect-delete-btn', 'click', () => this.deleteSelected());
            on('prospect-finish-btn', 'click', () => this.finishPolyline());
            on('prospect-reset-brush', 'click', () => this.resetBrush());
            on('prospect-reset-shading', 'click', () => this.resetShading());
            on('prospect-save-btn', 'click', () => this.save());
        }

        screenPoint(e) {
            const r = this.canvas.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        }

        // A single finger after a pen was used only navigates (the palm must not draw)
        navigatesOnly(e) {
            return this.tool === 'pan' || this.spaceDown || e.button === 1 ||
                (e.pointerType === 'touch' && this.penSeen);
        }

        onPointerDown(e) {
            if (!this.prospect) return;
            if (e.pointerType === 'pen') this.penSeen = true;
            const sp = this.screenPoint(e);
            this.pointers.set(e.pointerId, { x: sp.x, y: sp.y, type: e.pointerType });
            this.canvas.setPointerCapture(e.pointerId);

            // Second finger: pinch/pan, and drop whatever the first finger started
            const touches = [...this.pointers.values()].filter(p => p.type === 'touch');
            if (touches.length >= 2) {
                this.action = null;
                this.startPinch();
                return;
            }
            if (e.button === 2) return;
            if (this.navigatesOnly(e)) {
                this.gesture = { type: 'pan', x: sp.x, y: sp.y };
                return;
            }

            const ip = this.toImage(sp.x, sp.y);
            switch (this.tool) {
                case 'handle':
                    this.addFrontPoint(ip);
                    break;
                case 'place':
                    this.placeApplied(ip);
                    break;
                case 'band':
                    this.action = { type: 'band', x: ip.x, y: ip.y };
                    break;
                case 'stamp':
                    this.action = { type: 'stamp', x: ip.x, y: ip.y };
                    break;
                case 'freehand':
                    this.action = { type: 'freehand', pts: [ip] };
                    break;
                case 'polyline': {
                    const last = this.polyPts[this.polyPts.length - 1];
                    if (!last || Math.hypot(last.x - ip.x, last.y - ip.y) * this.scale > 3) this.polyPts.push(ip);
                    break;
                }
                case 'select':
                    this.startSelectDrag(ip);
                    break;
            }
            this.redraw();
        }

        startSelectDrag(ip) {
            if (this.startFrontDrag(ip)) return;
            const sel = this.selected;
            if (sel) {
                const tol = HIT_PX / this.scale;
                const vi = sel.points.findIndex(([x, y]) => Math.hypot(x - ip.x, y - ip.y) <= tol);
                if (vi >= 0) {
                    this.action = { type: 'vertex', index: vi, last: ip, moved: false };
                    return;
                }
            }
            const hit = this.hitDecoration(ip.x, ip.y);
            const frontId = hit ? null : this.hitFront(ip.x, ip.y);
            // Nothing of the current element: another element of the drawing becomes the current one
            if (!hit && !frontId && this.showAll && !G().pointInPolygon(ip.x, ip.y, this.prospect.outline)) {
                const other = this.hitOtherItem(ip.x, ip.y);
                if (other) { this.setProspect(other.id, false); return; }
            }
            if (frontId !== this.selectedFrontId) { this.selectedFrontId = frontId; this.updateUI(); }
            this.select(hit ? hit.id : null);
            if (hit) this.action = { type: 'move', last: ip, moved: false };
        }

        onPointerMove(e) {
            const sp = this.screenPoint(e);
            const ptr = this.pointers.get(e.pointerId);
            if (ptr) { ptr.x = sp.x; ptr.y = sp.y; }
            if (this.gesture && this.gesture.type === 'pinch') { this.updatePinch(); return; }
            if (this.gesture && this.gesture.type === 'pan') {
                this.userMoved = true;
                this.ox += sp.x - this.gesture.x;
                this.oy += sp.y - this.gesture.y;
                this.gesture.x = sp.x;
                this.gesture.y = sp.y;
                this.redraw();
                return;
            }
            const ip = this.toImage(sp.x, sp.y);
            this.hover = ip;
            this.hoverType = e.pointerType;
            const a = this.action;
            if (!a) {
                if ((this.tool === 'handle' && this.frontPts.length) || (this.tool === 'polyline' && this.polyPts.length) || ((this.tool === 'band' || this.tool === 'stamp') && e.pointerType === 'mouse')) this.redraw();
                return;
            }
            if (a.type === 'band' || a.type === 'stamp') {
                a.x = ip.x;
                a.y = ip.y;
            } else if (a.type === 'freehand') {
                // Pens report many more samples than frames: keep them all
                const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
                for (const ev of events) {
                    const evp = this.screenPoint(ev);
                    const p = this.toImage(evp.x, evp.y);
                    const last = a.pts[a.pts.length - 1];
                    if (Math.hypot(p.x - last.x, p.y - last.y) * this.scale >= 1.5) a.pts.push(p);
                }
            } else if (a.type === 'fvertex') {
                this.dragFrontVertex(a, ip);
            } else if (a.type === 'fmove') {
                const front = this.model.fronts.find(f => f.id === a.id);
                if (front && front.gen) {
                    front.gen.cx += ip.x - a.last.x;
                    if (front.gen.shape !== 'band') front.gen.cy += ip.y - a.last.y;
                    front.points = this.genPolygon(front.gen);
                    a.last = ip;
                    a.moved = true;
                    this.buildFronts(this.model.shading, 2);
                }
            } else if (a.type === 'move' || a.type === 'vertex') {
                const dx = ip.x - a.last.x, dy = ip.y - a.last.y;
                a.last = ip;
                a.moved = true;
                const sel = this.selected;
                if (a.type === 'move') sel.points = sel.points.map(([x, y]) => [x + dx, y + dy]);
                else sel.points[a.index] = [sel.points[a.index][0] + dx, sel.points[a.index][1] + dy];
                this.rebuildDecoration(sel);
            }
            this.redraw();
        }

        onPointerUp(e, cancelled = false) {
            this.pointers.delete(e.pointerId);
            if (this.gesture) {
                // Lifting one finger of a pinch must not turn the other one into a pan or a stroke
                if (!this.pointers.size) this.gesture = null;
                else if (this.gesture.type === 'pinch') this.gesture = { type: 'idle' };
                return;
            }
            const a = this.action;
            this.action = null;
            if (!a || cancelled) { this.redraw(); return; }
            if (a.type === 'band') {
                const guide = this.bandGuide(a.x, a.y);
                if (guide) this.addDecoration(guide);
            } else if (a.type === 'stamp') {
                this.addDecoration(this.stampGuide(a.x, a.y), { single: true });
            } else if (a.type === 'freehand') {
                if (G().polylineLength(a.pts) * this.scale > 8) {
                    const smooth = G().smoothPolyline(G().resample(a.pts, 2 / this.scale), 2);
                    this.addDecoration(G().simplify(smooth, 0.3 / this.scale));
                }
            } else if ((a.type === 'fvertex' || a.type === 'fmove') && a.moved) {
                this.recomputeShading();
                this.pushHistory();
                this.updateUI();
            } else if ((a.type === 'move' || a.type === 'vertex') && a.moved) {
                this.recomputeShading();
                this.pushHistory();
            }
            this.redraw();
        }

        startPinch() {
            const [a, b] = [...this.pointers.values()].filter(p => p.type === 'touch');
            this.gesture = {
                type: 'pinch',
                dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                cx: (a.x + b.x) / 2,
                cy: (a.y + b.y) / 2
            };
        }

        updatePinch() {
            const touches = [...this.pointers.values()].filter(p => p.type === 'touch');
            if (touches.length < 2) return;
            const [a, b] = touches;
            const g = this.gesture;
            const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
            this.userMoved = true;
            this.ox += cx - g.cx;
            this.oy += cy - g.cy;
            this.zoomAt(dist / g.dist, cx, cy);
            g.dist = dist;
            g.cx = cx;
            g.cy = cy;
        }

        finishPolyline() {
            if (this.tool === 'handle') { this.finishFront(); return; }
            if (this.polyPts.length >= 2) this.addDecoration(this.polyPts);
            this.polyPts = [];
            this.updateUI();
            this.redraw();
        }

        cancelDrawing() {
            this.polyPts = [];
            this.frontPts = [];
            this.action = null;
            this.redraw();
        }

        onKeyDown(e) {
            if (!this.active) return;
            if (e.target && (e.target.matches('input, textarea, select') || e.target.isContentEditable)) return;
            const mod = e.ctrlKey || e.metaKey;
            if (mod && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                if (e.shiftKey) this.redo(); else this.undo();
                return;
            }
            if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this.redo(); return; }
            if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); this.save(); return; }
            if (mod || e.altKey) return;
            if (e.code === 'Space') { this.spaceDown = true; e.preventDefault(); return; }
            if (e.key === 'Escape') {
                if (this.polyPts.length || this.frontPts.length) this.cancelDrawing(); else this.select(null);
                return;
            }
            if (e.key === 'Enter') { this.finishPolyline(); return; }
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelected(); return; }
            const tool = TOOL_KEYS[e.key.toLowerCase()];
            if (tool) this.setTool(tool);
        }

        setTool(tool) {
            if (tool !== 'handle') this.frontPts = [];
            if (tool !== 'polyline' && this.polyPts.length) this.finishPolyline();
            // The Stamp tool places single marks: only the stamping brushes can do that
            if (tool === 'stamp' && (this.presetParams[this.presetId] || {}).brush !== 'impressions') this.presetId = 'bosses';
            this.tool = tool;
            this.updateUI();
            this.redraw();
        }

        setPreset(id) {
            this.presetId = id;
            if (this.tool === 'select' || this.tool === 'pan') this.tool = 'band';
            if (this.tool === 'stamp' && (this.presetParams[id] || {}).brush !== 'impressions') this.tool = 'band';
            this.select(null);
        }

        // ------------------------------------------------------------------
        // Panels
        // ------------------------------------------------------------------

        showMessage(text) {
            const box = document.getElementById('prospect-canvas-message');
            if (!box) return;
            box.querySelector('p').textContent = text;
            box.style.display = '';
        }

        hideMessage() {
            const box = document.getElementById('prospect-canvas-message');
            if (box) box.style.display = 'none';
        }

        updateUndoButtons() {
            const undo = document.getElementById('prospect-undo');
            const redo = document.getElementById('prospect-redo');
            if (undo) undo.disabled = !(this.entry && this.entry.history.canUndo());
            if (redo) redo.disabled = !(this.entry && this.entry.history.canRedo());
        }

        updateUI() {
            document.querySelectorAll('[data-prospect-tool]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.prospectTool === this.tool);
            });
            const finish = document.getElementById('prospect-finish-btn');
            if (finish) finish.style.display = this.tool === 'polyline' || this.tool === 'handle' ? '' : 'none';
            const del = document.getElementById('prospect-delete-btn');
            if (del) del.disabled = !this.selected;
            const save = document.getElementById('prospect-save-btn');
            if (save) save.disabled = !this.prospect;
            this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : (this.tool === 'select' ? 'default' : 'crosshair');
            this.updateUndoButtons();
            this.updateShadingPanel();
            this.updateHandlesPanel();
            if (window.prospect3d) window.prospect3d.invalidate();
            this.updateBrushPanel();
            this.updateDecorationList();
        }

        updateShadingPanel() {
            const status = document.getElementById('prospect-shading-status');
            const controls = document.getElementById('prospect-shading-controls');
            const modes = document.getElementById('prospect-shading-modes');
            const available = this.shadingAvailable;
            if (status) {
                status.style.display = available || !this.prospect ? 'none' : '';
                if (!available && this.scene) {
                    const missing = [];
                    if (!this.scene.profile.length) missing.push('a vectorized Profile');
                    if (this.scene.axisX === null) missing.push('the rotation center');
                    status.textContent = `Shading needs ${missing.join(' and ') || 'the profile'}. Decorations still work.`;
                }
            }
            if (modes) modes.classList.toggle('disabled', !available);
            if (!this.model) return;
            const sh = this.model.shading;
            document.querySelectorAll('input[name="prospect-shading-mode"]').forEach(r => {
                r.checked = r.value === sh.mode;
                r.disabled = !available;
                r.closest('label').classList.toggle('active', r.checked);
            });
            if (!controls) return;
            controls.style.display = available && sh.mode !== 'none' ? '' : 'none';
            SHADING_SCHEMA.forEach(f => {
                const input = document.getElementById(`prospect-sh-${f.key}`);
                input.value = sh[f.key];
                document.getElementById(`prospect-sh-${f.key}-value`).textContent = sh[f.key];
                const group = input.closest('.prospect-control');
                group.style.display = !f.mode || f.mode === sh.mode ? '' : 'none';
            });
            const reseed = document.getElementById('prospect-reseed-btn');
            if (reseed) reseed.style.display = sh.mode === 'stipple' ? '' : 'none';
            const surfacePanel = document.getElementById('prospect-surface-panel');
            if (surfacePanel) {
                surfacePanel.style.display = this.prospect.kind === 'applied' && sh.mode !== 'none' ? '' : 'none';
                SURFACE_SCHEMA.forEach(f => {
                    document.getElementById(`prospect-su-${f.key}`).value = this.model.surface[f.key];
                    document.getElementById(`prospect-su-${f.key}-value`).textContent = this.model.surface[f.key];
                });
            }
        }

        updateBrushPanel() {
            const presetsBox = document.getElementById('prospect-brush-presets');
            if (presetsBox && !presetsBox.childElementCount) {
                // Presets by family, so the list can grow without getting long
                const families = [...new Set(B().PRESETS.map(p => p.group))];
                families.forEach(family => {
                    const title = document.createElement('h4');
                    title.className = 'prospect-preset-family';
                    title.textContent = family;
                    presetsBox.appendChild(title);
                    const grid = document.createElement('div');
                    grid.className = 'prospect-presets';
                    B().PRESETS.filter(p => p.group === family).forEach(p => {
                        const btn = document.createElement('button');
                        btn.className = 'prospect-preset-btn';
                        btn.dataset.preset = p.id;
                        btn.title = p.label;
                        btn.innerHTML = `<i class="bi ${p.icon}"></i><span>${p.label}</span>`;
                        btn.addEventListener('click', () => this.setPreset(p.id));
                        grid.appendChild(btn);
                    });
                    presetsBox.appendChild(grid);
                });
            }
            const sel = this.selected;
            const activePreset = sel ? sel.preset : this.presetId;
            document.querySelectorAll('.prospect-preset-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.preset === activePreset);
            });

            const title = document.getElementById('prospect-params-title');
            const box = document.getElementById('prospect-brush-params');
            if (!box) return;
            const target = sel || this.presetParams[this.presetId];
            if (title) {
                const label = (B().PRESETS.find(p => p.id === (sel ? sel.preset : this.presetId)) || {}).label || '';
                title.textContent = sel ? `Selected: ${label}` : `New: ${label}`;
            }
            // Keep the sections the user has closed
            const closed = new Set([...box.querySelectorAll('details:not([open])')].map(d => d.dataset.group));
            box.innerHTML = '';
            if (!target) return;
            const brush = B().BRUSHES[target.brush];
            const sections = new Map();
            const onChange = () => { this.drawBrushPreview(target); };
            brush.schema.forEach(f => {
                const groupName = f.group || 'Shape';
                if (!sections.has(groupName)) {
                    const details = document.createElement('details');
                    details.className = 'prospect-section';
                    details.dataset.group = groupName;
                    if (!closed.has(groupName)) details.open = true;
                    details.innerHTML = `<summary>${groupName}</summary>`;
                    box.appendChild(details);
                    sections.set(groupName, details);
                }
                const group = document.createElement('div');
                group.className = 'form-group prospect-control';
                if (target.params[f.key] === undefined) target.params[f.key] = brush.defaults[f.key];
                const value = target.params[f.key];
                if (f.type === 'seed') {
                    group.innerHTML = `<button class="btn btn-secondary" style="width: 100%;"><i class="bi bi-shuffle"></i> New variation</button>`;
                    group.querySelector('button').addEventListener('click', () => {
                        target.params.seed = 1 + Math.floor(Math.random() * 999999);
                        if (sel) {
                            this.rebuildDecoration(sel);
                            this.recomputeShading();
                            this.pushHistory();
                        }
                        onChange();
                        this.redraw();
                    });
                    sections.get(groupName).appendChild(group);
                    return;
                }
                if (f.type === 'check') {
                    group.innerHTML = `<label><input type="checkbox" ${value ? 'checked' : ''}> ${f.label}</label>`;
                } else if (f.type === 'select') {
                    group.innerHTML = `<label>${f.label}</label><select class="form-control">${
                        f.options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
                } else {
                    group.innerHTML = `<label>${f.label}: <span class="prospect-value">${value}</span></label>
                        <input type="range" class="slider" min="${f.min}" max="${f.max}" step="${f.step}" value="${value}">`;
                }
                sections.get(groupName).appendChild(group);
                const input = group.querySelector('input, select');
                input.addEventListener('input', () => {
                    const v = f.type === 'check' ? input.checked : (f.type === 'select' ? input.value : parseFloat(input.value));
                    target.params[f.key] = v;
                    const span = group.querySelector('.prospect-value');
                    if (span) span.textContent = v;
                    if (sel) this.rebuildDecoration(sel);
                    onChange();
                    this.redraw();
                });
                input.addEventListener('change', () => {
                    if (!sel) return;
                    this.recomputeShading();
                    this.pushHistory();
                    this.redraw();
                });
            });
            this.drawBrushPreview(target);
        }

        // Swatch of the current brush (with the parameters being edited) on a sample path, drawn
        // at the size the marks really have, whatever the resolution of the scan
        drawBrushPreview(target) {
            const canvas = document.getElementById('prospect-brush-preview');
            if (!canvas || !target) return;
            const dpr = window.devicePixelRatio || 1;
            const cssW = canvas.clientWidth || 240, cssH = canvas.clientHeight || 110;
            if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
                canvas.width = Math.round(cssW * dpr);
                canvas.height = Math.round(cssH * dpr);
            }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // 1 unit of the prospect = 2.2 preview px
            const k = 2.2 / (this.unit || 1);
            ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
            const W = cssW / k, H = cssH / k;
            const guide = [];
            for (let i = 0; i <= 40; i++) {
                const t = i / 40;
                guide.push([W * (0.03 + 0.94 * t), H * (0.5 + 0.22 * Math.sin(t * Math.PI * 2))]);
            }
            const prims = B().build({ brush: target.brush, params: target.params, points: guide }, null, this.light2d);
            // Floor shading of the marks, in the current shading style
            const shades = prims.filter(pr => pr.kind === 'shade');
            const sh = this.model && this.model.shading;
            if (shades.length && sh && sh.mode !== 'none') {
                const field = { x0: 0, y0: 0, w: Math.ceil(W), h: Math.ceil(H), inside: new Uint8Array(Math.ceil(W) * Math.ceil(H)).fill(1) };
                const density = new Float32Array(field.w * field.h);
                S().applyShadeRegions(field, density, shades);
                if (sh.mode === 'stipple') {
                    const dotR = S().defaultDotRadius({ height: this.scene ? this.referenceHeight : 400 }) * sh.dotScale;
                    ctx.fillStyle = '#000000';
                    ctx.beginPath();
                    for (const [cx, cy, r] of S().stipple(field, density, null, sh, dotR, null)) {
                        ctx.moveTo(cx + r, cy);
                        ctx.arc(cx, cy, r, 0, Math.PI * 2);
                    }
                    ctx.fill();
                } else {
                    ctx.drawImage(S().toneCanvas(field, density, sh), 0, 0);
                }
            }
            this.drawPrims(prims, '#000000', ctx);
        }

        updateDecorationList() {
            const list = document.getElementById('prospect-decorations-list');
            if (!list) return;
            list.innerHTML = '';
            const decos = this.model ? this.model.decorations : [];
            if (!decos.length) {
                list.innerHTML = '<p class="empty-message">No decorations yet</p>';
                return;
            }
            decos.forEach((d, i) => {
                const label = (B().PRESETS.find(p => p.id === d.preset) || { label: d.brush }).label;
                const row = document.createElement('div');
                row.className = 'prospect-deco-row' + (d.id === this.selectedId ? ' active' : '');
                row.innerHTML = `<span>${i + 1}. ${label}</span><button class="toolbar-btn" title="Delete"><i class="bi bi-trash"></i></button>`;
                row.addEventListener('click', () => { this.setTool('select'); this.select(d.id); });
                row.querySelector('button').addEventListener('click', ev => {
                    ev.stopPropagation();
                    this.selectedId = d.id;
                    this.deleteSelected();
                });
                list.appendChild(row);
            });
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        window.prospectCanvas = new ProspectCanvas();
    });
})();
