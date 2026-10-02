// Prospect Canvas - document model, undo history and SVG output
//
// The model of a prospect is plain JSON (shading parameters + decorations with their guide
// path and brush parameters). It is stored inside the SVG, in
// <g class="prospect-art"><metadata class="prospect-model">, next to the rendered circles,
// paths and ellipses, so reopening the file brings back editable, non-destructive layers.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const XLINK_NS = 'http://www.w3.org/1999/xlink';

    function defaultModel(elementId) {
        return {
            version: 1,
            element: elementId,
            shading: {
                mode: 'stipple',      // 'none' | 'stipple' | 'tone'
                direction: 315,       // light from the upper left (clock angle, 0 = top)
                elevation: 35,
                lit: 0.75,            // luminance above which nothing is drawn
                gamma: 1.3,           // contrast of the density
                density: 1,           // dot spacing multiplier
                dotScale: 1,          // dot size multiplier
                toneDarkness: 0.85,   // darkest grey of the tone mode
                seed: 0
            },
            // Side view of an applied part (handle): the silhouette is inflated into a strap
            surface: {
                bevel: 0.7,           // rounded width of the edge, as a fraction of the half thickness (1 = round rod)
                relief: 1             // height of the arc (1 = circular section)
            },
            // Handles seen from the front, derived from their side view (Handle layer):
            // { id, part, points: [[x, y], ...] (its outline on the drawing, tapped by the user),
            //   roundness, bend, shadow }
            fronts: [],
            decorations: []           // { id, brush, params, points: [[x, y], ...], clip }
        };
    }

    // Model from the SVG of the element (older files without a model get the defaults)
    function readModel(elementGroup) {
        const id = elementGroup.getAttribute('id');
        const meta = elementGroup.querySelector('g.prospect-art > metadata.prospect-model');
        const model = defaultModel(id);
        if (!meta) return model;
        try {
            const saved = JSON.parse(meta.textContent);
            Object.assign(model.shading, saved.shading || {});
            Object.assign(model.surface, saved.surface || {});
            model.fronts = Array.isArray(saved.fronts) ? saved.fronts.filter(f => Array.isArray(f.points) && f.points.length >= 3) : [];
            // (fields of earlier versions: a thickness no slider shows for horizontal parts, two openings of the lume)
            for (const f of model.fronts) {
                if (f.axis === 'x') f.thickness = 0;
                delete f.underBelow;
                delete f.lumeTrace;
            }
            model.decorations = Array.isArray(saved.decorations) ? saved.decorations : [];
        } catch (e) {
            console.warn('Prospect model could not be read, using defaults:', e);
        }
        return model;
    }

    class History {
        constructor(limit = 100) {
            this.limit = limit;
            this.stack = [];
            this.index = -1;
        }
        reset(model) {
            this.stack = [JSON.stringify(model)];
            this.index = 0;
        }
        push(model) {
            const snap = JSON.stringify(model);
            if (snap === this.stack[this.index]) return;
            this.stack = this.stack.slice(0, this.index + 1);
            this.stack.push(snap);
            if (this.stack.length > this.limit) this.stack.shift();
            this.index = this.stack.length - 1;
        }
        canUndo() { return this.index > 0; }
        canRedo() { return this.index < this.stack.length - 1; }
        undo() { return this.canUndo() ? JSON.parse(this.stack[--this.index]) : null; }
        redo() { return this.canRedo() ? JSON.parse(this.stack[++this.index]) : null; }
    }

    const fmt = v => (Math.round(v * 100) / 100).toString();

    function el(doc, tag, attrs) {
        const node = doc.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
        return node;
    }

    function primitiveToSvg(doc, prim) {
        if (prim.kind === 'line') {
            const d = prim.pts.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p.x)} ${fmt(p.y)}`).join(' ');
            return el(doc, 'path', {
                d, fill: 'none', stroke: '#000000', 'stroke-width': fmt(prim.width),
                'stroke-linecap': 'round', 'stroke-linejoin': 'round'
            });
        }
        if (prim.kind === 'fill') {
            const d = prim.rings.map(ring =>
                ring.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p.x)} ${fmt(p.y)}`).join(' ') + ' Z').join(' ');
            return el(doc, 'path', { d, fill: '#000000', 'fill-rule': 'evenodd', stroke: 'none' });
        }
        if (prim.kind === 'ellipse') {
            const attrs = {
                cx: fmt(prim.cx), cy: fmt(prim.cy), rx: fmt(prim.rx), ry: fmt(prim.ry),
                transform: `rotate(${fmt(prim.angle * 180 / Math.PI)} ${fmt(prim.cx)} ${fmt(prim.cy)})`
            };
            if (prim.filled) Object.assign(attrs, { fill: '#000000', stroke: 'none' });
            else Object.assign(attrs, { fill: 'none', stroke: '#000000', 'stroke-width': fmt(prim.width) });
            return el(doc, 'ellipse', attrs);
        }
        return null;
    }

    // Replace the prospect art inside the element group of the SVG document.
    // rendered = { dots: [[cx, cy, r]], tone: { canvas, x, y } | null, decorations: Map(id -> prims),
    //              clipD: path data of the prospect outline }
    function writeArt(elementGroup, model, rendered) {
        const doc = elementGroup.ownerDocument;
        elementGroup.querySelectorAll('g.prospect-art, g.shading').forEach(g => g.parentNode.removeChild(g));

        const safeId = model.element.replace(/^element_/, '');
        const art = el(doc, 'g', { class: 'prospect-art', id: `prospect_art_${safeId}` });
        // Decorations are cut by the outline of the prospect
        const clipId = `prospect_clip_${safeId}`;
        if (rendered.clipD) {
            const clip = el(doc, 'clipPath', { id: clipId });
            // even-odd: the hole of a handle stays out of the clip
            clip.appendChild(el(doc, 'path', { d: rendered.clipD, 'clip-rule': 'evenodd' }));
            art.appendChild(clip);
        }
        const meta = el(doc, 'metadata', { class: 'prospect-model' });
        meta.textContent = JSON.stringify(model);
        art.appendChild(meta);

        if (model.shading.mode === 'stipple' && rendered.dots && rendered.dots.length) {
            const g = el(doc, 'g', { class: 'shading', id: `${safeId}_shading`, 'data-mode': 'stipple', fill: '#000000', stroke: 'none' });
            for (const [cx, cy, r] of rendered.dots) g.appendChild(el(doc, 'circle', { cx: fmt(cx), cy: fmt(cy), r: fmt(r) }));
            art.appendChild(g);
        } else if (model.shading.mode === 'tone' && rendered.tone) {
            const g = el(doc, 'g', { class: 'shading', id: `${safeId}_shading`, 'data-mode': 'tone', stroke: 'none' });
            const url = rendered.tone.canvas.toDataURL('image/png');
            const img = el(doc, 'image', {
                x: rendered.tone.x, y: rendered.tone.y,
                width: rendered.tone.canvas.width, height: rendered.tone.canvas.height,
                preserveAspectRatio: 'none', href: url
            });
            img.setAttributeNS(XLINK_NS, 'xlink:href', url);  // older viewers (Illustrator)
            g.appendChild(img);
            // A handle that goes beyond the prospect is cut by its outline
            if (rendered.clipD && rendered.frontEdges && rendered.frontEdges.length) g.setAttribute('clip-path', `url(#${clipId})`);
            art.appendChild(g);
        }

        // Side lines of the handles in front view: strokes of varying weight, as filled outlines
        if (rendered.frontEdges && rendered.frontEdges.length) {
            const g = el(doc, 'g', { class: 'handle-front', id: `${safeId}_handle_front`, fill: '#000000', stroke: 'none' });
            if (rendered.clipD) g.setAttribute('clip-path', `url(#${clipId})`);
            for (const pl of rendered.frontEdges) {
                const pts = window.ProspectGeometry.ribbon(pl, pl.w);
                g.appendChild(el(doc, 'path', { d: pts.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p.x)} ${fmt(p.y)}`).join(' ') + ' Z' }));
            }
            art.appendChild(g);
        }

        for (const deco of model.decorations) {
            const prims = rendered.decorations.get(deco.id) || [];
            if (!prims.length) continue;
            const g = el(doc, 'g', { class: 'decoration', id: `${safeId}_${deco.id}`, 'data-brush': deco.brush });
            if (rendered.clipD) g.setAttribute('clip-path', `url(#${clipId})`);
            for (const prim of prims) {
                const node = primitiveToSvg(doc, prim);
                if (node) g.appendChild(node);
            }
            art.appendChild(g);
        }
        elementGroup.appendChild(art);
    }

    window.ProspectModel = { defaultModel, readModel, History, writeArt };
})();
