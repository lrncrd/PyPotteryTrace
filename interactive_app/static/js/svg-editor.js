// SVG Editor - Manager for editing exported SVG files
// Allows viewing, selecting, and deleting points from SVG paths

class SVGEditor {
    constructor(canvasId) {
        console.log('SVGEditor constructor called with canvasId:', canvasId);

        this.canvas = document.getElementById(canvasId);

        if (!this.canvas) {
            console.error('Canvas element not found:', canvasId);
            return;
        }

        console.log('Canvas element found:', this.canvas);

        this.ctx = this.canvas.getContext('2d');

        if (!this.ctx) {
            console.error('Failed to get 2D context');
            return;
        }

        console.log('Canvas context initialized');

        // SVG data
        this.svgData = null;
        this.layers = [];
        this.paths = [];  // All paths with their points
        this.images = []; // PNG/image layers
        this.layerCategories = {}; // Organized by category (Profile, Symmetry, etc.)
        this.layerVisibility = {}; // Track which layers are visible
        this.imageVisibility = {}; // Track which images are visible
        this.collapsedCategories = new Set(); // Track collapsed layer categories

        // ZIP download URL (set by app.js after export)
        this.zipDownloadUrl = null;
        this.sessionId = null;  // Session ID for backend communication
        this.currentImageName = null;  // Current image name for output filename
        this.currentProjectId = null;  // Current project ID for saving

        // View transform
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Selection & Dragging
        this.selectedPoints = [];
        this.hoveredPoint = null;
        this.draggedPoint = null; // Legacy point being dragged
        this.draggedImage = null; // Image layer being dragged
        this.dragPointState = null; // { active: bool, startX, startY, clickedPoint, isShift, wasAlreadySelected, targets }
        this.isSelectingBox = false; // Whether marquee box selection is in progress
        this.selectionBox = null; // { startX, startY, currentX, currentY, isShift, initialSelected: [] }
        this.isSpacePressed = false; // Spacebar held for panning
        this.contextMenuElement = null; // DOM element for custom context menu
        this.pendingReconstructPoint = null; // Break point picked in Continuation Line mode, awaiting its reference point
        this.drawingLineStart = null; // Start point for Internal Details straight line drawing
        this.drawingLineCurrent = null; // Current end point preview for Internal Details
        this.isDrawingLine = false; // Whether line drag is actively in progress
        this.lineDragMoved = false; // Whether drag moved enough to qualify as drag-and-release

        // Continuation Line mode walks the primary profile in two phases: 'outer'
        // (the face that gets mirrored) first, then 'inner' (the fracture-section
        // face that never is). reconstructZones (set on mode entry, see setMode)
        // holds which point indices of the primary path belong to each face; null
        // means the path is open and has no inner face, so everything is one phase.
        this.reconstructPhase = 'outer';
        this.reconstructZones = null;

        // Number of <path> elements present in the originally loaded SVG DOM.
        // Paths added later (e.g. reconstruction/continuation lines) live only in
        // this.paths beyond this count and are materialized into the DOM at export
        // time (see exportModifiedSVG) so that undo never has to reverse a DOM edit.
        this.originalPathCount = 0;

        // Pristine (pre-extension) points of the Symmetry Line path, set once per
        // loaded file - see extractPaths() and syncSymmetryLineExtension().
        this.symmetryBasePoints = null;

        // Settings
        this.pointSize = 8;
        this.continuationLength = 100;
        this.showPoints = true;
        this.showLabels = true;
        this.currentMode = 'view';  // 'view', 'select', 'delete'

        // History for undo
        this.history = [];
        this.historyIndex = -1;

        this.setupCanvas();
        this.setupEventListeners();

        console.log('SVGEditor initialization complete');
    }

    setupCanvas() {
        // Set canvas size to container
        const container = this.canvas.parentElement;
        const resizeCanvas = () => {
            // Get actual container size
            const rect = container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                this.canvas.width = rect.width;
                this.canvas.height = rect.height;
            } else {
                this.canvas.width = container.clientWidth || 800;
                this.canvas.height = container.clientHeight || 600;
            }
            console.log('Canvas resized to:', this.canvas.width, 'x', this.canvas.height);

            // Force redraw after a short delay to ensure canvas is ready
            setTimeout(() => {
                this.redraw();
            }, 10);
        };

        // Initial resize with delay
        setTimeout(resizeCanvas, 100);

        window.addEventListener('resize', resizeCanvas);

        // Also resize and reset view when tab becomes visible
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    const tab = document.getElementById('svg-editor-tab');
                    if (tab && tab.classList.contains('active')) {
                        console.log('SVG Editor tab became active, handling activation...');
                        setTimeout(() => this.handleTabActivated(), 50);
                    }
                }
            });
        });

        const svgTab = document.getElementById('svg-editor-tab');
        if (svgTab) {
            observer.observe(svgTab, { attributes: true });
        }
    }

    handleTabActivated() {
        const container = this.canvas.parentElement;
        if (container) {
            const rect = container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                this.canvas.width = rect.width;
                this.canvas.height = rect.height;
            }
        }
        if (this.svgData) {
            this.resetView();
        } else {
            this.redraw();
        }
    }

    setupEventListeners() {
        // Mouse events for pan, zoom, and selection
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        this.canvas.addEventListener('wheel', (e) => this.handleWheel(e));

        // Context menu handler (right click)
        this.canvas.addEventListener('contextmenu', (e) => {
            if (this.currentMode === 'reconstruct-spline' && this.pendingReconstructPoint) {
                e.preventDefault();
                this.pendingReconstructPoint = null;
                this.redraw();
                return;
            }
            if (this.currentMode === 'internal-details' && this.drawingLineStart) {
                e.preventDefault();
                this.drawingLineStart = null;
                this.drawingLineCurrent = null;
                this.isDrawingLine = false;
                this.lineDragMoved = false;
                this.redraw();
                return;
            }
            this.handleContextMenu(e);
        });

        // Dismiss context menu on click outside
        document.addEventListener('pointerdown', (e) => {
            if (this.contextMenuElement && !this.contextMenuElement.contains(e.target)) {
                this.closeContextMenu();
            }
        });

        window.addEventListener('resize', () => {
            this.closeContextMenu();
        });

        // Global keyboard shortcuts for SVG Editor
        document.addEventListener('keydown', (e) => {
            // Ignore if focus is in an input or textarea
            if (e.target && (e.target.matches('input, textarea, select') || e.target.isContentEditable)) {
                return;
            }

            // Only process when SVG editor tab is active
            const svgTab = document.getElementById('svg-editor-tab');
            if (svgTab && !svgTab.classList.contains('active')) {
                return;
            }

            // Spacebar for panning
            if (e.code === 'Space' && !e.repeat) {
                this.isSpacePressed = true;
                this.canvas.style.cursor = 'grab';
            }

            // Escape
            if (e.key === 'Escape') {
                if (this.contextMenuElement) {
                    this.closeContextMenu();
                    return;
                }
                if (this.pendingReconstructPoint) {
                    this.pendingReconstructPoint = null;
                    this.redraw();
                    return;
                }
                if (this.drawingLineStart) {
                    this.drawingLineStart = null;
                    this.drawingLineCurrent = null;
                    this.isDrawingLine = false;
                    this.lineDragMoved = false;
                    this.redraw();
                    return;
                }
                if (this.selectedPoints.length > 0) {
                    this.selectedPoints = [];
                    this.updateSelectionInfo();
                    this.redraw();
                    return;
                }
            }

            // Delete / Backspace: delete selected points
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.selectedPoints.length > 0) {
                    e.preventDefault();
                    this.deletePointsDirectly();
                    return;
                }
            }

            // Ctrl+Z / Cmd+Z: Undo
            if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
                e.preventDefault();
                this.undo();
                return;
            }

            // Ctrl+A / Cmd+A: Select all points
            if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
                if (this.currentMode === 'select') {
                    e.preventDefault();
                    this.selectAllPoints();
                    return;
                }
            }

            // Arrow keys: nudge selected points
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                if (this.selectedPoints.length > 0 && this.currentMode === 'select') {
                    e.preventDefault();
                    const step = e.shiftKey ? 10 : 1;
                    let dx = 0, dy = 0;
                    if (e.key === 'ArrowUp') dy = -step;
                    else if (e.key === 'ArrowDown') dy = step;
                    else if (e.key === 'ArrowLeft') dx = -step;
                    else if (e.key === 'ArrowRight') dx = step;
                    this.nudgeSelectedPoints(dx, dy);
                    return;
                }
            }

            // Shift pressed during point drag: snap to 90 degrees immediately
            if (e.key === 'Shift' && this.dragPointState && this.dragPointState.active) {
                this.updatePointDrag(this.lastMouseX, this.lastMouseY, true);
            }

            // Shift pressed during line drawing: snap to 90 degrees immediately
            if (e.key === 'Shift' && this.currentMode === 'internal-details' && this.drawingLineStart && this.lastMouseX !== undefined) {
                const mouseSvg = this.screenToSvg(this.lastMouseX, this.lastMouseY);
                this.drawingLineCurrent = this.constrainTo90(this.drawingLineStart, mouseSvg);
                this.redraw();
            }
        });

        document.addEventListener('keyup', (e) => {
            // Shift released during point drag: release 90-degree constraint immediately
            if (e.key === 'Shift' && this.dragPointState && this.dragPointState.active) {
                this.updatePointDrag(this.lastMouseX, this.lastMouseY, false);
            }

            // Shift released during line drawing: release 90-degree constraint immediately
            if (e.key === 'Shift' && this.currentMode === 'internal-details' && this.drawingLineStart && this.lastMouseX !== undefined) {
                this.drawingLineCurrent = this.screenToSvg(this.lastMouseX, this.lastMouseY);
                this.redraw();
            }

            if (e.code === 'Space') {
                this.isSpacePressed = false;
                if (!this.isDragging) {
                    const cursors = {
                        'view': 'grab',
                        'select': 'crosshair',
                        'delete': 'not-allowed',
                        'reconstruct-spline': 'crosshair',
                        'internal-details': 'crosshair'
                    };
                    this.canvas.style.cursor = cursors[this.currentMode] || 'default';
                }
            }
        });

        // Mode buttons
        document.querySelectorAll('[data-svg-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setMode(btn.dataset.svgMode);
            });
        });

        // Settings
        document.getElementById('svg-point-size-slider').addEventListener('input', (e) => {
            this.pointSize = parseInt(e.target.value);
            document.getElementById('svg-point-size-value').textContent = this.pointSize;
            this.redraw();
        });

        const continuationSlider = document.getElementById('svg-continuation-length-slider');
        if (continuationSlider) {
            continuationSlider.addEventListener('input', (e) => {
                this.continuationLength = parseInt(e.target.value, 10);
                const valElem = document.getElementById('svg-continuation-length-value');
                if (valElem) valElem.textContent = this.continuationLength;
            });
        }

        document.getElementById('svg-show-points').addEventListener('change', (e) => {
            this.showPoints = e.target.checked;
            this.redraw();
        });

        document.getElementById('svg-show-labels').addEventListener('change', (e) => {
            this.showLabels = e.target.checked;
            this.redraw();
        });

        // Toolbar
        document.getElementById('svg-zoom-in-btn').addEventListener('click', () => {
            this.zoom(1.2);
        });

        document.getElementById('svg-zoom-out-btn').addEventListener('click', () => {
            this.zoom(0.8);
        });

        document.getElementById('svg-reset-view-btn').addEventListener('click', () => {
            this.resetView();
        });

        document.getElementById('svg-undo-btn').addEventListener('click', () => {
            this.undo();
        });

        // Save button
        const saveBtn = document.getElementById('svg-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.exportModifiedSVG();
            });
        }

        // macOS-style Segmented Radio for background mode
        const bgRadios = document.querySelectorAll('input[name="svg-bg-mode"]');
        const bgDesc = document.getElementById('svg-bg-desc');
        const bgCheckbox = document.getElementById('svg-bg-checkbox');
        const optNone = document.getElementById('svg-bg-opt-none');
        const optInclude = document.getElementById('svg-bg-opt-include');

        bgRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                const isWithBg = e.target.value === 'true';
                if (optNone) optNone.classList.toggle('active', !isWithBg);
                if (optInclude) optInclude.classList.toggle('active', isWithBg);
                if (bgCheckbox) bgCheckbox.checked = isWithBg;
                if (bgDesc) {
                    bgDesc.textContent = isWithBg
                        ? 'Include the original image as background in the exported SVG'
                        : 'Export clean vector paths with transparent background';
                }
            });
        });

        // Download ZIP button (if present)
        const zipBtn = document.getElementById('svg-download-zip-btn');
        if (zipBtn) {
            zipBtn.addEventListener('click', () => {
                this.downloadCompleteZip();
            });
        }

        // Add Image button
        const addImageBtn = document.getElementById('svg-add-image-btn');

        if (addImageBtn) {
            addImageBtn.addEventListener('click', () => {
                // Load current image automatically instead of opening file picker
                if (window.app && window.app.currentImage) {
                    this.addImageFromUrl(window.app.currentImage, window.app.currentImageFilename || 'Original Image');
                } else {
                    if (window.app) {
                        window.app.showNotification('No image loaded. Please load an image first.', 'warning');
                    } else {
                        alert('No image loaded. Please load an image first.');
                    }
                }
            });
        }
    }

    setMode(mode) {
        this.closeContextMenu();
        this.isSelectingBox = false;
        this.selectionBox = null;
        this.dragPointState = null;

        const enteringSpline = mode === 'reconstruct-spline' && this.currentMode !== 'reconstruct-spline';
        this.currentMode = mode;

        // Leaving spline-continuation mode drops any half-picked break point
        if (mode !== 'reconstruct-spline') {
            this.pendingReconstructPoint = null;
        }

        // Leaving internal-details mode drops any pending line
        if (mode !== 'internal-details') {
            this.drawingLineStart = null;
            this.drawingLineCurrent = null;
            this.isDrawingLine = false;
            this.lineDragMoved = false;
        }

        // Freshly entering the mode: start over at the outer face and recompute
        // the outer/inner split from the primary path's current points.
        if (enteringSpline) {
            this.reconstructPhase = 'outer';
            const primaryPath = this.paths.find(p => this.isPrimaryProfilePath(p));
            this.reconstructZones = this.computeProfileZones(primaryPath);
        }

        // Update UI
        document.querySelectorAll('[data-svg-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.svgMode === mode);
        });

        // Update cursor
        const cursors = {
            'view': 'grab',
            'select': 'crosshair',
            'delete': 'not-allowed',
            'reconstruct-spline': 'crosshair',
            'internal-details': 'crosshair'
        };
        this.canvas.style.cursor = cursors[mode] || 'default';

        this.redraw();
    }

    async loadSVG(svgUrl) {
        try {
            console.log('Loading SVG from:', svgUrl);

            const response = await fetch(svgUrl);
            const svgText = await response.text();

            console.log('SVG text loaded, length:', svgText.length);

            // Parse SVG
            const parser = new DOMParser();
            const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
            const svgElement = svgDoc.querySelector('svg');

            if (!svgElement) {
                throw new Error('Invalid SVG file');
            }

            console.log('SVG element found:', svgElement);

            // Extract viewBox or dimensions
            const viewBox = svgElement.getAttribute('viewBox');
            let width, height;

            if (viewBox) {
                const [, , w, h] = viewBox.split(' ').map(Number);
                width = w;
                height = h;
            } else {
                width = parseFloat(svgElement.getAttribute('width')) || 1000;
                height = parseFloat(svgElement.getAttribute('height')) || 1000;
            }

            console.log('SVG dimensions:', width, 'x', height);

            this.svgData = {
                width,
                height,
                element: svgElement,
                text: svgText
            };

            // Extract paths and their points
            this.extractPaths(svgElement);

            console.log('Paths extracted:', this.paths.length);

            // Update UI
            this.updateLayersList();
            this.updateStats();
            this.resetView();

            // Hide message
            document.getElementById('svg-canvas-message').style.display = 'none';

            // Enable save button
            document.getElementById('svg-save-btn').disabled = false;

            // Enable ZIP download button if element exists and URL is available
            const zipBtn = document.getElementById('svg-download-zip-btn');
            if (zipBtn && this.zipDownloadUrl) {
                zipBtn.disabled = false;
            }

            // Save initial state
            this.saveState();

            console.log('SVG loaded successfully:', {
                width,
                height,
                totalPaths: this.paths.length,
                totalPoints: this.getTotalPoints()
            });

        } catch (error) {
            console.error('Failed to load SVG:', error);
            if (window.app) {
                window.app.showNotification('Error loading SVG: ' + error.message, 'error');
            } else {
                alert('Error loading SVG: ' + error.message);
            }
        }
    }

    extractPaths(svgElement) {
        console.log('extractPaths() called');

        this.paths = [];
        this.layers = [];
        this.images = [];
        this.layerCategories = {};
        this.layerVisibility = {};
        this.imageVisibility = {};

        // Extract all layer groups (g elements with id starting with "layer_")
        const layerGroups = svgElement.querySelectorAll('g[id^="layer_"]');

        console.log('Found', layerGroups.length, 'layer groups');

        // Categorize layers
        layerGroups.forEach((layerG, layerIndex) => {
            const layerId = layerG.getAttribute('id');

            // Extract category from layer name (e.g., "layer_Profile" -> "Profile")
            const categoryMatch = layerId.match(/^layer_(.+?)(?:_|$)/);
            const category = categoryMatch ? categoryMatch[1].replace(/_/g, ' ') : 'Other';

            if (!this.layerCategories[category]) {
                this.layerCategories[category] = [];
            }

            // Initialize visibility (all visible by default)
            this.layerVisibility[layerId] = true;

            // Extract all paths in this layer
            const pathElements = layerG.querySelectorAll('path');

            pathElements.forEach((pathEl, pathIndex) => {
                const d = pathEl.getAttribute('d');
                if (!d) return;

                // Parse path data to extract points
                const points = this.parsePathData(d);
                if (points.length === 0) return;

                // Get style
                const stroke = pathEl.getAttribute('stroke') || '#000000';
                const strokeWidth = parseFloat(pathEl.getAttribute('stroke-width')) || 1;
                const fill = pathEl.getAttribute('fill') || 'none';

                const pathData = {
                    id: `path-${this.paths.length}`,
                    layerId,
                    layerName: layerId.replace('layer_', '').replace(/_/g, ' '),
                    category,
                    element: pathEl,
                    originalD: d,
                    currentD: d,
                    points,
                    style: { stroke, strokeWidth, fill },
                    visible: true
                };

                this.paths.push(pathData);
                this.layerCategories[category].push(pathData);
            });

            this.layers.push({
                id: layerId,
                name: layerId.replace('layer_', '').replace(/_/g, ' '),
                category,
                visible: true
            });
        });

        // Extract standalone paths (not in a layer group)
        const standalonePaths = svgElement.querySelectorAll('svg > path');
        if (standalonePaths.length > 0) {
            const category = 'Ungrouped';
            if (!this.layerCategories[category]) {
                this.layerCategories[category] = [];
            }

            standalonePaths.forEach((pathEl, index) => {
                const d = pathEl.getAttribute('d');
                if (!d) return;

                const points = this.parsePathData(d);
                if (points.length === 0) return;

                const stroke = pathEl.getAttribute('stroke') || '#000000';
                const strokeWidth = parseFloat(pathEl.getAttribute('stroke-width')) || 1;
                const fill = pathEl.getAttribute('fill') || 'none';

                const layerId = `standalone-${index}`;
                this.layerVisibility[layerId] = true;

                const pathData = {
                    id: `path-${this.paths.length}`,
                    layerId,
                    layerName: `Standalone ${index + 1}`,
                    category,
                    element: pathEl,
                    originalD: d,
                    currentD: d,
                    points,
                    style: { stroke, strokeWidth, fill },
                    visible: true
                };

                this.paths.push(pathData);
                this.layerCategories[category].push(pathData);
            });
        }

        // Extract images (PNG layers)
        const imageElements = svgElement.querySelectorAll('image');
        console.log('Found', imageElements.length, 'image elements');

        imageElements.forEach((imgEl, index) => {
            const href = imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href');
            if (!href) return;

            const x = parseFloat(imgEl.getAttribute('x')) || 0;
            const y = parseFloat(imgEl.getAttribute('y')) || 0;
            const width = parseFloat(imgEl.getAttribute('width')) || 100;
            const height = parseFloat(imgEl.getAttribute('height')) || 100;
            const opacity = parseFloat(imgEl.getAttribute('opacity')) || 1;

            const imgId = imgEl.getAttribute('id') || `image-${index}`;
            this.imageVisibility[imgId] = true;

            // Load image
            const img = new Image();
            img.src = href;

            const imageData = {
                id: imgId,
                name: imgId.replace(/_/g, ' ') || `Image ${index + 1}`,
                element: imgEl,
                img,
                x,
                y,
                width,
                height,
                opacity,
                visible: true,
                loaded: false
            };

            img.onload = () => {
                imageData.loaded = true;
                this.redraw();
            };

            this.images.push(imageData);
        });

        this.originalPathCount = this.paths.length;

        // Remember the symmetry line's pristine geometry (before any continuation-
        // driven extension) so that extension can always be recomputed fresh from
        // it, rather than compounding onto whatever it currently looks like.
        const symmetryPath = this.paths.find(p => p.category === 'Symmetry' || /symmetry/i.test(p.layerId));
        this.symmetryBasePoints = symmetryPath
            ? symmetryPath.points.map(p => ({ ...p }))
            : null;

        console.log('Extracted:', {
            paths: this.paths.length,
            layers: this.layers.length,
            images: this.images.length,
            categories: Object.keys(this.layerCategories)
        });
    }

    parsePathData(d) {
        // Parse SVG path data to extract points
        // Supports M, L, H, V, C, S, Q, T, Z commands
        const points = [];

        // Regex to match path commands and their coordinates
        const commandRegex = /([MLHVCSQTAZmlhvcsqtaz])\s*([^MLHVCSQTAZmlhvcsqtaz]*)/gi;
        let match;

        let currentX = 0;
        let currentY = 0;
        let startX = 0;
        let startY = 0;
        let lastControlX = 0;
        let lastControlY = 0;
        let lastCmd = '';

        while ((match = commandRegex.exec(d)) !== null) {
            const cmd = match[1];
            const isRelative = cmd === cmd.toLowerCase();
            const cmdUpper = cmd.toUpperCase();

            const coords = match[2].trim()
                .split(/[\s,]+/)
                .filter(c => c)
                .map(Number);

            switch (cmdUpper) {
                case 'M': // Move to
                    if (coords.length >= 2) {
                        currentX = isRelative ? currentX + coords[0] : coords[0];
                        currentY = isRelative ? currentY + coords[1] : coords[1];
                        startX = currentX;
                        startY = currentY;
                        points.push({ x: currentX, y: currentY, cmd: 'M', index: points.length });

                        // Additional coordinate pairs after M are treated as L
                        for (let i = 2; i < coords.length; i += 2) {
                            if (i + 1 < coords.length) {
                                currentX = isRelative ? currentX + coords[i] : coords[i];
                                currentY = isRelative ? currentY + coords[i + 1] : coords[i + 1];
                                points.push({ x: currentX, y: currentY, cmd: 'L', index: points.length });
                            }
                        }
                    }
                    break;

                case 'L': // Line to
                    for (let i = 0; i < coords.length; i += 2) {
                        if (i + 1 < coords.length) {
                            currentX = isRelative ? currentX + coords[i] : coords[i];
                            currentY = isRelative ? currentY + coords[i + 1] : coords[i + 1];
                            points.push({ x: currentX, y: currentY, cmd: 'L', index: points.length });
                        }
                    }
                    break;

                case 'H': // Horizontal line
                    coords.forEach(x => {
                        currentX = isRelative ? currentX + x : x;
                        points.push({ x: currentX, y: currentY, cmd: 'H', index: points.length });
                    });
                    break;

                case 'V': // Vertical line
                    coords.forEach(y => {
                        currentY = isRelative ? currentY + y : y;
                        points.push({ x: currentX, y: currentY, cmd: 'V', index: points.length });
                    });
                    break;

                case 'C': // Cubic Bezier
                    for (let i = 0; i < coords.length; i += 6) {
                        if (i + 5 < coords.length) {
                            const cp1x = isRelative ? currentX + coords[i] : coords[i];
                            const cp1y = isRelative ? currentY + coords[i + 1] : coords[i + 1];
                            const cp2x = isRelative ? currentX + coords[i + 2] : coords[i + 2];
                            const cp2y = isRelative ? currentY + coords[i + 3] : coords[i + 3];
                            const x = isRelative ? currentX + coords[i + 4] : coords[i + 4];
                            const y = isRelative ? currentY + coords[i + 5] : coords[i + 5];

                            points.push({ x: cp1x, y: cp1y, cmd: 'C1', index: points.length });
                            points.push({ x: cp2x, y: cp2y, cmd: 'C2', index: points.length });
                            points.push({ x: x, y: y, cmd: 'C', index: points.length });

                            lastControlX = cp2x;
                            lastControlY = cp2y;
                            currentX = x;
                            currentY = y;
                        }
                    }
                    break;

                case 'S': // Smooth cubic Bezier (shorthand)
                    for (let i = 0; i < coords.length; i += 4) {
                        if (i + 3 < coords.length) {
                            // First control point is reflection of last control point
                            let cp1x, cp1y;
                            if (lastCmd === 'C' || lastCmd === 'S') {
                                cp1x = 2 * currentX - lastControlX;
                                cp1y = 2 * currentY - lastControlY;
                            } else {
                                cp1x = currentX;
                                cp1y = currentY;
                            }

                            const cp2x = isRelative ? currentX + coords[i] : coords[i];
                            const cp2y = isRelative ? currentY + coords[i + 1] : coords[i + 1];
                            const x = isRelative ? currentX + coords[i + 2] : coords[i + 2];
                            const y = isRelative ? currentY + coords[i + 3] : coords[i + 3];

                            points.push({ x: cp1x, y: cp1y, cmd: 'C1', index: points.length });
                            points.push({ x: cp2x, y: cp2y, cmd: 'C2', index: points.length });
                            points.push({ x: x, y: y, cmd: 'C', index: points.length });

                            lastControlX = cp2x;
                            lastControlY = cp2y;
                            currentX = x;
                            currentY = y;
                        }
                    }
                    break;

                case 'Q': // Quadratic Bezier
                    for (let i = 0; i < coords.length; i += 4) {
                        if (i + 3 < coords.length) {
                            const cpx = isRelative ? currentX + coords[i] : coords[i];
                            const cpy = isRelative ? currentY + coords[i + 1] : coords[i + 1];
                            const x = isRelative ? currentX + coords[i + 2] : coords[i + 2];
                            const y = isRelative ? currentY + coords[i + 3] : coords[i + 3];

                            points.push({ x: cpx, y: cpy, cmd: 'Q1', index: points.length });
                            points.push({ x: x, y: y, cmd: 'Q', index: points.length });

                            lastControlX = cpx;
                            lastControlY = cpy;
                            currentX = x;
                            currentY = y;
                        }
                    }
                    break;

                case 'T': // Smooth quadratic Bezier
                    for (let i = 0; i < coords.length; i += 2) {
                        if (i + 1 < coords.length) {
                            // Control point is reflection of last control point
                            let cpx, cpy;
                            if (lastCmd === 'Q' || lastCmd === 'T') {
                                cpx = 2 * currentX - lastControlX;
                                cpy = 2 * currentY - lastControlY;
                            } else {
                                cpx = currentX;
                                cpy = currentY;
                            }

                            const x = isRelative ? currentX + coords[i] : coords[i];
                            const y = isRelative ? currentY + coords[i + 1] : coords[i + 1];

                            points.push({ x: cpx, y: cpy, cmd: 'Q1', index: points.length });
                            points.push({ x: x, y: y, cmd: 'Q', index: points.length });

                            lastControlX = cpx;
                            lastControlY = cpy;
                            currentX = x;
                            currentY = y;
                        }
                    }
                    break;

                case 'Z': // Close path
                    if (currentX !== startX || currentY !== startY) {
                        points.push({ x: startX, y: startY, cmd: 'Z', index: points.length });
                    }
                    currentX = startX;
                    currentY = startY;
                    break;
            }

            lastCmd = cmdUpper;
        }

        return points;
    }

    handleMouseDown(e) {
        this.closeContextMenu();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Middle mouse button OR Space+click (pan) - Works in ANY mode
        if (e.button === 1 || (this.isSpacePressed && e.button === 0)) {
            e.preventDefault();
            this.isDragging = true;
            this.lastMouseX = mouseX;
            this.lastMouseY = mouseY;
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        if (e.button !== 0) return; // Only process left clicks here

        if (this.currentMode === 'view') {
            // Check if clicking on an image first
            const clickedImage = this.findImageAt(mouseX, mouseY);

            if (clickedImage) {
                // Check if image is locked
                if (clickedImage.isLocked) {
                    // Locked image - pan the view instead
                    this.isDragging = true;
                    this.lastMouseX = mouseX;
                    this.lastMouseY = mouseY;
                    this.canvas.style.cursor = 'grabbing';
                } else if (!e.shiftKey) {
                    // Direct click on image = drag image
                    this.draggedImage = clickedImage;
                    this.lastMouseX = mouseX;
                    this.lastMouseY = mouseY;
                    this.canvas.style.cursor = 'move';
                    this.saveState(); // Save state before dragging
                } else {
                    // Shift + click on image = pan view (override image drag)
                    this.isDragging = true;
                    this.lastMouseX = mouseX;
                    this.lastMouseY = mouseY;
                    this.canvas.style.cursor = 'grabbing';
                }
            } else {
                // Click on empty area = pan the view
                this.isDragging = true;
                this.lastMouseX = mouseX;
                this.lastMouseY = mouseY;
                this.canvas.style.cursor = 'grabbing';
            }
        } else if (this.currentMode === 'select') {
            // Check if clicking on a point
            const clickedPoint = this.findPointAt(mouseX, mouseY);

            if (clickedPoint) {
                const isAlreadySelected = this.selectedPoints.some(
                    p => p.pathId === clickedPoint.pathId && p.pointIndex === clickedPoint.pointIndex
                );

                if (!isAlreadySelected) {
                    if (e.shiftKey) {
                        this.selectedPoints.push(clickedPoint);
                    } else {
                        this.selectedPoints = [clickedPoint];
                    }
                    this.updateSelectionInfo();
                    this.redraw();
                }

                // Prepare drag state for selected points
                const targets = this.getPointsAndAttachedHandlesToMove(this.selectedPoints);
                for (const item of targets.items) {
                    item.origX = item.point.x;
                    item.origY = item.point.y;
                }

                this.dragPointState = {
                    active: false,
                    startX: mouseX,
                    startY: mouseY,
                    clickedPoint: clickedPoint,
                    isShift: e.shiftKey,
                    wasAlreadySelected: isAlreadySelected,
                    targets: targets
                };

                this.lastMouseX = mouseX;
                this.lastMouseY = mouseY;
            } else {
                // Click on empty space: start marquee box selection
                this.isSelectingBox = true;
                this.selectionBox = {
                    startX: mouseX,
                    startY: mouseY,
                    currentX: mouseX,
                    currentY: mouseY,
                    isShift: e.shiftKey,
                    initialSelected: e.shiftKey ? [...this.selectedPoints] : []
                };
            }
        } else if (this.currentMode === 'add') {
            // Add point mode - click on path to insert a new point
            const clickedPoint = this.findPointAt(mouseX, mouseY);

            if (!clickedPoint) {
                // No existing point clicked, try to find nearest path segment
                this.addPointOnPath(mouseX, mouseY);
            }
        } else if (this.currentMode === 'delete') {
            // Delete point
            const clickedPoint = this.findPointAt(mouseX, mouseY);

            if (clickedPoint) {
                this.deletePoint(clickedPoint);
            }
        } else if (this.currentMode === 'reconstruct-spline') {
            const clickedPoint = this.findPointAt(
                mouseX, mouseY,
                p => this.isPrimaryProfilePath(p),
                (p, i) => this.isPointInActiveReconstructZone(i)
            );

            if (!clickedPoint || !this.isAnchorPoint(clickedPoint.point)) {
                return;
            }

            if (!this.pendingReconstructPoint) {
                this.pendingReconstructPoint = clickedPoint;
                this.redraw();
            } else {
                const breakPoint = this.pendingReconstructPoint;
                const referencePoint = clickedPoint;
                this.pendingReconstructPoint = null;

                if (referencePoint.pathId === breakPoint.pathId && referencePoint.pointIndex === breakPoint.pointIndex) {
                    this.redraw();
                    return;
                }

                const wasOuterPhase = this.reconstructPhase === 'outer';
                this.addProjectionContinuation(breakPoint, referencePoint, { mirror: wasOuterPhase });

                if (wasOuterPhase && this.reconstructZones && this.reconstructZones.innerIndices.size > 0) {
                    this.reconstructPhase = 'inner';
                    const msg = 'Now click the break point on the inner (fracture-section) face — it will not be mirrored.';
                    if (window.app) window.app.showNotification(msg, 'info');
                    this.redraw();
                } else {
                    this.reconstructPhase = 'outer';
                }
            }
        } else if (this.currentMode === 'internal-details') {
            const snapped = this.findPointAt(mouseX, mouseY);
            const pt = (snapped && this.isAnchorPoint(snapped.point))
                ? { x: snapped.point.x, y: snapped.point.y }
                : this.screenToSvg(mouseX, mouseY);

            if (!this.drawingLineStart) {
                // First click / drag start
                this.drawingLineStart = pt;
                this.drawingLineCurrent = pt;
                this.isDrawingLine = true;
                this.lineDragMoved = false;
                this.redraw();
            } else {
                // Second click of click-then-click mode
                let endPt = pt;
                if (e.shiftKey) {
                    endPt = this.constrainTo90(this.drawingLineStart, endPt);
                }
                const screenDist = Math.hypot(
                    (endPt.x - this.drawingLineStart.x) * this.scale,
                    (endPt.y - this.drawingLineStart.y) * this.scale
                );
                if (screenDist > 3) {
                    this.commitInternalDetailLine(this.drawingLineStart, endPt);
                } else {
                    this.drawingLineStart = null;
                    this.drawingLineCurrent = null;
                    this.isDrawingLine = false;
                    this.lineDragMoved = false;
                    this.redraw();
                }
            }
        }
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (this.dragPointState) {
            const dist = Math.hypot(mouseX - this.dragPointState.startX, mouseY - this.dragPointState.startY);
            if (!this.dragPointState.active && dist > 3) {
                this.dragPointState.active = true;
                this.saveState();
                this.canvas.style.cursor = 'move';
            }

            if (this.dragPointState.active) {
                this.lastMouseX = mouseX;
                this.lastMouseY = mouseY;
                this.updatePointDrag(mouseX, mouseY, e.shiftKey);
                return;
            }
        } else if (this.isSelectingBox && this.selectionBox) {
            this.selectionBox.currentX = mouseX;
            this.selectionBox.currentY = mouseY;

            const minX = Math.min(this.selectionBox.startX, mouseX);
            const maxX = Math.max(this.selectionBox.startX, mouseX);
            const minY = Math.min(this.selectionBox.startY, mouseY);
            const maxY = Math.max(this.selectionBox.startY, mouseY);

            // Find all points inside bounding box
            const enclosedPoints = [];
            for (const path of this.paths) {
                const layerVisible = this.layerVisibility[path.layerId] !== false;
                if (!path.visible || !layerVisible) continue;

                for (let i = 0; i < path.points.length; i++) {
                    const point = path.points[i];
                    const sx = point.x * this.scale + this.offsetX;
                    const sy = point.y * this.scale + this.offsetY;

                    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
                        enclosedPoints.push({
                            pathId: path.id,
                            pointIndex: i,
                            point: point,
                            path: path
                        });
                    }
                }
            }

            if (this.selectionBox.isShift) {
                const combined = [...this.selectionBox.initialSelected];
                for (const pt of enclosedPoints) {
                    if (!combined.some(p => p.pathId === pt.pathId && p.pointIndex === pt.pointIndex)) {
                        combined.push(pt);
                    }
                }
                this.selectedPoints = combined;
            } else {
                this.selectedPoints = enclosedPoints;
            }

            this.updateSelectionInfo();
            this.redraw();
            return;
        } else if (this.draggedPoint) {
            const dx = (mouseX - this.lastMouseX) / this.scale;
            const dy = (mouseY - this.lastMouseY) / this.scale;

            this.draggedPoint.point.x += dx;
            this.draggedPoint.point.y += dy;

            this.rebuildPathData(this.draggedPoint.path);

            this.lastMouseX = mouseX;
            this.lastMouseY = mouseY;

            this.redraw();
        } else if (this.draggedImage) {
            const dx = (mouseX - this.lastMouseX) / this.scale;
            const dy = (mouseY - this.lastMouseY) / this.scale;

            this.draggedImage.x += dx;
            this.draggedImage.y += dy;

            this.lastMouseX = mouseX;
            this.lastMouseY = mouseY;

            this.redraw();
        } else if (this.isDragging) {
            const dx = mouseX - this.lastMouseX;
            const dy = mouseY - this.lastMouseY;

            this.offsetX += dx;
            this.offsetY += dy;

            this.lastMouseX = mouseX;
            this.lastMouseY = mouseY;

            this.redraw();
        } else if (this.currentMode === 'select' || this.currentMode === 'delete' || this.currentMode === 'add' ||
                   this.currentMode === 'reconstruct-spline') {
            const hoverFilter = this.currentMode === 'reconstruct-spline'
                ? (p => this.isPrimaryProfilePath(p))
                : null;
            const hoverPointFilter = this.currentMode === 'reconstruct-spline'
                ? ((p, i) => this.isPointInActiveReconstructZone(i))
                : null;
            const hoveredPoint = this.findPointAt(mouseX, mouseY, hoverFilter, hoverPointFilter);

            if (hoveredPoint !== this.hoveredPoint) {
                this.hoveredPoint = hoveredPoint;

                if (this.currentMode === 'select') {
                    if (hoveredPoint) {
                        this.canvas.style.cursor = 'move';
                    } else if (this.isSpacePressed) {
                        this.canvas.style.cursor = 'grab';
                    } else {
                        this.canvas.style.cursor = 'crosshair';
                    }
                } else if (this.currentMode === 'add') {
                    this.canvas.style.cursor = 'crosshair';
                } else if (this.currentMode === 'delete') {
                    this.canvas.style.cursor = hoveredPoint ? 'crosshair' : 'default';
                } else if (this.currentMode === 'reconstruct-spline') {
                    this.canvas.style.cursor = 'crosshair';
                }

                this.redraw();
            }
        } else if (this.currentMode === 'internal-details') {
            this.lastMouseX = mouseX;
            this.lastMouseY = mouseY;

            if (this.drawingLineStart) {
                const snapped = (!e.shiftKey) ? this.findPointAt(mouseX, mouseY) : null;
                let currentPt = (snapped && this.isAnchorPoint(snapped.point))
                    ? { x: snapped.point.x, y: snapped.point.y }
                    : this.screenToSvg(mouseX, mouseY);

                if (e.shiftKey) {
                    currentPt = this.constrainTo90(this.drawingLineStart, currentPt);
                }

                this.drawingLineCurrent = currentPt;

                if (this.isDrawingLine) {
                    const dragDist = Math.hypot(
                        (currentPt.x - this.drawingLineStart.x) * this.scale,
                        (currentPt.y - this.drawingLineStart.y) * this.scale
                    );
                    if (dragDist > 3) {
                        this.lineDragMoved = true;
                    }
                }

                this.redraw();
            } else {
                const hoveredPoint = this.findPointAt(mouseX, mouseY);
                if (hoveredPoint !== this.hoveredPoint) {
                    this.hoveredPoint = hoveredPoint;
                    this.redraw();
                }
                this.canvas.style.cursor = 'crosshair';
            }
        } else if (this.currentMode === 'view') {
            const hoveredImage = this.findImageAt(mouseX, mouseY);
            if (hoveredImage && e.shiftKey) {
                this.canvas.style.cursor = 'move';
            } else {
                this.canvas.style.cursor = 'grab';
            }
        }
    }

    handleMouseUp(e) {
        if (this.currentMode === 'internal-details') {
            if (this.isDrawingLine && this.lineDragMoved && this.drawingLineStart && this.drawingLineCurrent) {
                const screenDist = Math.hypot(
                    (this.drawingLineCurrent.x - this.drawingLineStart.x) * this.scale,
                    (this.drawingLineCurrent.y - this.drawingLineStart.y) * this.scale
                );
                if (screenDist > 3) {
                    this.commitInternalDetailLine(this.drawingLineStart, this.drawingLineCurrent);
                } else {
                    this.drawingLineStart = null;
                    this.drawingLineCurrent = null;
                    this.isDrawingLine = false;
                    this.lineDragMoved = false;
                    this.redraw();
                }
            } else if (this.isDrawingLine && !this.lineDragMoved) {
                this.isDrawingLine = false;
            }
            return;
        }

        if (this.dragPointState) {
            if (this.dragPointState.active) {
                this.updateStats();
                document.getElementById('svg-undo-btn').disabled = false;
            } else {
                // Click on point without dragging
                if (this.dragPointState.isShift && this.dragPointState.wasAlreadySelected) {
                    const cp = this.dragPointState.clickedPoint;
                    this.selectedPoints = this.selectedPoints.filter(
                        p => !(p.pathId === cp.pathId && p.pointIndex === cp.pointIndex)
                    );
                    this.updateSelectionInfo();
                }
            }
            this.dragPointState = null;
            this.canvas.style.cursor = this.hoveredPoint ? 'move' : (this.currentMode === 'select' ? 'crosshair' : 'default');
            this.redraw();
        } else if (this.isSelectingBox && this.selectionBox) {
            const dist = Math.hypot(
                this.selectionBox.currentX - this.selectionBox.startX,
                this.selectionBox.currentY - this.selectionBox.startY
            );
            if (dist < 4 && !this.selectionBox.isShift) {
                // Click on empty space: deselect all
                this.selectedPoints = [];
                this.updateSelectionInfo();
            }
            this.isSelectingBox = false;
            this.selectionBox = null;
            this.updateStats();
            this.canvas.style.cursor = this.currentMode === 'select' ? 'crosshair' : 'default';
            this.redraw();
        } else if (this.draggedPoint) {
            this.draggedPoint = null;
            this.canvas.style.cursor = 'pointer';
            this.updateStats();
        } else if (this.draggedImage) {
            this.draggedImage = null;
            this.canvas.style.cursor = 'grab';
        } else if (this.isDragging) {
            this.isDragging = false;
            const cursors = {
                'view': 'grab',
                'select': 'crosshair',
                'delete': 'not-allowed',
                'reconstruct-spline': 'crosshair',
                'internal-details': 'crosshair'
            };
            this.canvas.style.cursor = this.isSpacePressed ? 'grab' : (cursors[this.currentMode] || 'default');
        }
    }

    // Updates point positions during drag, with optional 90° constraint (horizontal / vertical) when Shift is held
    updatePointDrag(mouseX, mouseY, isShift) {
        if (!this.dragPointState || !this.dragPointState.active) return;

        let totalDx = (mouseX - this.dragPointState.startX) / this.scale;
        let totalDy = (mouseY - this.dragPointState.startY) / this.scale;

        // Shift key: constrain movement to 90 degrees (horizontal or vertical, whichever has larger displacement)
        if (isShift) {
            if (Math.abs(totalDx) >= Math.abs(totalDy)) {
                totalDy = 0;
            } else {
                totalDx = 0;
            }
        }

        for (const item of this.dragPointState.targets.items) {
            item.point.x = item.origX + totalDx;
            item.point.y = item.origY + totalDy;
        }

        for (const path of this.dragPointState.targets.paths) {
            this.rebuildPathData(path);
        }

        this.redraw();
    }

    // Convert screen coordinates (canvas pixels) to SVG coordinate space
    screenToSvg(screenX, screenY) {
        return {
            x: (screenX - this.offsetX) / this.scale,
            y: (screenY - this.offsetY) / this.scale
        };
    }

    // Convert SVG coordinates to screen coordinates (canvas pixels)
    svgToScreen(svgX, svgY) {
        return {
            x: svgX * this.scale + this.offsetX,
            y: svgY * this.scale + this.offsetY
        };
    }

    // Constrains p2 relative to p1 to 90 degrees (strictly horizontal or vertical)
    constrainTo90(p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
            return { x: p2.x, y: p1.y };
        } else {
            return { x: p1.x, y: p2.y };
        }
    }

    // Commits a newly drawn straight internal detail line
    commitInternalDetailLine(p1, p2) {
        this.saveState();
        const d = `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} L ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
        this.createDetailPath(d);
        this.drawingLineStart = null;
        this.drawingLineCurrent = null;
        this.isDrawingLine = false;
        this.lineDragMoved = false;

        const msg = 'Internal detail line added — adjust nodes in Select mode.';
        if (window.app) window.app.showNotification(msg, 'success');
        this.redraw();
    }

    // Creates an internal detail path in memory (layer_Detail / category Detail)
    createDetailPath(d) {
        const layerId = 'layer_Detail';
        const category = 'Detail';

        const existingLayer = this.layers.find(l => l.id === layerId);
        if (!existingLayer) {
            this.layers.push({ id: layerId, name: 'Internal Details', category, visible: true });
        }
        if (this.layerVisibility[layerId] === undefined) {
            this.layerVisibility[layerId] = true;
        }
        if (!this.layerCategories[category]) {
            this.layerCategories[category] = [];
        }

        const stroke = '#000000';
        const strokeWidth = 0.8;
        const fill = 'none';

        const pathData = {
            id: `path-${this.paths.length}`,
            layerId,
            layerName: 'Internal Details',
            category,
            element: null,
            originalD: d,
            currentD: d,
            points: this.parsePathData(d),
            stroke,
            strokeWidth,
            fill,
            style: { stroke, strokeWidth, fill },
            visible: true
        };

        this.paths.push(pathData);
        this.layerCategories[category].push(pathData);

        this.updateLayersList();
        this.updateStats();
        this.redraw();

        return pathData;
    }

    // Helper to find all selected points plus attached curve handles for smooth dragging
    getPointsAndAttachedHandlesToMove(pointsToMove) {
        const moveMap = new Map();
        const affectedPaths = new Set();

        for (const ptInfo of pointsToMove) {
            const key = `${ptInfo.pathId}:${ptInfo.pointIndex}`;
            moveMap.set(key, ptInfo);
            affectedPaths.add(ptInfo.path);

            const path = ptInfo.path;
            const pt = ptInfo.point;
            const idx = ptInfo.pointIndex;

            // If pt is an anchor point, translate its incoming and outgoing handles too
            if (this.isAnchorPoint(pt)) {
                // Incoming handle
                if (idx > 0 && path.points[idx - 1]) {
                    const prevPt = path.points[idx - 1];
                    if (prevPt.cmd === 'C2' || prevPt.cmd === 'Q1') {
                        const prevKey = `${ptInfo.pathId}:${idx - 1}`;
                        if (!moveMap.has(prevKey)) {
                            moveMap.set(prevKey, {
                                pathId: ptInfo.pathId,
                                pointIndex: idx - 1,
                                point: prevPt,
                                path: path
                            });
                        }
                    }
                }

                // Outgoing handle
                if (idx + 1 < path.points.length && path.points[idx + 1]) {
                    const nextPt = path.points[idx + 1];
                    if (nextPt.cmd === 'C1' || nextPt.cmd === 'Q1') {
                        const nextKey = `${ptInfo.pathId}:${idx + 1}`;
                        if (!moveMap.has(nextKey)) {
                            moveMap.set(nextKey, {
                                pathId: ptInfo.pathId,
                                pointIndex: idx + 1,
                                point: nextPt,
                                path: path
                            });
                        }
                    }
                }
            }
        }

        return {
            items: Array.from(moveMap.values()),
            paths: Array.from(affectedPaths)
        };
    }

    // Right-click context menu handling
    handleContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const clickedPoint = this.findPointAt(mouseX, mouseY);
        if (clickedPoint) {
            const isAlreadySelected = this.selectedPoints.some(
                p => p.pathId === clickedPoint.pathId && p.pointIndex === clickedPoint.pointIndex
            );
            if (!isAlreadySelected) {
                this.selectedPoints = [clickedPoint];
                this.updateSelectionInfo();
                this.updateStats();
                this.redraw();
            }
        }

        this.showContextMenu(e.clientX, e.clientY, clickedPoint);
    }

    showContextMenu(clientX, clientY, clickedPoint) {
        this.closeContextMenu();

        const count = this.selectedPoints.length;
        const hasSelection = count > 0;
        const canUndo = this.historyIndex > 0;

        const menu = document.createElement('div');
        menu.className = 'svg-context-menu';
        menu.id = 'svg-context-menu';

        let html = '';

        if (hasSelection) {
            const headerText = count === 1
                ? `Point ${this.selectedPoints[0].point.cmd} (P${this.selectedPoints[0].pointIndex})`
                : `${count} Points Selected`;
            html += `<div class="svg-context-menu-header">${headerText}</div>`;

            const deleteLabel = count === 1 ? 'Delete Point' : `Delete Points (${count})`;
            html += `
                <button class="svg-context-menu-item danger" data-action="delete">
                    <span class="menu-left"><i class="bi bi-trash3"></i><span>${deleteLabel}</span></span>
                    <span class="menu-badge">Del</span>
                </button>
                <button class="svg-context-menu-item" data-action="deselect">
                    <span class="menu-left"><i class="bi bi-x-circle"></i><span>Deselect All</span></span>
                    <span class="menu-badge">Esc</span>
                </button>
            `;

            if (count === 1) {
                const pt = this.selectedPoints[0].point;
                html += `
                    <div class="svg-context-menu-divider"></div>
                    <div style="padding: 4px 10px; font-size: 0.75rem; color: var(--text-muted); line-height: 1.4;">
                        X: ${Math.round(pt.x * 10) / 10}, Y: ${Math.round(pt.y * 10) / 10}
                    </div>
                `;
            }
        } else {
            html += `<div class="svg-context-menu-header">Canvas</div>`;
            html += `
                <button class="svg-context-menu-item" data-action="select-all">
                    <span class="menu-left"><i class="bi bi-check-all"></i><span>Select All Points</span></span>
                    <span class="menu-badge">Ctrl+A</span>
                </button>
                <button class="svg-context-menu-item" data-action="reset-view">
                    <span class="menu-left"><i class="bi bi-aspect-ratio"></i><span>Reset View</span></span>
                    <span class="menu-badge">R</span>
                </button>
            `;
        }

        if (canUndo) {
            html += `
                <div class="svg-context-menu-divider"></div>
                <button class="svg-context-menu-item" data-action="undo">
                    <span class="menu-left"><i class="bi bi-arrow-counterclockwise"></i><span>Undo</span></span>
                    <span class="menu-badge">Ctrl+Z</span>
                </button>
            `;
        }

        menu.innerHTML = html;
        document.body.appendChild(menu);
        this.contextMenuElement = menu;

        // Viewport bounds clamping
        const menuRect = menu.getBoundingClientRect();
        let posX = clientX;
        let posY = clientY;

        if (posX + menuRect.width > window.innerWidth - 8) {
            posX = window.innerWidth - menuRect.width - 8;
        }
        if (posY + menuRect.height > window.innerHeight - 8) {
            posY = window.innerHeight - menuRect.height - 8;
        }
        if (posX < 8) posX = 8;
        if (posY < 8) posY = 8;

        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;

        menu.addEventListener('click', (e) => {
            const item = e.target.closest('[data-action]');
            if (!item) return;
            const action = item.dataset.action;
            this.closeContextMenu();

            if (action === 'delete') {
                this.deletePointsDirectly();
            } else if (action === 'deselect') {
                this.selectedPoints = [];
                this.updateSelectionInfo();
                this.redraw();
            } else if (action === 'select-all') {
                this.selectAllPoints();
            } else if (action === 'reset-view') {
                this.resetView();
            } else if (action === 'undo') {
                this.undo();
            }
        });
    }

    closeContextMenu() {
        if (this.contextMenuElement) {
            this.contextMenuElement.remove();
            this.contextMenuElement = null;
        }
    }

    // Select all visible points
    selectAllPoints() {
        this.selectedPoints = [];
        for (const path of this.paths) {
            const layerVisible = this.layerVisibility[path.layerId] !== false;
            if (!path.visible || !layerVisible) continue;
            for (let i = 0; i < path.points.length; i++) {
                this.selectedPoints.push({
                    pathId: path.id,
                    pointIndex: i,
                    point: path.points[i],
                    path: path
                });
            }
        }
        this.updateStats();
        this.updateSelectionInfo();
        this.redraw();
    }

    // Nudge selected points with keyboard arrow keys
    nudgeSelectedPoints(dx, dy) {
        if (this.selectedPoints.length === 0) return;
        this.saveState();
        const { items, paths } = this.getPointsAndAttachedHandlesToMove(this.selectedPoints);
        for (const item of items) {
            item.point.x += dx;
            item.point.y += dy;
        }
        for (const path of paths) {
            this.rebuildPathData(path);
        }
        this.redraw();
        document.getElementById('svg-undo-btn').disabled = false;
    }

    handleWheel(e) {
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Zoom towards mouse cursor
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const oldScale = this.scale;
        const newScale = this.scale * delta;

        // Constrain zoom
        if (newScale < 0.1 || newScale > 10) return;

        this.scale = newScale;

        // Adjust offset to zoom towards cursor
        this.offsetX = mouseX - (mouseX - this.offsetX) * (this.scale / oldScale);
        this.offsetY = mouseY - (mouseY - this.offsetY) * (this.scale / oldScale);

        this.redraw();
    }

    zoom(factor) {
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;

        const oldScale = this.scale;
        this.scale *= factor;

        // Constrain
        this.scale = Math.max(0.1, Math.min(10, this.scale));

        // Adjust offset to zoom towards center
        this.offsetX = centerX - (centerX - this.offsetX) * (this.scale / oldScale);
        this.offsetY = centerY - (centerY - this.offsetY) * (this.scale / oldScale);

        this.redraw();
    }

    resetView() {
        if (!this.svgData) {
            console.log('resetView() called but no SVG data');
            return;
        }

        const container = this.canvas.parentElement;
        if (container) {
            const rect = container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                this.canvas.width = rect.width;
                this.canvas.height = rect.height;
            }
        }

        console.log('Resetting view for SVG:', this.svgData.width, 'x', this.svgData.height);
        console.log('Canvas size:', this.canvas.width, 'x', this.canvas.height);

        // Fit SVG to canvas
        const padding = 50;
        const availWidth = Math.max(100, this.canvas.width - padding * 2);
        const availHeight = Math.max(100, this.canvas.height - padding * 2);

        const scaleX = availWidth / Math.max(1, this.svgData.width);
        const scaleY = availHeight / Math.max(1, this.svgData.height);

        // Scale must ALWAYS be positive to prevent vertically inverting the SVG!
        this.scale = Math.max(0.001, Math.min(scaleX, scaleY));
        this.offsetX = (this.canvas.width - this.svgData.width * this.scale) / 2;
        this.offsetY = (this.canvas.height - this.svgData.height * this.scale) / 2;

        console.log('View reset - scale:', this.scale, 'offsetX:', this.offsetX, 'offsetY:', this.offsetY);

        this.redraw();
    }

    // The un-mirrored "Profile" path - the traced/measured side archaeologists draw
    // continuation lines from; "Profile_Mirrored" is only its computed reflection.
    isPrimaryProfilePath(path) {
        return path.category === 'Profile' && !/mirrored/i.test(path.layerId);
    }

    // Splits a closed primary-profile path into its "outer" face (the one the
    // backend's vectorizer mirrors to build the other half of the vessel) and its
    // "inner" face (the fracture-section line, unique to this fragment, that gets
    // discarded before mirroring). Mirrors the same heuristic the Python side uses
    // in extract_left_side_of_profile(): cut the closed loop at its topmost and
    // bottommost points, giving two arcs, and call whichever sits farther from the
    // symmetry axis "outer". Returns null for an open path (nothing to split - the
    // whole thing is a single face, same as before this two-phase flow existed).
    computeProfileZones(path) {
        if (!path || !this.isPathClosed(path)) return null;

        const realCount = path.points.length - 1; // exclude the synthetic Z point
        const anchorIdx = [];
        for (let i = 0; i < realCount; i++) {
            if (this.isAnchorPoint(path.points[i])) anchorIdx.push(i);
        }
        if (anchorIdx.length < 4) return null;

        let topPos = 0, bottomPos = 0;
        for (let k = 1; k < anchorIdx.length; k++) {
            if (path.points[anchorIdx[k]].y < path.points[anchorIdx[topPos]].y) topPos = k;
            if (path.points[anchorIdx[k]].y > path.points[anchorIdx[bottomPos]].y) bottomPos = k;
        }
        if (topPos === bottomPos) return null;

        const n = anchorIdx.length;
        const arcA = [];
        for (let k = topPos; ; k = (k + 1) % n) {
            arcA.push(anchorIdx[k]);
            if (k === bottomPos) break;
        }
        const arcB = [];
        for (let k = topPos; ; k = (k - 1 + n) % n) {
            arcB.push(anchorIdx[k]);
            if (k === bottomPos) break;
        }

        const avgX = arc => arc.reduce((sum, idx) => sum + path.points[idx].x, 0) / arc.length;
        const axisX = this.getSymmetryAxisX();

        let outerArc;
        if (axisX !== null) {
            // Outer = the arc that sits, on average, farther from the symmetry axis.
            outerArc = Math.abs(avgX(arcA) - axisX) >= Math.abs(avgX(arcB) - axisX) ? arcA : arcB;
        } else {
            // No axis to compare against - fall back to the vectorizer's own
            // convention (the face with the smaller average X is the outer one).
            outerArc = avgX(arcA) <= avgX(arcB) ? arcA : arcB;
        }
        const innerArc = outerArc === arcA ? arcB : arcA;

        return {
            outerIndices: new Set(outerArc),
            innerIndices: new Set(innerArc)
        };
    }

    // Whether point index `i` of the primary profile path is clickable in the
    // current Continuation Line phase. With no outer/inner split (open path)
    // every point of the primary path counts as one single phase.
    isPointInActiveReconstructZone(i) {
        if (!this.reconstructZones) return true;
        const zone = this.reconstructPhase === 'outer'
            ? this.reconstructZones.outerIndices
            : this.reconstructZones.innerIndices;
        return zone.has(i);
    }

    findPointAt(mouseX, mouseY, pathFilter = null, pointFilter = null) {
        // Find point near mouse position. In Continuation Line mode the clickable
        // points are enlarged a bit to make the (otherwise small) anchor points
        // easier to hit.
        const threshold = this.pointSize + 2 + ((this.currentMode === 'reconstruct-spline' || this.currentMode === 'internal-details') ? 6 : 0);

        for (const path of this.paths) {
            const layerVisible = this.layerVisibility[path.layerId] !== false;
            if (!path.visible || !layerVisible) continue;
            if (pathFilter && !pathFilter(path)) continue;

            for (let i = 0; i < path.points.length; i++) {
                if (pointFilter && !pointFilter(path, i)) continue;
                const point = path.points[i];
                const screenX = point.x * this.scale + this.offsetX;
                const screenY = point.y * this.scale + this.offsetY;

                const dist = Math.sqrt((mouseX - screenX) ** 2 + (mouseY - screenY) ** 2);

                if (dist <= threshold) {
                    return {
                        pathId: path.id,
                        pointIndex: i,
                        point: point,
                        path: path
                    };
                }
            }
        }

        return null;
    }

    findImageAt(mouseX, mouseY) {
        // Find image at mouse position (check in reverse order - top to bottom)
        for (let i = this.images.length - 1; i >= 0; i--) {
            const img = this.images[i];
            if (!img.visible || !img.loaded) continue;

            const x = img.x * this.scale + this.offsetX;
            const y = img.y * this.scale + this.offsetY;
            const width = img.width * this.scale;
            const height = img.height * this.scale;

            if (mouseX >= x && mouseX <= x + width &&
                mouseY >= y && mouseY <= y + height) {
                return img;
            }
        }

        return null;
    }

    isAnchorPoint(point) {
        // Excludes bezier/quadratic control points (C1, C2, Q1) - only "on curve" points
        return point.cmd !== 'C1' && point.cmd !== 'C2' && point.cmd !== 'Q1';
    }

    // A closed path's parsed points end with a synthetic 'Z' point duplicating the
    // path's start position, just to close the loop for rendering.
    isPathClosed(path) {
        const pts = path.points;
        return pts.length > 0 && pts[pts.length - 1].cmd === 'Z';
    }

    // Walks away from fromIndex, in the given step direction, collecting up to
    // `count` anchor points (skipping bezier control points), nearest first. On a
    // closed path this wraps around through the Z seam instead of stopping at the
    // array bounds - e.g. stepping backward from index 0 continues from the last
    // real point rather than finding "no neighbor" and looking the wrong way.
    collectAnchors(path, fromIndex, step, count) {
        const result = [];
        const closed = this.isPathClosed(path);
        // On a closed path, exclude the synthetic Z point from the walk - it only
        // duplicates the start position, not a distinct sample of the curve.
        const realCount = closed ? path.points.length - 1 : path.points.length;

        let i = fromIndex;
        for (let steps = 0; steps < realCount && result.length < count; steps++) {
            i += step;
            if (closed) {
                i = ((i % realCount) + realCount) % realCount;
            } else if (i < 0 || i >= path.points.length) {
                break;
            }
            if (i === fromIndex) break; // wrapped all the way around
            if (this.isAnchorPoint(path.points[i])) result.push(path.points[i]);
        }
        return result;
    }

    // Which step direction (+1/-1) leads from fromIndex toward toIndex - the short
    // way around on a closed path, a plain comparison on an open one.
    stepDirectionBetween(path, fromIndex, toIndex) {
        if (!this.isPathClosed(path)) {
            return toIndex > fromIndex ? 1 : -1;
        }
        const realCount = path.points.length - 1;
        const forwardDist = ((toIndex - fromIndex) % realCount + realCount) % realCount;
        const backwardDist = ((fromIndex - toIndex) % realCount + realCount) % realCount;
        return forwardDist <= backwardDist ? 1 : -1;
    }

    // The 1 or 2 anchor points leading up to a break point, on whichever side of
    // the fragment actually has neighbors (the break sits at one end of it).
    getExtrapolationNeighbors(pointInfo) {
        let neighbors = this.collectAnchors(pointInfo.path, pointInfo.pointIndex, -1, 2);
        if (neighbors.length === 0) {
            neighbors = this.collectAnchors(pointInfo.path, pointInfo.pointIndex, 1, 2);
        }
        return neighbors;
    }

    vecNorm(v) {
        const len = Math.hypot(v.x, v.y) || 1;
        return { x: v.x / len, y: v.y / len };
    }

    rotateVec(v, angle) {
        const cos = Math.cos(angle), sin = Math.sin(angle);
        return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
    }

    lerpPoint(p, q, t) {
        return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    }

    // De Casteljau split of a cubic bezier at parameter t into two cubic beziers
    // (each 4 control points) that together retrace the original curve.
    splitCubicBezier(p0, p1, p2, p3, t) {
        const a0 = this.lerpPoint(p0, p1, t);
        const a1 = this.lerpPoint(p1, p2, t);
        const a2 = this.lerpPoint(p2, p3, t);
        const b0 = this.lerpPoint(a0, a1, t);
        const b1 = this.lerpPoint(a1, a2, t);
        const c0 = this.lerpPoint(b0, b1, t);
        return { left: [p0, a0, b0, c0], right: [c0, b1, a2, p3] };
    }

    // Circle through 3 points (null if they're collinear) - same construction
    // used in the standalone curve_extend_demo.html sandbox.
    circleThrough3Points(A, B, C) {
        const D = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
        if (Math.abs(D) < 1e-6) return null;
        const a2 = A.x * A.x + A.y * A.y;
        const b2 = B.x * B.x + B.y * B.y;
        const c2 = C.x * C.x + C.y * C.y;
        const cx = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / D;
        const cy = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / D;
        return { cx, cy, r: Math.hypot(A.x - cx, A.y - cy) };
    }

    normalizeAngle(a) {
        return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    }

    // Standard circular-arc-to-cubic-bezier approximation: starting at `p`, heading
    // in unit direction `dir`, sweeping a constant-curvature arc of the given
    // curvature (radians turned per unit length, signed) for `length` units.
    // Returns [end, control1, control2]. curvature ~= 0 degenerates to a straight run.
    buildArcBezier(p, dir, curvature, length) {
        const theta = curvature * length;

        if (Math.abs(theta) < 1e-6) {
            return [
                { x: p.x + dir.x * length, y: p.y + dir.y * length },
                { x: p.x + dir.x * length / 3, y: p.y + dir.y * length / 3 },
                { x: p.x + dir.x * length * 2 / 3, y: p.y + dir.y * length * 2 / 3 }
            ];
        }

        const radius = 1 / curvature; // signed - which side of `dir` the center falls on
        const r = Math.abs(radius);  // true geometric radius - an actual point ON the
                                      // circle needs this, not the signed value (using
                                      // the signed one there flips it 180° around the
                                      // circle whenever curvature is negative)
        // Center lies to the left of `dir` for positive curvature (matches the
        // right-handed rotation used by rotateVec).
        const perp = this.rotateVec(dir, Math.PI / 2);
        const center = { x: p.x + perp.x * radius, y: p.y + perp.y * radius };

        const rel0 = { x: p.x - center.x, y: p.y - center.y };
        const phi0 = Math.atan2(rel0.y, rel0.x);
        const phi1 = phi0 + theta;
        const end = { x: center.x + r * Math.cos(phi1), y: center.y + r * Math.sin(phi1) };

        const dirAtEnd = this.rotateVec(dir, theta);
        const k = radius * (4 / 3) * Math.tan(theta / 4);
        const c1 = { x: p.x + dir.x * k, y: p.y + dir.y * k };
        const c2 = { x: end.x - dirAtEnd.x * k, y: end.y - dirAtEnd.y * k };

        return [end, c1, c2];
    }

    // A break point projected forward into empty space, using exactly the same
    // construction as the standalone curve_extend_demo.html sandbox: fit the
    // unique circle through 3 real points, then extend along that same circle
    // beyond the last of them (capped to a quarter turn, so it can never sweep
    // back around toward where it came from). The start is trimmed off so it
    // reads as a detached hypothesis, not a segment physically joined to the
    // fragment.
    //
    // The 3 points are, in order away-from-break -> break: a further neighbor,
    // the reference point, and the break point itself. By default the further
    // neighbor and the reference point are just the two points right behind the
    // break - but that stretch can be the fracture's own jagged edge, not the
    // vessel's real profile. Passing `referenceInfo` (a second point the user
    // picked farther back on the same fragment, presumably past the damaged
    // stretch) uses that instead, so the fitted circle passes through clean
    // data and the actual break point, and is trusted directly - no separate
    // curvature estimate to transport and no way for it to compound into a
    // wild swing.
    addProjectionContinuation(pointInfo, referenceInfo = null, options = {}) {
        const { mirror = true, length = (this.continuationLength || 100) } = options;
        const C = pointInfo.point; // the break point

        let A, B;
        if (referenceInfo) {
            B = referenceInfo.point;
            const step = this.stepDirectionBetween(referenceInfo.path, pointInfo.pointIndex, referenceInfo.pointIndex);
            [A] = this.collectAnchors(referenceInfo.path, referenceInfo.pointIndex, step, 1);
        } else {
            const neighbors = this.getExtrapolationNeighbors(pointInfo);
            B = neighbors[0];
            A = neighbors[1];
        }

        if (!A || !B) {
            const msg = 'Selected point has no neighboring points to determine how the profile was trending.';
            if (window.app) window.app.showNotification(msg, 'warning'); else alert(msg);
            return;
        }

        const circle = this.circleThrough3Points(A, B, C);

        let end, c1, c2;
        if (circle) {
            const angleA = Math.atan2(A.y - circle.cy, A.x - circle.cx);
            const angleB = this.normalizeAngle(Math.atan2(B.y - circle.cy, B.x - circle.cx) - angleA);
            const angleC = this.normalizeAngle(Math.atan2(C.y - circle.cy, C.x - circle.cx) - angleA);
            const forward = angleB < angleC; // does the A->B->C sweep increase angle?

            const radiusAngleAtC = Math.atan2(C.y - circle.cy, C.x - circle.cx);
            const tangentForward = { x: -Math.sin(radiusAngleAtC), y: Math.cos(radiusAngleAtC) };
            const dir = forward ? tangentForward : { x: -tangentForward.x, y: -tangentForward.y };
            const curvature = (forward ? 1 : -1) / circle.r;

            // Cap the swept angle to a quarter turn so the projection can never
            // curl back around toward the clean data it came from.
            const maxAngle = Math.PI / 2;
            const projectLength = Math.min(length, maxAngle * circle.r);

            [end, c1, c2] = this.buildArcBezier(C, dir, curvature, projectLength);
        } else {
            // A, B, C collinear - nothing to curve, continue straight.
            const dir = this.vecNorm({ x: C.x - B.x, y: C.y - B.y });
            [end, c1, c2] = this.buildArcBezier(C, dir, 0, length);
        }

        const GAP_FRACTION = 0.25;
        const [q0, q1, q2, q3] = this.splitCubicBezier(C, c1, c2, end, GAP_FRACTION).right;

        const d = `M ${q0.x} ${q0.y} C ${q1.x} ${q1.y} ${q2.x} ${q2.y} ${q3.x} ${q3.y}`;

        this.saveState();
        const newPath = this.createReconstructionPath(d);

        // For a symmetric vessel, the same break normally exists on both sides -
        // mirror the freshly projected line across the axis so one click fixes both.
        // Only the outer face is mirrored though; the inner/fracture face is
        // unique to this sherd (mirror=false skips this for that phase).
        let mirrored = false;
        if (mirror) {
            const axisX = this.getSymmetryAxisX();
            if (axisX !== null) {
                this.createReconstructionPath(this.mirrorPathData(newPath, axisX));
                mirrored = true;
            }
        }

        this.syncSymmetryLineExtension();

        const msg = mirrored
            ? 'Continuation projected and mirrored to the other side — adjust nodes in Select mode.'
            : 'Continuation projected — adjust its nodes in Select mode.';
        if (window.app) window.app.showNotification(msg, 'success');
    }

    // X coordinate of the vessel's (assumed-vertical) symmetry axis, or null if
    // this SVG has no Symmetry Line layer.
    getSymmetryAxisX() {
        const symmetryPath = this.paths.find(
            p => p.category === 'Symmetry' || /symmetry/i.test(p.layerId)
        );
        if (!symmetryPath || symmetryPath.points.length === 0) return null;
        return symmetryPath.points.reduce((sum, p) => sum + p.x, 0) / symmetryPath.points.length;
    }

    // Keeps the Symmetry Line in sync with however far down the continuation
    // lines currently reach: if any of them now extends below the line's own
    // pristine bottom, the line grows a short, gapped extra segment down to that
    // same depth (mirroring the "detached hypothesis" look of the continuation
    // lines themselves); otherwise it's kept at its pristine length. Always
    // rebuilt fresh from the pristine base rather than grown incrementally, so
    // deleting/undoing continuation lines shrinks it back correctly too.
    syncSymmetryLineExtension() {
        if (!this.symmetryBasePoints || this.symmetryBasePoints.length === 0) return;

        const symmetryPath = this.paths.find(
            p => p.category === 'Symmetry' || /symmetry/i.test(p.layerId)
        );
        if (!symmetryPath) return;

        const reconstructionPaths = this.layerCategories['Reconstruction'] || [];
        let lowestY = -Infinity;
        for (const rp of reconstructionPaths) {
            for (const pt of rp.points) {
                if (pt.y > lowestY) lowestY = pt.y;
            }
        }

        const baseBottomY = Math.max(...this.symmetryBasePoints.map(p => p.y));
        const axisX = this.symmetryBasePoints[0].x;

        if (lowestY <= baseBottomY) {
            symmetryPath.points = this.symmetryBasePoints.map(p => ({ ...p }));
        } else {
            const gap = (lowestY - baseBottomY) * 0.25;
            symmetryPath.points = [
                ...this.symmetryBasePoints.map(p => ({ ...p })),
                { x: axisX, y: baseBottomY + gap, cmd: 'M' },
                { x: axisX, y: lowestY, cmd: 'L' }
            ];
        }
        this.rebuildPathData(symmetryPath);
    }

    // The 'd' string of `path` reflected across the vertical line x = axisX.
    mirrorPathData(path, axisX) {
        const mirroredPoints = path.points.map(p => ({ ...p, x: 2 * axisX - p.x }));
        const tempPath = { points: mirroredPoints };
        this.rebuildPathData(tempPath);
        return tempPath.currentD;
    }

    // Adds a new path that exists only in memory (this.paths) until export time,
    // when exportModifiedSVG() materializes it into the SVG DOM. Keeping it out of
    // this.svgData.element means undo (which only restores this.paths) never has
    // to reverse a DOM mutation.
    createReconstructionPath(d) {
        const layerId = 'layer_Reconstruction';
        const category = 'Reconstruction';

        if (this.layerVisibility[layerId] === undefined) {
            this.layerVisibility[layerId] = true;
            this.layers.push({ id: layerId, name: 'Reconstruction', category, visible: true });
        }
        if (!this.layerCategories[category]) {
            this.layerCategories[category] = [];
        }

        const profilePath = this.paths.find(p => p.category === 'Profile') || this.paths[0];
        const style = profilePath
            ? { ...profilePath.style }
            : { stroke: '#000000', strokeWidth: 1.5, fill: 'none' };

        const pathData = {
            id: `path-${this.paths.length}`,
            layerId,
            layerName: 'Reconstruction',
            category,
            element: null,
            originalD: d,
            currentD: d,
            points: this.parsePathData(d),
            style,
            visible: true
        };

        this.paths.push(pathData);
        this.layerCategories[category].push(pathData);

        this.updateLayersList();
        this.updateStats();
        this.redraw();

        return pathData;
    }

    deletePoint(pointInfo) {
        const path = this.paths.find(p => p.id === pointInfo.pathId);
        if (!path) return;

        // Save state before modification
        this.saveState();

        const pointToDelete = path.points[pointInfo.pointIndex];

        // Special case: Deleting M (MoveTo) - the starting point
        if (pointToDelete.cmd === 'M') {
            // Find the next anchor point and promote it to M
            let nextAnchorIndex = -1;
            for (let j = pointInfo.pointIndex + 1; j < path.points.length; j++) {
                const p = path.points[j];
                if (p.cmd === 'L' || p.cmd === 'C' || p.cmd === 'Q' || p.cmd === 'M') {
                    nextAnchorIndex = j;
                    break;
                }
            }

            if (nextAnchorIndex >= 0) {
                // Promote the next anchor to M
                path.points[nextAnchorIndex].cmd = 'M';

                // Remove the old M and any control points between M and the new M
                const pointsToRemove = [];
                for (let j = pointInfo.pointIndex; j < nextAnchorIndex; j++) {
                    pointsToRemove.push(j);
                }

                // Remove in reverse order
                for (let j = pointsToRemove.length - 1; j >= 0; j--) {
                    path.points.splice(pointsToRemove[j], 1);
                }
            } else {
                // No next anchor - this is the only point, just remove it
                path.points.splice(pointInfo.pointIndex, 1);
            }
        }
        // Check if we're deleting an anchor point that has associated control points
        else if (pointToDelete.cmd === 'C' || pointToDelete.cmd === 'Q') {
            // This is an anchor point for a Bezier curve
            // We need to remove its control points too
            const pointsToRemove = [pointInfo.pointIndex];

            if (pointToDelete.cmd === 'C') {
                // Look backwards for C1 and C2
                for (let j = pointInfo.pointIndex - 1; j >= 0; j--) {
                    if (path.points[j].cmd === 'C2') {
                        pointsToRemove.push(j);
                    } else if (path.points[j].cmd === 'C1') {
                        pointsToRemove.push(j);
                        break;  // Found both control points
                    } else if (path.points[j].cmd === 'M' || path.points[j].cmd === 'L' || path.points[j].cmd === 'C') {
                        break;  // Reached previous anchor
                    }
                }
            } else if (pointToDelete.cmd === 'Q') {
                // Look backwards for Q1
                for (let j = pointInfo.pointIndex - 1; j >= 0; j--) {
                    if (path.points[j].cmd === 'Q1') {
                        pointsToRemove.push(j);
                        break;
                    } else if (path.points[j].cmd === 'M' || path.points[j].cmd === 'L' || path.points[j].cmd === 'Q') {
                        break;  // Reached previous anchor
                    }
                }
            }

            // Sort in descending order to remove from end first
            pointsToRemove.sort((a, b) => b - a);

            // Remove all points
            for (const idx of pointsToRemove) {
                path.points.splice(idx, 1);
            }
        } else if (pointToDelete.cmd === 'C1' || pointToDelete.cmd === 'C2' || pointToDelete.cmd === 'Q1') {
            // This is a control point - find and remove the associated anchor and other control points
            let anchorIndex = -1;
            const pointsToRemove = [pointInfo.pointIndex];

            if (pointToDelete.cmd === 'C1' || pointToDelete.cmd === 'C2') {
                // Find the C anchor point after this control point
                for (let j = pointInfo.pointIndex + 1; j < path.points.length; j++) {
                    if (path.points[j].cmd === 'C') {
                        anchorIndex = j;
                        break;
                    } else if (path.points[j].cmd === 'C1' || path.points[j].cmd === 'C2') {
                        pointsToRemove.push(j);  // Other control point
                    }
                }

                // Also remove the anchor
                if (anchorIndex >= 0) {
                    pointsToRemove.push(anchorIndex);
                }
            } else if (pointToDelete.cmd === 'Q1') {
                // Find the Q anchor point after this control point
                for (let j = pointInfo.pointIndex + 1; j < path.points.length; j++) {
                    if (path.points[j].cmd === 'Q') {
                        anchorIndex = j;
                        pointsToRemove.push(j);
                        break;
                    }
                }
            }

            // Sort in descending order
            pointsToRemove.sort((a, b) => b - a);

            // Remove all points
            for (const idx of pointsToRemove) {
                path.points.splice(idx, 1);
            }
        } else {
            // Regular point (L) - just remove it
            path.points.splice(pointInfo.pointIndex, 1);
        }

        // Rebuild path data
        this.rebuildPathData(path);

        // Remove from selection if selected
        this.selectedPoints = this.selectedPoints.filter(
            p => !(p.pathId === pointInfo.pathId && p.pointIndex === pointInfo.pointIndex)
        );

        this.updateStats();
        this.updateSelectionInfo();
        this.redraw();

        // Enable undo button
        document.getElementById('svg-undo-btn').disabled = false;
    }

    rebuildPathData(path) {
        // Rebuild the 'd' attribute from points array
        if (path.points.length === 0) {
            path.currentD = '';
            return;
        }

        let d = '';
        let i = 0;

        while (i < path.points.length) {
            const point = path.points[i];

            if (point.cmd === 'M') {
                d += `M ${point.x} ${point.y} `;
                i++;
            } else if (point.cmd === 'L') {
                d += `L ${point.x} ${point.y} `;
                i++;
            } else if (point.cmd === 'H') {
                d += `H ${point.x} `;
                i++;
            } else if (point.cmd === 'V') {
                d += `V ${point.y} `;
                i++;
            } else if (point.cmd === 'C') {
                // Cubic Bezier - look for control points BEFORE this point
                // Find the two preceding C1 and C2 control points
                let cp1 = null, cp2 = null;
                let j = i - 1;

                // Look backwards for C2
                while (j >= 0 && !cp2) {
                    if (path.points[j].cmd === 'C2') {
                        cp2 = path.points[j];
                        break;
                    }
                    j--;
                }

                // Look backwards for C1 (before C2)
                j = j - 1;
                while (j >= 0 && !cp1) {
                    if (path.points[j].cmd === 'C1') {
                        cp1 = path.points[j];
                        break;
                    }
                    j--;
                }

                if (cp1 && cp2) {
                    d += `C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${point.x} ${point.y} `;
                } else {
                    // Fallback: convert to line if control points are missing
                    console.warn('Missing control points for C command, converting to L');
                    d += `L ${point.x} ${point.y} `;
                }
                i++;
            } else if (point.cmd === 'Q') {
                // Quadratic Bezier - look for control point BEFORE this point
                let cp = null;
                let j = i - 1;

                while (j >= 0 && !cp) {
                    if (path.points[j].cmd === 'Q1') {
                        cp = path.points[j];
                        break;
                    }
                    j--;
                }

                if (cp) {
                    d += `Q ${cp.x} ${cp.y} ${point.x} ${point.y} `;
                } else {
                    // Fallback: convert to line if control point is missing
                    console.warn('Missing control point for Q command, converting to L');
                    d += `L ${point.x} ${point.y} `;
                }
                i++;
            } else if (point.cmd === 'C1' || point.cmd === 'C2' || point.cmd === 'Q1') {
                // Control points - skip, they're included when we process C/Q
                i++;
            } else if (point.cmd === 'Z' || point.cmd === 'z') {
                d += 'Z ';
                i++;
            } else {
                // Fallback - treat as line
                d += `L ${point.x} ${point.y} `;
                i++;
            }
        }

        path.currentD = d.trim();
    }

    addPointOnPath(mouseX, mouseY) {
        // Find the nearest path segment to the click position
        // and insert a new point at that location

        const clickX = (mouseX - this.offsetX) / this.scale;
        const clickY = (mouseY - this.offsetY) / this.scale;

        let nearestPath = null;
        let nearestSegmentIndex = -1;
        let nearestDistance = Infinity;
        let nearestT = 0;  // Parameter along the segment (0 to 1)
        let nearestPrevAnchor = null;  // Previous anchor point

        // Search through all visible paths
        for (const path of this.paths) {
            const layerVisible = this.layerVisibility[path.layerId] !== false;
            if (!path.visible || !layerVisible) continue;

            // Check each segment between anchor points
            let lastAnchor = null;
            for (let i = 0; i < path.points.length; i++) {
                const point = path.points[i];

                // Only consider anchor points (M, L, C, Q, not control points)
                if (point.cmd === 'C1' || point.cmd === 'C2' || point.cmd === 'Q1') {
                    continue;
                }

                if (lastAnchor !== null) {
                    // We have a segment from lastAnchor to current point
                    let distance, t;

                    if (point.cmd === 'C') {
                        // Bezier curve - find control points
                        let cp1 = null, cp2 = null;
                        for (let j = i - 1; j > lastAnchor.index; j--) {
                            if (path.points[j].cmd === 'C2' && !cp2) cp2 = path.points[j];
                            else if (path.points[j].cmd === 'C1' && !cp1) cp1 = path.points[j];
                        }

                        if (cp1 && cp2) {
                            // Sample the cubic Bezier curve
                            ({ distance, t } = this.pointToCubicBezierDistance(
                                clickX, clickY,
                                lastAnchor.point.x, lastAnchor.point.y,
                                cp1.x, cp1.y,
                                cp2.x, cp2.y,
                                point.x, point.y
                            ));
                        } else {
                            // Fallback to line
                            ({ distance, t } = this.pointToSegmentDistance(
                                clickX, clickY, lastAnchor.point.x, lastAnchor.point.y, point.x, point.y
                            ));
                        }
                    } else {
                        // Line segment
                        ({ distance, t } = this.pointToSegmentDistance(
                            clickX, clickY, lastAnchor.point.x, lastAnchor.point.y, point.x, point.y
                        ));
                    }

                    if (distance < nearestDistance) {
                        nearestDistance = distance;
                        nearestPath = path;
                        nearestSegmentIndex = i;
                        nearestT = t;
                        nearestPrevAnchor = lastAnchor;
                    }
                }

                lastAnchor = { point: point, index: i };
            }
        }

        // If we found a nearby segment (within 20 pixels), insert a point
        const threshold = 20 / this.scale;
        if (nearestPath && nearestDistance < threshold && nearestPrevAnchor) {
            this.saveState();

            const p1 = nearestPrevAnchor.point;
            const p2 = nearestPath.points[nearestSegmentIndex];

            // Interpolate position along the segment
            const newX = p1.x + (p2.x - p1.x) * nearestT;
            const newY = p1.y + (p2.y - p1.y) * nearestT;

            // Create new point (as a line point for simplicity)
            const newPoint = {
                x: newX,
                y: newY,
                cmd: 'L',
                index: nearestSegmentIndex
            };

            // Insert the new point
            nearestPath.points.splice(nearestSegmentIndex, 0, newPoint);

            // Update indices
            for (let i = nearestSegmentIndex; i < nearestPath.points.length; i++) {
                nearestPath.points[i].index = i;
            }

            // Rebuild path data
            this.rebuildPathData(nearestPath);

            // Select the new point
            this.selectedPoints = [{
                pathId: nearestPath.id,
                pointIndex: nearestSegmentIndex
            }];

            this.updateStats();
            this.updateSelectionInfo();
            this.redraw();

            // Enable undo
            document.getElementById('svg-undo-btn').disabled = false;

            if (window.app) {
                window.app.showNotification('New point added!', 'success');
            }
        }
    }

    pointToSegmentDistance(px, py, x1, y1, x2, y2) {
        // Calculate the shortest distance from point (px, py) to line segment (x1, y1) -> (x2, y2)
        // Returns { distance, t } where t is the parameter along the segment (0 to 1)

        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthSquared = dx * dx + dy * dy;

        if (lengthSquared === 0) {
            // Degenerate segment (point)
            const dist = Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
            return { distance: dist, t: 0 };
        }

        // Project point onto line
        let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
        t = Math.max(0, Math.min(1, t));  // Clamp to [0, 1]

        // Find closest point on segment
        const closestX = x1 + t * dx;
        const closestY = y1 + t * dy;

        // Calculate distance
        const distance = Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);

        return { distance, t };
    }

    pointToCubicBezierDistance(px, py, x0, y0, x1, y1, x2, y2, x3, y3) {
        // Calculate the shortest distance from point (px, py) to cubic Bezier curve
        // Bezier: B(t) = (1-t)³P0 + 3(1-t)²t*P1 + 3(1-t)t²P2 + t³P3
        // We sample the curve at multiple points to find the closest one

        let minDistance = Infinity;
        let minT = 0;
        const samples = 50;  // Number of samples along the curve

        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const oneMinusT = 1 - t;

            // Cubic Bezier formula
            const bx = oneMinusT * oneMinusT * oneMinusT * x0 +
                3 * oneMinusT * oneMinusT * t * x1 +
                3 * oneMinusT * t * t * x2 +
                t * t * t * x3;

            const by = oneMinusT * oneMinusT * oneMinusT * y0 +
                3 * oneMinusT * oneMinusT * t * y1 +
                3 * oneMinusT * t * t * y2 +
                t * t * t * y3;

            const distance = Math.sqrt((px - bx) ** 2 + (py - by) ** 2);

            if (distance < minDistance) {
                minDistance = distance;
                minT = t;
            }
        }

        return { distance: minDistance, t: minT };
    }

    saveState() {
        // Save current state for undo
        const state = {
            paths: this.paths.map(p => ({
                ...p,
                points: p.points.map(pt => ({ ...pt }))
            })),
            images: this.images.map(img => ({
                ...img,
                // Don't clone the Image object, just save the properties
                img: img.img,
                element: img.element
            })),
            layerVisibility: { ...this.layerVisibility },
            imageVisibility: { ...this.imageVisibility }
        };

        // Remove future states if we're not at the end
        this.history = this.history.slice(0, this.historyIndex + 1);

        this.history.push(state);
        this.historyIndex++;

        // Limit history size
        if (this.history.length > 50) {
            this.history.shift();
            this.historyIndex--;
        }
    }

    undo() {
        if (this.historyIndex <= 0) return;

        this.historyIndex--;
        const state = this.history[this.historyIndex];

        // Restore state
        this.paths = state.paths.map(p => ({
            ...p,
            points: p.points.map(pt => ({ ...pt }))
        }));

        if (state.images) {
            this.images = state.images.map(img => ({
                ...img
            }));
        }

        if (state.layerVisibility) {
            this.layerVisibility = { ...state.layerVisibility };
        }

        if (state.imageVisibility) {
            this.imageVisibility = { ...state.imageVisibility };
        }

        this.selectedPoints = [];
        this.updateStats();
        this.updateSelectionInfo();
        this.updateLayersList();
        this.redraw();

        document.getElementById('svg-undo-btn').disabled = this.historyIndex <= 0;
    }

    redraw() {
        if (!this.svgData) {
            console.log('redraw() called but no SVG data');
            return;
        }

        console.log('Redrawing SVG, paths:', this.paths.length, 'scale:', this.scale);

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw background
        this.drawBackground();

        // Save context
        this.ctx.save();

        // Draw image layers first (behind paths)
        for (const imageData of this.images) {
            if (!imageData.visible || !imageData.loaded) continue;

            const x = imageData.x * this.scale + this.offsetX;
            const y = imageData.y * this.scale + this.offsetY;
            const width = imageData.width * this.scale;
            const height = imageData.height * this.scale;

            this.ctx.globalAlpha = imageData.opacity;
            this.ctx.drawImage(imageData.img, x, y, width, height);
            this.ctx.globalAlpha = 1.0;

            // Draw border if image is being dragged
            if (this.draggedImage && this.draggedImage.id === imageData.id) {
                this.ctx.strokeStyle = '#ff6b6b';
                this.ctx.lineWidth = 2;
                this.ctx.strokeRect(x, y, width, height);
            }
        }

        // Draw paths with proper curve commands
        for (const path of this.paths) {
            // Check both path visibility and layer visibility
            const layerVisible = this.layerVisibility[path.layerId] !== false;
            if (!path.visible || !layerVisible || path.points.length === 0) continue;

            console.log('Drawing path:', path.id, 'with', path.points.length, 'points');

            // In Continuation Line mode, dim everything except the one interactive
            // (primary, un-mirrored) profile side so it's obvious where to click.
            const dimForSplineMode = this.currentMode === 'reconstruct-spline' && !this.isPrimaryProfilePath(path);
            this.ctx.globalAlpha = dimForSplineMode ? 0.25 : 1;

            this.ctx.beginPath();

            let i = 0;
            while (i < path.points.length) {
                const point = path.points[i];
                const x = point.x * this.scale + this.offsetX;
                const y = point.y * this.scale + this.offsetY;

                if (point.cmd === 'M') {
                    // Move to
                    this.ctx.moveTo(x, y);
                    i++;
                } else if (point.cmd === 'L' || point.cmd === 'H' || point.cmd === 'V') {
                    // Line to
                    this.ctx.lineTo(x, y);
                    i++;
                } else if (point.cmd === 'C' && i >= 2) {
                    // Cubic Bezier curve - need 2 control points + end point
                    const cp1 = path.points[i - 2];
                    const cp2 = path.points[i - 1];

                    const cp1x = cp1.x * this.scale + this.offsetX;
                    const cp1y = cp1.y * this.scale + this.offsetY;
                    const cp2x = cp2.x * this.scale + this.offsetX;
                    const cp2y = cp2.y * this.scale + this.offsetY;

                    this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
                    i++;
                } else if (point.cmd === 'Q' && i >= 1) {
                    // Quadratic Bezier curve - need 1 control point + end point
                    const cp = path.points[i - 1];

                    const cpx = cp.x * this.scale + this.offsetX;
                    const cpy = cp.y * this.scale + this.offsetY;

                    this.ctx.quadraticCurveTo(cpx, cpy, x, y);
                    i++;
                } else if (point.cmd === 'C1' || point.cmd === 'C2' || point.cmd === 'Q1') {
                    // Control points - skip, they're used when we hit C or Q
                    i++;
                } else {
                    // Default: line to
                    this.ctx.lineTo(x, y);
                    i++;
                }
            }

            this.ctx.strokeStyle = path.stroke || (path.style && path.style.stroke) || '#000000';
            this.ctx.lineWidth = (path.strokeWidth || (path.style && path.style.strokeWidth) || 1) * this.scale;
            this.ctx.stroke();
        }
        this.ctx.globalAlpha = 1;

        // Draw points if enabled
        if (this.showPoints) {
            // First pass: Draw handle lines connecting control points to their anchors
            this.ctx.strokeStyle = '#9333ea';  // Purple for handle lines
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([3, 3]);  // Dashed lines

            for (const path of this.paths) {
                const layerVisible = this.layerVisibility[path.layerId] !== false;
                if (!path.visible || !layerVisible) continue;

                for (let i = 0; i < path.points.length; i++) {
                    const point = path.points[i];

                    // Draw lines from control points to their anchor points
                    if (point.cmd === 'C') {
                        // Find the two control points before this C point
                        let cp1 = null, cp2 = null;
                        let prevAnchor = null;

                        // Look backwards for C2 and C1
                        for (let j = i - 1; j >= 0; j--) {
                            if (path.points[j].cmd === 'C2' && !cp2) {
                                cp2 = path.points[j];
                            } else if (path.points[j].cmd === 'C1' && !cp1) {
                                cp1 = path.points[j];
                            } else if ((path.points[j].cmd === 'M' || path.points[j].cmd === 'L' || path.points[j].cmd === 'C') && !prevAnchor) {
                                prevAnchor = path.points[j];
                                break;
                            }
                        }

                        // Draw line from previous anchor to cp1
                        if (cp1 && prevAnchor) {
                            this.ctx.beginPath();
                            this.ctx.moveTo(
                                prevAnchor.x * this.scale + this.offsetX,
                                prevAnchor.y * this.scale + this.offsetY
                            );
                            this.ctx.lineTo(
                                cp1.x * this.scale + this.offsetX,
                                cp1.y * this.scale + this.offsetY
                            );
                            this.ctx.stroke();
                        }

                        // Draw line from cp2 to current anchor
                        if (cp2) {
                            this.ctx.beginPath();
                            this.ctx.moveTo(
                                cp2.x * this.scale + this.offsetX,
                                cp2.y * this.scale + this.offsetY
                            );
                            this.ctx.lineTo(
                                point.x * this.scale + this.offsetX,
                                point.y * this.scale + this.offsetY
                            );
                            this.ctx.stroke();
                        }
                    } else if (point.cmd === 'Q') {
                        // Find the control point before this Q point
                        let cp = null;
                        let prevAnchor = null;

                        for (let j = i - 1; j >= 0; j--) {
                            if (path.points[j].cmd === 'Q1' && !cp) {
                                cp = path.points[j];
                            } else if ((path.points[j].cmd === 'M' || path.points[j].cmd === 'L' || path.points[j].cmd === 'Q') && !prevAnchor) {
                                prevAnchor = path.points[j];
                                break;
                            }
                        }

                        // Draw lines from previous anchor to cp to current anchor
                        if (cp && prevAnchor) {
                            this.ctx.beginPath();
                            this.ctx.moveTo(
                                prevAnchor.x * this.scale + this.offsetX,
                                prevAnchor.y * this.scale + this.offsetY
                            );
                            this.ctx.lineTo(
                                cp.x * this.scale + this.offsetX,
                                cp.y * this.scale + this.offsetY
                            );
                            this.ctx.lineTo(
                                point.x * this.scale + this.offsetX,
                                point.y * this.scale + this.offsetY
                            );
                            this.ctx.stroke();
                        }
                    }
                }
            }

            // Reset line dash
            this.ctx.setLineDash([]);

            // Second pass: Draw the points themselves
            const inSplineMode = this.currentMode === 'reconstruct-spline';

            for (const path of this.paths) {
                const layerVisible = this.layerVisibility[path.layerId] !== false;
                if (!path.visible || !layerVisible) continue;

                const isPrimary = this.isPrimaryProfilePath(path);

                for (let i = 0; i < path.points.length; i++) {
                    const point = path.points[i];
                    const x = point.x * this.scale + this.offsetX;
                    const y = point.y * this.scale + this.offsetY;
                    const isControlPoint = point.cmd === 'C1' || point.cmd === 'C2' || point.cmd === 'Q1';
                    // Clickable here = primary path AND in the current outer/inner
                    // phase's face - other paths, and the primary path's other
                    // face, are dimmed and left at normal size.
                    const isClickableHere = inSplineMode && isPrimary && this.isPointInActiveReconstructZone(i);
                    this.ctx.globalAlpha = (inSplineMode && !isClickableHere) ? 0.25 : 1;
                    const radius = (isClickableHere && !isControlPoint) ? this.pointSize * 0.9 : this.pointSize / 2;

                    // Check if selected
                    const isSelected = this.selectedPoints.some(
                        p => p.pathId === path.id && p.pointIndex === i
                    );

                    // Check if hovered
                    const isHovered = this.hoveredPoint &&
                        this.hoveredPoint.pathId === path.id &&
                        this.hoveredPoint.pointIndex === i;

                    // Check if this is the break point awaiting its reference point
                    const isPendingBreakPoint = this.pendingReconstructPoint &&
                        this.pendingReconstructPoint.pathId === path.id &&
                        this.pendingReconstructPoint.pointIndex === i;

                    // Draw point
                    this.ctx.beginPath();
                    this.ctx.arc(x, y, radius, 0, Math.PI * 2);

                    // Different colors for control points
                    if (isPendingBreakPoint) {
                        this.ctx.fillStyle = '#22c55e';  // Green for the pending break point
                    } else if (isControlPoint) {
                        this.ctx.fillStyle = '#9333ea';  // Purple for control points
                    } else if (isSelected) {
                        this.ctx.fillStyle = '#ef4444';  // Red for selected
                    } else if (isHovered) {
                        this.ctx.fillStyle = '#f59e0b';  // Orange for hovered
                    } else {
                        this.ctx.fillStyle = '#2563eb';  // Blue for normal
                    }

                    this.ctx.fill();

                    // Draw point label if enabled
                    if (this.showLabels && (isSelected || isHovered)) {
                        this.ctx.fillStyle = '#000';
                        this.ctx.font = '10px sans-serif';
                        this.ctx.fillText(`P${i} (${point.cmd})`, x + this.pointSize, y - this.pointSize);
                    }
                }
            }
            this.ctx.globalAlpha = 1;
        }

        this.ctx.restore();

        // Draw marquee selection box on screen
        if (this.isSelectingBox && this.selectionBox) {
            const sx = Math.min(this.selectionBox.startX, this.selectionBox.currentX);
            const sy = Math.min(this.selectionBox.startY, this.selectionBox.currentY);
            const sw = Math.abs(this.selectionBox.currentX - this.selectionBox.startX);
            const sh = Math.abs(this.selectionBox.currentY - this.selectionBox.startY);

            this.ctx.save();
            this.ctx.fillStyle = 'rgba(194, 65, 12, 0.12)';
            this.ctx.strokeStyle = '#c2410c';
            this.ctx.lineWidth = 1.5;
            this.ctx.setLineDash([4, 4]);
            this.ctx.fillRect(sx, sy, sw, sh);
            this.ctx.strokeRect(sx, sy, sw, sh);
            this.ctx.restore();
        }

        // Draw rubber-band preview line for Internal Details tool
        if (this.currentMode === 'internal-details' && this.drawingLineStart && this.drawingLineCurrent) {
            const sx1 = this.drawingLineStart.x * this.scale + this.offsetX;
            const sy1 = this.drawingLineStart.y * this.scale + this.offsetY;
            const sx2 = this.drawingLineCurrent.x * this.scale + this.offsetX;
            const sy2 = this.drawingLineCurrent.y * this.scale + this.offsetY;

            this.ctx.save();

            // Rubber-band dashed line
            this.ctx.beginPath();
            this.ctx.moveTo(sx1, sy1);
            this.ctx.lineTo(sx2, sy2);
            this.ctx.strokeStyle = '#9333ea'; // Distinct purple
            this.ctx.lineWidth = 1.5;
            this.ctx.setLineDash([5, 4]);
            this.ctx.stroke();

            // Start handle
            this.ctx.setLineDash([]);
            this.ctx.fillStyle = '#22c55e'; // Green start dot
            this.ctx.beginPath();
            this.ctx.arc(sx1, sy1, 4, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.strokeStyle = '#ffffff';
            this.ctx.lineWidth = 1.5;
            this.ctx.stroke();

            // End handle
            this.ctx.fillStyle = '#9333ea'; // Purple end dot
            this.ctx.beginPath();
            this.ctx.arc(sx2, sy2, 4, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.strokeStyle = '#ffffff';
            this.ctx.lineWidth = 1.5;
            this.ctx.stroke();

            // Tooltip with length and orientation
            const dx = this.drawingLineCurrent.x - this.drawingLineStart.x;
            const dy = this.drawingLineCurrent.y - this.drawingLineStart.y;
            const len = Math.hypot(dx, dy);

            if (len > 1) {
                let statusText = `${len.toFixed(1)} px`;
                if (Math.abs(dy) < 0.001) statusText += ' [Horizontal]';
                else if (Math.abs(dx) < 0.001) statusText += ' [Vertical]';

                const midX = (sx1 + sx2) / 2;
                const midY = (sy1 + sy2) / 2 - 12;

                this.ctx.font = '11px sans-serif';
                const textWidth = this.ctx.measureText(statusText).width;

                this.ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
                this.ctx.beginPath();
                if (typeof this.ctx.roundRect === 'function') {
                    this.ctx.roundRect(midX - textWidth / 2 - 6, midY - 11, textWidth + 12, 18, 3);
                } else {
                    this.ctx.rect(midX - textWidth / 2 - 6, midY - 11, textWidth + 12, 18);
                }
                this.ctx.fill();

                this.ctx.fillStyle = '#ffffff';
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(statusText, midX, midY - 2);
            }

            this.ctx.restore();
        }

        console.log('Redraw complete');
    }

    drawBackground() {
        this.ctx.save();

        // Fill white background
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw dot grid
        this.ctx.fillStyle = '#e5e5e5'; // Light gray
        const gridSize = 25;
        const dotRadius = 1.5;

        for (let x = gridSize / 2; x < this.canvas.width; x += gridSize) {
            for (let y = gridSize / 2; y < this.canvas.height; y += gridSize) {
                this.ctx.beginPath();
                this.ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }

        this.ctx.restore();
    }

    toggleCategoryCollapse(category) {
        if (!this.collapsedCategories) {
            this.collapsedCategories = new Set();
        }
        if (this.collapsedCategories.has(category)) {
            this.collapsedCategories.delete(category);
        } else {
            this.collapsedCategories.add(category);
        }
        this.updateLayersList();
    }

    getCategoryMeta(category) {
        const meta = {
            'Profile': {
                icon: '<i class="bi bi-bezier2"></i>',
                color: 'var(--teal)',
                bg: 'rgba(13, 148, 136, 0.1)',
                border: 'rgba(13, 148, 136, 0.25)'
            },
            'Profile Mirrored': {
                icon: '<i class="bi bi-symmetry-vertical"></i>',
                color: '#0891b2',
                bg: 'rgba(8, 145, 178, 0.1)',
                border: 'rgba(8, 145, 178, 0.25)'
            },
            'Symmetry': {
                icon: '<i class="bi bi-symmetry-vertical"></i>',
                color: 'var(--primary)',
                bg: 'rgba(194, 65, 12, 0.1)',
                border: 'rgba(194, 65, 12, 0.25)'
            },
            'Symmetry Line': {
                icon: '<i class="bi bi-border-middle"></i>',
                color: 'var(--primary)',
                bg: 'rgba(194, 65, 12, 0.1)',
                border: 'rgba(194, 65, 12, 0.25)'
            },
            'Diameter': {
                icon: '<i class="bi bi-arrows-expand"></i>',
                color: '#d97706',
                bg: 'rgba(217, 119, 6, 0.1)',
                border: 'rgba(217, 119, 6, 0.25)'
            },
            'Reconstruction': {
                icon: '<i class="bi bi-bezier"></i>',
                color: '#16a34a',
                bg: 'rgba(22, 163, 74, 0.1)',
                border: 'rgba(22, 163, 74, 0.25)'
            },
            'Detail': {
                icon: '<i class="bi bi-slash-lg"></i>',
                color: '#9333ea',
                bg: 'rgba(147, 51, 234, 0.1)',
                border: 'rgba(147, 51, 234, 0.25)'
            },
            'Internal Details': {
                icon: '<i class="bi bi-slash-lg"></i>',
                color: '#9333ea',
                bg: 'rgba(147, 51, 234, 0.1)',
                border: 'rgba(147, 51, 234, 0.25)'
            },
            'Images': {
                icon: '<i class="bi bi-images"></i>',
                color: '#4f46e5',
                bg: 'rgba(79, 70, 229, 0.1)',
                border: 'rgba(79, 70, 229, 0.25)'
            },
            'Ungrouped': {
                icon: '<i class="bi bi-file-earmark"></i>',
                color: 'var(--text-dim)',
                bg: 'rgba(120, 113, 108, 0.1)',
                border: 'rgba(120, 113, 108, 0.25)'
            }
        };
        return meta[category] || {
            icon: '<i class="bi bi-folder2"></i>',
            color: 'var(--text-dim)',
            bg: 'rgba(120, 113, 108, 0.1)',
            border: 'rgba(120, 113, 108, 0.25)'
        };
    }

    getCategoryIcon(category) {
        return this.getCategoryMeta(category).icon;
    }

    updateLayersList() {
        const list = document.getElementById('svg-layers-list');
        if (!list) return;

        if (!this.collapsedCategories) {
            this.collapsedCategories = new Set();
        }

        if (Object.keys(this.layerCategories).length === 0 && this.images.length === 0) {
            list.innerHTML = `
                <div class="empty-layers-state">
                    <i class="bi bi-layers"></i>
                    <p>No layers loaded yet</p>
                    <span class="empty-layers-hint">Export an SVG from Segmentation to edit layers</span>
                </div>
            `;
            return;
        }

        list.innerHTML = '';

        // Add image layers section if there are any
        if (this.images.length > 0) {
            const isImageCollapsed = this.collapsedCategories.has('__images__');
            const imgMeta = this.getCategoryMeta('Images');
            const imageSection = document.createElement('div');
            imageSection.className = `layer-category ${isImageCollapsed ? 'collapsed' : ''}`;
            imageSection.innerHTML = `
                <div class="layer-category-header" onclick="window.svgEditor.toggleCategoryCollapse('__images__')">
                    <div class="category-header-info">
                        <span class="category-icon-pill" style="color: ${imgMeta.color}; background: ${imgMeta.bg}; border-color: ${imgMeta.border};">
                            ${imgMeta.icon}
                        </span>
                        <span class="category-name">Images</span>
                    </div>
                    <div class="category-header-aside">
                        <span class="category-count-badge">${this.images.length}</span>
                        <span class="category-chevron"><i class="bi bi-chevron-down"></i></span>
                    </div>
                </div>
                <div class="layer-category-content"></div>
            `;

            const imageContent = imageSection.querySelector('.layer-category-content');

            this.images.forEach(img => {
                const isVisible = img.visible !== false;
                const item = document.createElement('div');
                item.className = `layer-item image-layer-item ${isVisible ? '' : 'layer-item-hidden'}`;
                const opacityPercent = Math.round((img.opacity != null ? img.opacity : 1) * 100);
                
                item.innerHTML = `
                    <div class="layer-item-info">
                        <div class="layer-item-title" title="${img.name}">
                            <i class="bi bi-image" style="color: #4f46e5; margin-right: 4px;"></i>
                            ${img.name}
                        </div>
                        <div class="layer-item-meta">
                            <span class="meta-part">${Math.round(img.width)}×${Math.round(img.height)}px</span>
                            <span class="meta-dot">•</span>
                            <span class="meta-part">${opacityPercent}% opacity</span>
                        </div>
                    </div>
                    <div class="layer-item-actions">
                        <button type="button" class="layer-action-btn layer-vis-btn ${isVisible ? 'is-active' : ''}" 
                                title="${isVisible ? 'Hide image' : 'Show image'}"
                                onclick="window.svgEditor.toggleImage('${img.id}', ${!isVisible})">
                            <i class="bi ${isVisible ? 'bi-eye-fill' : 'bi-eye-slash'}"></i>
                        </button>
                        <button type="button" class="layer-action-btn" title="Adjust opacity (${opacityPercent}%)" 
                                onclick="window.svgEditor.adjustImageOpacity('${img.id}')">
                            <i class="bi bi-circle-half"></i>
                        </button>
                        ${img.isUserAdded ? `
                        <button type="button" class="layer-action-btn layer-btn-danger" title="Remove" 
                                onclick="window.svgEditor.removeImage('${img.id}')">
                            <i class="bi bi-trash3"></i>
                        </button>
                        ` : ''}
                    </div>
                `;
                imageContent.appendChild(item);
            });

            list.appendChild(imageSection);
        }

        // Add layer categories
        const categories = Object.keys(this.layerCategories).sort();

        categories.forEach(category => {
            const paths = this.layerCategories[category];
            if (paths.length === 0) return;

            // Get unique layers in this category
            const layersInCategory = [...new Set(paths.map(p => p.layerId))];
            const isCollapsed = this.collapsedCategories.has(category);
            const catMeta = this.getCategoryMeta(category);

            const section = document.createElement('div');
            section.className = `layer-category ${isCollapsed ? 'collapsed' : ''}`;
            section.innerHTML = `
                <div class="layer-category-header" onclick="window.svgEditor.toggleCategoryCollapse('${category}')">
                    <div class="category-header-info">
                        <span class="category-icon-pill" style="color: ${catMeta.color}; background: ${catMeta.bg}; border-color: ${catMeta.border};">
                            ${catMeta.icon}
                        </span>
                        <span class="category-name">${category}</span>
                    </div>
                    <div class="category-header-aside">
                        <span class="category-count-badge">${layersInCategory.length}</span>
                        <span class="category-chevron"><i class="bi bi-chevron-down"></i></span>
                    </div>
                </div>
                <div class="layer-category-content"></div>
            `;

            const content = section.querySelector('.layer-category-content');

            layersInCategory.forEach(layerId => {
                const layerPaths = paths.filter(p => p.layerId === layerId);
                const totalPoints = layerPaths.reduce((sum, p) => sum + p.points.length, 0);
                const layerName = layerPaths[0].layerName;
                const isVisible = this.layerVisibility[layerId] !== false;

                const item = document.createElement('div');
                item.className = `layer-item ${isVisible ? '' : 'layer-item-hidden'}`;
                item.innerHTML = `
                    <div class="layer-item-info">
                        <div class="layer-item-title" title="${layerName}">${layerName}</div>
                        <div class="layer-item-meta">
                            <span class="meta-part"><i class="bi bi-bezier2"></i> ${layerPaths.length} path${layerPaths.length > 1 ? 's' : ''}</span>
                            <span class="meta-dot">•</span>
                            <span class="meta-part">${totalPoints} pts</span>
                        </div>
                    </div>
                    <div class="layer-item-actions">
                        <button type="button" class="layer-action-btn layer-vis-btn ${isVisible ? 'is-active' : ''}" 
                                title="${isVisible ? 'Hide layer' : 'Show layer'}"
                                onclick="window.svgEditor.toggleLayer('${layerId}', ${!isVisible})">
                            <i class="bi ${isVisible ? 'bi-eye-fill' : 'bi-eye-slash'}"></i>
                        </button>
                    </div>
                `;
                content.appendChild(item);
            });

            list.appendChild(section);
        });
    }

    toggleLayer(layerId, visible) {
        this.layerVisibility[layerId] = visible;

        // Update all paths in this layer
        this.paths.forEach(p => {
            if (p.layerId === layerId) {
                p.visible = visible;
            }
        });

        this.redraw();
        this.updateLayersList();
    }

    toggleImage(imageId, visible) {
        const image = this.images.find(img => img.id === imageId);
        if (image) {
            image.visible = visible;
            this.imageVisibility[imageId] = visible;
            this.saveState();
            this.redraw();
            this.updateLayersList();
        }
    }

    async removeImage(imageId) {
        const confirmFn = window.showConfirmDialog || showConfirmDialog;
        const confirmed = await confirmFn({
            title: 'Remove Image',
            subtitle: 'Are you sure you want to remove this image from the editor?',
            confirmText: 'Remove',
            cancelText: 'Cancel',
            confirmClass: 'btn-danger',
            icon: 'bi-trash3-fill'
        });
        if (!confirmed) return;

        const index = this.images.findIndex(img => img.id === imageId);
        if (index !== -1) {
            this.images.splice(index, 1);
            delete this.imageVisibility[imageId];

            this.saveState();
            this.updateLayersList();
            this.redraw();

            if (window.app) {
                window.app.showNotification('Image removed!', 'success');
            }
        }
    }

    adjustImageOpacity(imageId) {
        const image = this.images.find(img => img.id === imageId);
        if (!image) return;

        const modal = document.getElementById('image-opacity-modal');
        const overlay = document.getElementById('image-opacity-overlay');
        const closeBtn = document.getElementById('image-opacity-close-btn');
        const cancelBtn = document.getElementById('image-opacity-cancel-btn');
        const applyBtn = document.getElementById('image-opacity-apply-btn');
        const slider = document.getElementById('image-opacity-slider');
        const badge = document.getElementById('image-opacity-badge');
        const subtitle = document.getElementById('image-opacity-subtitle');

        if (!modal || !slider) return;

        const initialOpacity = image.opacity != null ? image.opacity : 0.7;
        const initialPercent = Math.round(initialOpacity * 100);

        if (subtitle) {
            subtitle.textContent = `Set display opacity for "${image.name}"`;
        }
        slider.value = initialPercent;
        if (badge) {
            badge.textContent = `${initialPercent}%`;
        }

        const updateLive = (val) => {
            const num = Math.min(100, Math.max(0, parseInt(val, 10) || 0));
            if (badge) badge.textContent = `${num}%`;
            image.opacity = num / 100;
            this.redraw();
        };

        const onInput = (e) => {
            updateLive(e.target.value);
        };

        const cleanup = () => {
            slider.removeEventListener('input', onInput);
            if (overlay) overlay.removeEventListener('click', onCancel);
            if (closeBtn) closeBtn.removeEventListener('click', onCancel);
            if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
            if (applyBtn) applyBtn.removeEventListener('click', onApply);
            modal.style.display = 'none';
        };

        const onCancel = () => {
            image.opacity = initialOpacity;
            this.redraw();
            cleanup();
        };

        const onApply = () => {
            const finalPercent = Math.min(100, Math.max(0, parseInt(slider.value, 10) || 0));
            image.opacity = finalPercent / 100;
            this.saveState();
            this.redraw();
            this.updateLayersList();
            cleanup();
            if (window.app) {
                window.app.showNotification(`Opacity for "${image.name}" set to ${finalPercent}%`, 'success');
            }
        };

        slider.addEventListener('input', onInput);
        if (overlay) overlay.addEventListener('click', onCancel);
        if (closeBtn) closeBtn.addEventListener('click', onCancel);
        if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
        if (applyBtn) applyBtn.addEventListener('click', onApply);

        modal.style.display = 'flex';
    }

    addImageFromUrl(imageUrl, imageName) {
        const img = new Image();

        img.onload = () => {
            // Center the image in the viewport
            const centerX = (this.svgData ? this.svgData.width / 2 : 500) - img.width / 2;
            const centerY = (this.svgData ? this.svgData.height / 2 : 500) - img.height / 2;

            const imageId = `current-image-${Date.now()}`;
            const cleanName = imageName ? imageName.replace(/\.[^/.]+$/, '') : 'Image';

            const imageData = {
                id: imageId,
                name: cleanName,
                element: null, // No original SVG element
                img,
                x: Math.max(0, centerX),
                y: Math.max(0, centerY),
                width: img.width,
                height: img.height,
                opacity: 0.7, // Start semi-transparent
                visible: true,
                loaded: true,
                isUserAdded: true, // Flag for user-added images
                isLocked: true // Lock the current image so it can't be moved
            };

            this.images.push(imageData);
            this.imageVisibility[imageId] = true;

            this.saveState();
            this.updateLayersList();
            this.redraw();

            if (window.app) {
                window.app.showNotification(`Image "${cleanName}" added (locked)!`, 'success');
            }
        };

        img.onerror = () => {
            console.error('Failed to load image from URL:', imageUrl);
            if (window.app) {
                window.app.showNotification('Failed to load image', 'error');
            }
        };

        // Set crossOrigin to allow loading from same origin
        img.crossOrigin = 'anonymous';
        img.src = imageUrl;
    }

    addImageFromFile(file) {
        if (!file.type.startsWith('image/')) {
            if (window.app) {
                window.app.showNotification('Please select a valid image file.', 'error');
            } else {
                alert('Please select a valid image file.');
            }
            return;
        }

        const reader = new FileReader();

        reader.onload = (e) => {
            const img = new Image();

            img.onload = () => {
                // Center the image in the viewport
                const centerX = (this.svgData ? this.svgData.width / 2 : 500) - img.width / 2;
                const centerY = (this.svgData ? this.svgData.height / 2 : 500) - img.height / 2;

                const imageId = `user-image-${Date.now()}`;
                const imageName = file.name.replace(/\.[^/.]+$/, '');

                const imageData = {
                    id: imageId,
                    name: imageName,
                    element: null, // No original SVG element
                    img,
                    x: Math.max(0, centerX),
                    y: Math.max(0, centerY),
                    width: img.width,
                    height: img.height,
                    opacity: 0.7, // Start semi-transparent
                    visible: true,
                    loaded: true,
                    isUserAdded: true // Flag for user-added images
                };

                this.images.push(imageData);
                this.imageVisibility[imageId] = true;

                this.saveState();
                this.updateLayersList();
                this.redraw();

                if (window.app) {
                    window.app.showNotification(`Image "${imageName}" added!`, 'success');
                }
            };

            img.src = e.target.result;
        };

        reader.readAsDataURL(file);
    }

    updateStats() {
        const totalPaths = this.paths.length;
        const totalPoints = this.getTotalPoints();
        const selectedPoints = this.selectedPoints.length;

        document.getElementById('svg-stat-paths').textContent = totalPaths;
        document.getElementById('svg-stat-points').textContent = totalPoints;
        document.getElementById('svg-stat-selected').textContent = selectedPoints;
    }

    updateSelectionInfo() {
        const info = document.getElementById('svg-selection-info');

        if (this.selectedPoints.length === 0) {
            info.innerHTML = '<p>No point selected</p>';
        } else {
            const pointsText = this.selectedPoints.length === 1 ? 'point' : 'points';
            info.innerHTML = `
                <p><strong>${this.selectedPoints.length}</strong> ${pointsText} selected</p>
                <button class="btn btn-danger btn-small" 
                        onclick="window.svgEditor.deleteSelectedPoints()" 
                        style="margin-top: 8px; width: 100%;">
                    <i class="bi bi-trash"></i> Delete Selected
                </button>
            `;
        }
    }

    async deleteSelectedPoints() {
        if (this.selectedPoints.length === 0) return;

        const confirmFn = window.showConfirmDialog || showConfirmDialog;
        const count = this.selectedPoints.length;
        const confirmed = await confirmFn({
            title: 'Delete Points',
            subtitle: `Delete ${count} selected point${count === 1 ? '' : 's'}?`,
            confirmText: 'Delete',
            cancelText: 'Cancel',
            confirmClass: 'btn-danger',
            icon: 'bi-trash3-fill'
        });

        if (!confirmed) {
            return;
        }

        this.deletePointsDirectly();
    }

    deletePointsDirectly(pointsToDelete = null) {
        const points = pointsToDelete || this.selectedPoints;
        if (!points || points.length === 0) return;

        this.saveState();
        const count = points.length;

        // Group target points by pathId
        const byPath = new Map();
        for (const ptInfo of points) {
            if (!byPath.has(ptInfo.pathId)) {
                byPath.set(ptInfo.pathId, new Set());
            }
            byPath.get(ptInfo.pathId).add(ptInfo.pointIndex);
        }

        for (const [pathId, indexSet] of byPath.entries()) {
            const path = this.paths.find(p => p.id === pathId);
            if (!path) continue;

            // Collect all indices to remove, including associated control points
            const indicesToRemove = new Set(indexSet);

            for (const idx of indexSet) {
                const pt = path.points[idx];
                if (!pt) continue;

                // If deleting an anchor point C, remove its incoming C1 and C2 control points
                if (pt.cmd === 'C') {
                    if (idx - 1 >= 0 && path.points[idx - 1] && path.points[idx - 1].cmd === 'C2') indicesToRemove.add(idx - 1);
                    if (idx - 2 >= 0 && path.points[idx - 2] && path.points[idx - 2].cmd === 'C1') indicesToRemove.add(idx - 2);
                } else if (pt.cmd === 'Q') {
                    if (idx - 1 >= 0 && path.points[idx - 1] && path.points[idx - 1].cmd === 'Q1') indicesToRemove.add(idx - 1);
                }
            }

            // Convert to array and sort descending
            const sortedIndices = Array.from(indicesToRemove).sort((a, b) => b - a);

            for (const idx of sortedIndices) {
                if (idx < path.points.length) {
                    path.points.splice(idx, 1);
                }
            }

            // If start point was removed and path still has points, ensure the first remaining anchor is 'M'
            if (path.points.length > 0) {
                let firstAnchorIdx = -1;
                for (let i = 0; i < path.points.length; i++) {
                    if (this.isAnchorPoint(path.points[i])) {
                        firstAnchorIdx = i;
                        break;
                    }
                }
                if (firstAnchorIdx > 0) {
                    // Remove leading control points before the first anchor
                    path.points.splice(0, firstAnchorIdx);
                }
                if (path.points.length > 0) {
                    path.points[0].cmd = 'M';
                }
            }

            this.rebuildPathData(path);
        }

        this.selectedPoints = [];
        this.updateStats();
        this.updateSelectionInfo();
        this.redraw();
        document.getElementById('svg-undo-btn').disabled = false;
        this.closeContextMenu();

        if (window.app && typeof window.app.showNotification === 'function') {
            window.app.showNotification(`Deleted ${count} point${count === 1 ? '' : 's'} (Ctrl+Z to undo)`, 'info');
        }
    }

    getTotalPoints() {
        return this.paths.reduce((sum, path) => sum + path.points.length, 0);
    }

    async exportModifiedSVG() {
        if (!this.svgData) return;

        try {
            // Get the include background state (radio button or fallback checkbox)
            const bgRadio = document.querySelector('input[name="svg-bg-mode"]:checked');
            const bgCheckbox = document.getElementById('svg-bg-checkbox');
            const includeBackground = bgRadio ? (bgRadio.value === 'true') : (bgCheckbox ? bgCheckbox.checked : false);

            // Clone the original SVG element
            const svgClone = this.svgData.element.cloneNode(true);

            // Update all path elements with modified data
            const pathElements = svgClone.querySelectorAll('path');

            pathElements.forEach((pathEl, index) => {
                const pathData = this.paths[index];
                if (pathData && pathData.currentD) {
                    pathEl.setAttribute('d', pathData.currentD);
                }
            });

            // Materialize any paths added after the SVG was loaded (e.g. continuation/
            // reconstruction lines) - these live only in this.paths and were never
            // written into this.svgData.element, so build their <path>/<g> elements here.
            const svgNS = 'http://www.w3.org/2000/svg';
            const newGroups = {};

            this.paths.slice(this.originalPathCount).forEach(pathData => {
                if (!pathData.currentD) return;
                if (this.layerVisibility[pathData.layerId] === false) return;

                let group = newGroups[pathData.layerId];
                if (!group) {
                    group = svgClone.querySelector(`g[id="${pathData.layerId}"]`);
                    if (!group) {
                        group = document.createElementNS(svgNS, 'g');
                        group.setAttribute('id', pathData.layerId);
                        svgClone.appendChild(group);
                    }
                    newGroups[pathData.layerId] = group;
                }

                const pathEl = document.createElementNS(svgNS, 'path');
                pathEl.setAttribute('id', pathData.id);
                pathEl.setAttribute('d', pathData.currentD);
                pathEl.setAttribute('stroke', pathData.style.stroke);
                pathEl.setAttribute('stroke-width', pathData.style.strokeWidth);
                pathEl.setAttribute('fill', pathData.style.fill);
                group.appendChild(pathEl);
            });

            // Update all image elements with modified positions
            const imageElements = svgClone.querySelectorAll('image');

            imageElements.forEach((imgEl, index) => {
                const imageData = this.images[index];
                if (imageData) {
                    imgEl.setAttribute('x', imageData.x);
                    imgEl.setAttribute('y', imageData.y);
                    imgEl.setAttribute('opacity', imageData.opacity);

                    // Remove invisible images
                    if (!imageData.visible) {
                        imgEl.parentNode.removeChild(imgEl);
                    }
                }
            });

            // Remove invisible layers (groups)
            const groups = svgClone.querySelectorAll('g[id^="layer_"]');
            groups.forEach(group => {
                const layerId = group.getAttribute('id');
                if (this.layerVisibility[layerId] === false) {
                    group.parentNode.removeChild(group);
                }
            });

            // Serialize to string
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svgClone);

            // Send to backend to save in the project folder
            const response = await fetch('/api/save_modified_svg', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    svg_content: svgString,
                    include_background: includeBackground,
                    session_id: this.sessionId || 'default',
                    image_name: this.currentImageName || 'output',
                    project_id: this.currentProjectId || (window.app ? window.app.currentProjectId : null)
                })
            });

            const data = await response.json();

            if (data.success) {
                // Show success message with the actual save path
                const fileName = data.output_path ? data.output_path.split(/[/\\]/).pop() : 'file';
                const message = `SVG saved: ${fileName}`;
                if (window.app) {
                    window.app.showNotification(message, 'success');
                }
                console.log('Modified SVG saved to:', data.output_path);

                // Mark current image as vectorized in ImageGrid and TabManager
                if (window.ImageGrid && this.sessionId) {
                    await window.ImageGrid.markAsVectorized(this.sessionId);
                    console.log('✓ Image marked as vectorized in thumbnails');
                }
                const currentImgName = window.app?.currentImageFilename || this.currentImageName || (window.ImageGrid?.images && window.ImageGrid?.currentIndex >= 0 && window.ImageGrid.images[window.ImageGrid.currentIndex]?.filename);
                if (window.tabManager && currentImgName) {
                    window.tabManager.markImageAsVectorized(currentImgName);
                }

                // NO automatic ZIP download - just save the SVG file
            } else {
                throw new Error(data.error || 'Error while saving');
            }

        } catch (error) {
            console.error('Export error:', error);
            if (window.app) {
                window.app.showNotification('Error during export: ' + error.message, 'error');
            } else {
                alert('Error during export: ' + error.message);
            }
        }
    }

    downloadCompleteZip() {
        if (!this.zipDownloadUrl) {
            if (window.app) {
                window.app.showNotification('ZIP file not available. Please export segments from the Segmentation tab first.', 'warning');
            } else {
                alert('ZIP file not available. Please export segments from the Segmentation tab first.');
            }
            return;
        }

        console.log('Downloading complete ZIP from:', this.zipDownloadUrl);

        // Trigger download
        window.location.href = this.zipDownloadUrl;

        if (window.app) {
            window.app.showNotification('Complete ZIP download started!', 'success');
        }
    }

    loadTestSVG() {
        console.log('Loading test SVG...');

        // Create a test SVG directly
        const testSVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
    <g id="layer1">
        <path d="M 100 100 L 200 100 L 200 200 L 100 200 Z" 
              stroke="#000000" stroke-width="2" fill="none"/>
        <path d="M 250 100 L 350 100 L 350 200 L 250 200 Z" 
              stroke="#ff0000" stroke-width="2" fill="none"/>
    </g>
    <g id="layer2">
        <path d="M 100 250 C 100 250 150 300 200 250" 
              stroke="#0000ff" stroke-width="2" fill="none"/>
    </g>
</svg>`;

        console.log('Test SVG text:', testSVG);

        // Parse SVG directly
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(testSVG, 'image/svg+xml');
        const svgElement = svgDoc.querySelector('svg');

        if (!svgElement) {
            console.error('Failed to parse test SVG');
            if (window.app) {
                window.app.showNotification('Error parsing test SVG', 'error');
            } else {
                alert('Error parsing test SVG');
            }
            return;
        }

        console.log('Test SVG element:', svgElement);

        // Extract viewBox or dimensions
        const viewBox = svgElement.getAttribute('viewBox');
        let width, height;

        if (viewBox) {
            const [, , w, h] = viewBox.split(' ').map(Number);
            width = w;
            height = h;
        } else {
            width = parseFloat(svgElement.getAttribute('width')) || 500;
            height = parseFloat(svgElement.getAttribute('height')) || 500;
        }

        console.log('Test SVG dimensions:', width, 'x', height);

        this.svgData = {
            width,
            height,
            element: svgElement,
            text: testSVG
        };

        // Extract paths and their points
        this.extractPaths(svgElement);

        console.log('Test SVG paths extracted:', this.paths.length);

        // Update UI
        this.updateLayersList();
        this.updateStats();

        // Hide message
        document.getElementById('svg-canvas-message').style.display = 'none';

        // Enable save button
        document.getElementById('svg-save-btn').disabled = false;

        // ZIP download button stays disabled for test SVG (if present)
        const zipBtn = document.getElementById('svg-download-zip-btn');
        if (zipBtn) {
            zipBtn.disabled = true;
        }

        // Save initial state
        this.saveState();

        // Force canvas resize and redraw
        const container = this.canvas.parentElement;
        const rect = container.getBoundingClientRect();
        this.canvas.width = rect.width || container.clientWidth;
        this.canvas.height = rect.height || container.clientHeight;

        console.log('Canvas size after load:', this.canvas.width, 'x', this.canvas.height);

        // Reset view and redraw
        this.resetView();

        console.log('Test SVG loaded successfully!');
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // SVG Editor will be initialized when tab is activated
    console.log('SVG Editor script loaded');
});
