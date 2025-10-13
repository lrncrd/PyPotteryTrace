// Segmentation Manager - Handles SAM2 segmentation interactions

class SegmentationManager {
    constructor() {
        this.points = [];
        this.labels = [];
        this.boxStart = null;
        this.boxEnd = null;
        this.currentMask = null;
        this.previewContours = null;
        this.isDrawingBox = false;
        
        this.init();
    }
    
    init() {
        this.setupCanvasInteraction();
    }
    
    setupCanvasInteraction() {
        const canvas = document.getElementById('main-canvas');
        
        canvas.addEventListener('click', (e) => {
            console.log('Canvas click event triggered', {
                hasApp: !!window.app,
                hasSessionId: window.app ? !!window.app.sessionId : false,
                currentMode: window.app ? window.app.currentMode : 'unknown'
            });
            
            if (!window.app || !window.app.sessionId) {
                if (window.app) {
                    window.app.showNotification('Please upload an image first', 'warning');
                }
                return;
            }
            
            if (!window.canvasManager) {
                console.error('Canvas manager not available');
                return;
            }
            
            const coords = window.canvasManager.getImageCoordinates(e);
            console.log('Coordinates:', coords, 'Mode:', window.app.currentMode);
            
            switch(window.app.currentMode) {
                case 'point':
                    console.log('Adding point at', coords);
                    this.addPoint(coords.x, coords.y);
                    break;
                case 'rotation':
                    console.log('Setting rotation center at', coords);
                    window.app.setRotationCenter(coords.x, coords.y);
                    break;
            }
        });
        
        // Box drawing
        canvas.addEventListener('mousedown', (e) => {
            if (!window.app || window.app.currentMode !== 'box' || !window.app.sessionId) return;
            if (e.button !== 0 || e.ctrlKey) return; // Only left click without Ctrl
            
            console.log('Box mode: mousedown');
            
            if (!window.canvasManager) return;
            
            const coords = window.canvasManager.getImageCoordinates(e);
            this.boxStart = coords;
            this.isDrawingBox = true;
        });
        
        canvas.addEventListener('mousemove', (e) => {
            if (!this.isDrawingBox) return;
            
            if (!window.canvasManager) return;
            
            const coords = window.canvasManager.getImageCoordinates(e);
            this.boxEnd = coords;
            
            // Draw preview box
            this.drawBoxPreview();
        });
        
        canvas.addEventListener('mouseup', (e) => {
            if (!this.isDrawingBox) return;
            
            console.log('Box mode: mouseup');
            
            if (!window.canvasManager) return;
            
            const coords = window.canvasManager.getImageCoordinates(e);
            this.boxEnd = coords;
            this.isDrawingBox = false;
            
            // Perform segmentation
            this.segmentWithBox();
        });
    }
    
    addPoint(x, y) {
        console.log('addPoint called with:', x, y);
        
        // Get current point label (positive or negative)
        const labelRadio = document.querySelector('input[name="point-label"]:checked');
        const label = parseInt(labelRadio.value);
        
        console.log('Point label:', label);
        
        this.points.push([x, y]);
        this.labels.push(label);
        
        console.log('Total points:', this.points.length);
        
        // Redraw canvas to show the new point
        if (window.canvasManager) {
            window.canvasManager.redraw();
        }
        
        // Perform segmentation
        this.segmentWithPoints();
    }
    
    drawBoxPreview() {
        if (!this.boxStart || !this.boxEnd || !window.canvasManager) return;
        
        window.canvasManager.redraw();
        
        const ctx = window.canvasManager.ctx;
        const start = window.canvasManager.imageToCanvas(this.boxStart.x, this.boxStart.y);
        const end = window.canvasManager.imageToCanvas(this.boxEnd.x, this.boxEnd.y);
        
        ctx.save();
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        
        ctx.strokeRect(
            start.x,
            start.y,
            end.x - start.x,
            end.y - start.y
        );
        
        ctx.restore();
    }
    
    async segmentWithPoints() {
        if (this.points.length === 0) return;
        
        try {
            const response = await fetch('/api/segment', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    session_id: app.sessionId,
                    prompt_type: 'point',
                    points: this.points,
                    labels: this.labels
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.currentMask = data.mask;
                this.previewContours = data.contours;
                
                // Redraw canvas with preview
                if (window.canvasManager) {
                    window.canvasManager.redraw();
                }
                
                // Enable add segment button
                document.getElementById('add-segment-btn').disabled = false;
                document.getElementById('clear-preview-btn').disabled = false;
            } else {
                throw new Error(data.error || 'Segmentation failed');
            }
        } catch (error) {
            console.error('Segmentation error:', error);
            if (window.app) {
                app.showNotification('Segmentation failed: ' + error.message, 'error');
            }
        }
    }
    
    async segmentWithBox() {
        if (!this.boxStart || !this.boxEnd) return;
        
        // Calculate box coordinates
        const x1 = Math.min(this.boxStart.x, this.boxEnd.x);
        const y1 = Math.min(this.boxStart.y, this.boxEnd.y);
        const x2 = Math.max(this.boxStart.x, this.boxEnd.x);
        const y2 = Math.max(this.boxStart.y, this.boxEnd.y);
        
        try {
            const response = await fetch('/api/segment', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    session_id: app.sessionId,
                    prompt_type: 'box',
                    box: [x1, y1, x2, y2]
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.currentMask = data.mask;
                this.previewContours = data.contours;
                
                // Redraw canvas with preview
                if (window.canvasManager) {
                    window.canvasManager.redraw();
                }
                
                // Enable add segment button
                document.getElementById('add-segment-btn').disabled = false;
                document.getElementById('clear-preview-btn').disabled = false;
            } else {
                throw new Error(data.error || 'Segmentation failed');
            }
        } catch (error) {
            console.error('Segmentation error:', error);
            if (window.app) {
                app.showNotification('Segmentation failed: ' + error.message, 'error');
            }
        }
        
        // Reset box
        this.boxStart = null;
        this.boxEnd = null;
    }
    
    clearCurrentSegment() {
        this.points = [];
        this.labels = [];
        this.boxStart = null;
        this.boxEnd = null;
        this.currentMask = null;
        this.previewContours = null;
        
        // Redraw canvas
        if (window.canvasManager) {
            window.canvasManager.redraw();
        }
    }
}
