// PyPotteryTrace Interactive - Main Application Script

console.log('app.js loaded');

class PyPotteryTraceApp {
    constructor() {
        console.log('PyPotteryTraceApp constructor called');
        this.sessionId = null;
        this.currentImage = null;
        this.segments = [];
        this.rotationCenter = null;
        this.currentMode = 'point';
        this.epsilon = 1.5;
        this.smoothing = 0.3;
        
        // New: Image folder navigation
        this.imageFiles = [];
        this.currentImageIndex = 0;
        this.saveTrainingData = false;
        
        console.log('Calling init()');
        this.init();
        console.log('Constructor complete');
    }
    
    init() {
        this.setupEventListeners();
        this.setupHelpModal();
        this.updateUI();
    }
    
    setupEventListeners() {
        // Image navigation
        document.getElementById('prev-image-btn').addEventListener('click', () => {
            this.navigateImage(-1);
        });
        
        document.getElementById('next-image-btn').addEventListener('click', () => {
            this.navigateImage(1);
        });
        
        // Mode selection
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setMode(btn.dataset.mode);
            });
        });
        
        // Category and name
        document.getElementById('category-select').addEventListener('change', () => {
            this.updateElementName();
        });
        
        // Add segment button
        document.getElementById('add-segment-btn').addEventListener('click', () => {
            this.addCurrentSegment();
        });
        
        // Clear preview button
        document.getElementById('clear-preview-btn').addEventListener('click', () => {
            this.clearPreview();
        });
        
        // Settings sliders
        document.getElementById('epsilon-slider').addEventListener('input', (e) => {
            this.epsilon = parseFloat(e.target.value);
            document.getElementById('epsilon-value').textContent = this.epsilon.toFixed(1);
        });
        
        document.getElementById('smoothing-slider').addEventListener('input', (e) => {
            this.smoothing = parseFloat(e.target.value);
            document.getElementById('smoothing-value').textContent = this.smoothing.toFixed(1);
        });
        
        // Export button
        document.getElementById('export-btn').addEventListener('click', () => {
            this.exportSegments();
        });
        
        // Debug export button (PNG masks)
        document.getElementById('debug-export-btn').addEventListener('click', () => {
            this.exportMasksDebug();
        });
        
        // Zoom controls
        document.getElementById('zoom-in-btn').addEventListener('click', () => {
            if (window.canvasManager) window.canvasManager.zoom(1.2);
        });
        
        document.getElementById('zoom-out-btn').addEventListener('click', () => {
            if (window.canvasManager) window.canvasManager.zoom(0.8);
        });
        
        document.getElementById('reset-view-btn').addEventListener('click', () => {
            if (window.canvasManager) window.canvasManager.resetView();
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            this.handleKeyboardShortcut(e);
        });
    }
    
    setupHelpModal() {
        const modal = document.getElementById('help-modal');
        const btn = document.getElementById('help-btn');
        const span = document.getElementsByClassName('close')[0];
        
        btn.onclick = () => {
            modal.style.display = 'flex';
        };
        
        span.onclick = () => {
            modal.style.display = 'none';
        };
        
        window.onclick = (event) => {
            if (event.target == modal) {
                modal.style.display = 'none';
            }
        };
    }
    
    setMode(mode) {
        console.log('Setting mode to:', mode);
        this.currentMode = mode;
        
        // Update UI
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        
        // Show/hide point controls
        const pointControls = document.getElementById('point-controls');
        pointControls.style.display = mode === 'point' ? 'block' : 'none';
        
        // Update canvas cursor
        if (window.canvasManager) {
            window.canvasManager.setMode(mode);
        }
        
        console.log('Mode set successfully. Current mode:', this.currentMode);
    }
    
    async loadImageAtIndex(index) {
        console.log('=== loadImageAtIndex called ===');
        console.log('Index:', index);
        console.log('Total images:', this.imageFiles.length);
        
        if (index < 0 || index >= this.imageFiles.length) {
            console.error('Invalid image index:', index);
            return;
        }
        
        this.currentImageIndex = index;
        const file = this.imageFiles[index];
        console.log('Loading file:', file.name);
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.sessionId = data.session_id;
                this.currentImage = data.image_url;
                this.currentImageFilename = data.filename;  // Store filename for SVG export
                
                // Clear segments for new image
                this.segments = [];
                this.rotationCenter = null;
                
                // IMPORTANT: Clear canvas completely (masks, SVG overlay, rotation center)
                if (window.canvasManager) {
                    console.log('Clearing canvas for new image...');
                    window.canvasManager.clearAll();
                }
                
                // Clear segmentation preview
                if (window.segmentationManager) {
                    window.segmentationManager.clearCurrentSegment();
                }
                
                // Update UI
                document.getElementById('filename').textContent = data.filename;
                document.getElementById('current-image-number').textContent = index + 1;
                document.getElementById('total-images').textContent = this.imageFiles.length;
                document.getElementById('canvas-message').style.display = 'none';
                
                // Update navigation buttons
                document.getElementById('prev-image-btn').disabled = (index === 0);
                document.getElementById('next-image-btn').disabled = (index === this.imageFiles.length - 1);
                
                // Load image in canvas
                console.log('Loading image in canvas:', this.currentImage);
                console.log('canvasManager available:', window.canvasManager ? 'YES' : 'NO');
                
                if (window.canvasManager) {
                    window.canvasManager.loadImage(this.currentImage);
                } else {
                    console.error('canvasManager not available!');
                }
                
                // Update UI
                this.updateSegmentsList();
                this.updateStats();
                
                this.showNotification(`Loaded image ${index + 1} of ${this.imageFiles.length}`, 'success');
            } else {
                throw new Error(data.error || 'Upload failed');
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showNotification('Failed to upload image: ' + error.message, 'error');
        }
    }
    
    navigateImage(direction) {
        const newIndex = this.currentImageIndex + direction;
        
        if (newIndex >= 0 && newIndex < this.imageFiles.length) {
            this.loadImageAtIndex(newIndex);
        }
    }
    
    async handleImageUpload(file) {
        if (!file) return;
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.sessionId = data.session_id;
                this.currentImage = data.image_url;
                
                // Update UI
                document.getElementById('filename').textContent = data.filename;
                document.getElementById('canvas-message').style.display = 'none';
                
                // Load image in canvas
                if (window.canvasManager) {
                    window.canvasManager.loadImage(this.currentImage);
                }
                
                // Switch to segmentation tab to show the image
                if (window.tabManager) {
                    tabManager.switchTab('segmentation-tab');
                }
                
                this.showNotification('Image uploaded successfully!', 'success');
            } else {
                throw new Error(data.error || 'Upload failed');
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showNotification('Failed to upload image: ' + error.message, 'error');
        }
    }
    
    updateElementName() {
        const category = document.getElementById('category-select').value;
        const nameInput = document.getElementById('element-name');
        const count = this.segments.filter(s => s.category === category).length + 1;
        nameInput.placeholder = `${category} ${count}`;
        
        // Set default vectorization based on category
        const vectorizeCheckbox = document.getElementById('vectorize-checkbox');
        vectorizeCheckbox.checked = this.getDefaultVectorization(category);
    }
    
    async addCurrentSegment() {
        if (!segmentationManager.currentMask) {
            this.showNotification('No segment to add', 'warning');
            return;
        }
        
        if (!segmentationManager.previewContours) {
            this.showNotification('No preview contours available', 'warning');
            return;
        }
        
        const category = document.getElementById('category-select').value;
        const nameInput = document.getElementById('element-name');
        const name = nameInput.value || nameInput.placeholder;
        const shouldVectorize = document.getElementById('vectorize-checkbox').checked;
        
        // Store preview contours before clearing
        const contoursToSave = segmentationManager.previewContours;
        
        // Disable the add button immediately to prevent double-clicking
        const addButton = document.getElementById('add-segment-btn');
        addButton.disabled = true;
        
        try {
            const response = await fetch('/api/add_segment', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    session_id: this.sessionId,
                    mask: segmentationManager.currentMask,
                    category: category,
                    name: name,
                    should_vectorize: shouldVectorize
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                // Add to local list
                this.segments.push({
                    id: data.segment_id,
                    name: name,
                    category: category,
                    should_vectorize: shouldVectorize
                });
                
                // Save the stored contours to canvas as a permanent mask
                if (window.canvasManager) {
                    window.canvasManager.addSavedMask(contoursToSave, category, name, data.segment_id);
                    
                    // Clear SVG overlay since we now have updated masks
                    window.canvasManager.clearSVG();
                }
                
                // Update UI
                this.updateSegmentsList();
                this.updateStats();
                this.clearPreview();
                nameInput.value = '';
                this.updateElementName();
                
                this.showNotification('Segment added successfully!', 'success');
            } else {
                throw new Error(data.error || 'Failed to add segment');
            }
        } catch (error) {
            console.error('Add segment error:', error);
            this.showNotification('Failed to add segment: ' + error.message, 'error');
            // Re-enable the button if there was an error
            addButton.disabled = false;
        }
    }
    
    clearPreview() {
        segmentationManager.clearCurrentSegment();
        document.getElementById('add-segment-btn').disabled = true;
        document.getElementById('clear-preview-btn').disabled = true;
    }
    
    updateSegmentsList() {
        const list = document.getElementById('segments-list');
        
        if (this.segments.length === 0) {
            list.innerHTML = '<p class="empty-message">No segments yet</p>';
            document.getElementById('export-btn').disabled = true;
            return;
        }
        
        list.innerHTML = '';
        
        this.segments.forEach((segment, index) => {
            // Use stored value or default based on category
            const shouldVectorize = segment.should_vectorize !== undefined ? segment.should_vectorize : this.getDefaultVectorization(segment.category);
            const vectorizeIcon = shouldVectorize ? '🎨' : '🖼️';
            const vectorizeText = shouldVectorize ? 'SVG' : 'PNG';
            
            const item = document.createElement('div');
            item.className = 'segment-item';
            item.innerHTML = `
                <div class="segment-info">
                    <div class="segment-name">${segment.name}</div>
                    <div class="segment-category">${this.getCategoryIcon(segment.category)} ${segment.category}</div>
                    <div class="segment-vectorize" style="font-size: 0.8em; color: #666; margin-top: 2px;">
                        ${vectorizeIcon} ${vectorizeText}
                    </div>
                </div>
                <div class="segment-actions">
                    <button class="icon-btn delete" onclick="window.app.deleteSegment('${segment.id}')">
                        🗑️
                    </button>
                </div>
            `;
            list.appendChild(item);
        });
        
        document.getElementById('export-btn').disabled = false;
        document.getElementById('debug-export-btn').disabled = false;
    }
    
    getCategoryIcon(category) {
        const icons = {
            'Profile': '🏺',
            'Application': '🎯',
            'Handle': '🪢',
            'Prospectus': '👁️',
            'Decoration': '🎨',
            'Section': '✂️',
            'Detail': '📌'
        };
        return icons[category] || '📄';
    }
    
    getDefaultVectorization(category) {
        // Profile and Application are vectorized by default
        return category === 'Profile' || category === 'Application';
    }
    
    async deleteSegment(segmentId) {
        console.log('=== DELETE SEGMENT DEBUG (Frontend) ===');
        console.log('Deleting segment ID:', segmentId);
        console.log('All segments in frontend:', this.segments.map(s => ({id: s.id, name: s.name})));
        if (window.canvasManager) {
            console.log('Saved masks in canvas:', window.canvasManager.savedMasks.map(m => ({id: m.segmentId, name: m.name})));
        }
        
        if (!confirm('Are you sure you want to delete this segment?')) {
            return;
        }
        
        try {
            const response = await fetch('/api/delete_segment', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    session_id: this.sessionId,
                    segment_id: segmentId
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                console.log('Backend deleted successfully, total segments now:', data.total_segments);
                
                // Remove from local list
                const beforeLength = this.segments.length;
                this.segments = this.segments.filter(s => s.id !== segmentId);
                console.log(`Frontend segments: ${beforeLength} -> ${this.segments.length}`);
                
                // Remove the specific mask from canvas
                console.log('Calling removeSavedMask for:', segmentId);
                if (window.canvasManager) {
                    window.canvasManager.removeSavedMask(segmentId);
                    
                    // Clear SVG overlay since it's no longer accurate
                    window.canvasManager.clearSVG();
                }
                
                // Update UI
                this.updateSegmentsList();
                this.updateStats();
                
                this.showNotification('Segment deleted', 'success');
            } else {
                throw new Error(data.error || 'Failed to delete segment');
            }
        } catch (error) {
            console.error('Delete segment error:', error);
            this.showNotification('Failed to delete segment: ' + error.message, 'error');
        }
    }
    
    updateStats() {
        document.getElementById('stat-segments').textContent = this.segments.length;
        
        const profiles = this.segments.filter(s => s.category === 'Profile').length;
        document.getElementById('stat-profiles').textContent = profiles;
        
        const decorations = this.segments.filter(s => s.category === 'Decoration').length;
        document.getElementById('stat-decorations').textContent = decorations;
    }
    
    async setRotationCenter(x, y) {
        try {
            const response = await fetch('/api/set_rotation_center', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    session_id: this.sessionId,
                    x: x,
                    y: y
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.rotationCenter = {x, y};
                
                // Update UI
                document.getElementById('rotation-center-info').style.display = 'block';
                document.getElementById('rotation-coords').textContent = `(${Math.round(x)}, ${Math.round(y)})`;
                
                // Draw marker on canvas
                if (window.canvasManager) {
                    window.canvasManager.drawRotationCenter(x, y);
                }
                
                this.showNotification('Rotation center set', 'success');
            } else {
                throw new Error(data.error || 'Failed to set rotation center');
            }
        } catch (error) {
            console.error('Set rotation center error:', error);
            this.showNotification('Failed to set rotation center: ' + error.message, 'error');
        }
    }
    
    async exportSegments() {
        if (this.segments.length === 0) {
            this.showNotification('No segments to export', 'warning');
            return;
        }
        
        const exportStatus = document.getElementById('export-status');
        const progressFill = document.getElementById('progress-fill');
        const statusText = document.getElementById('status-text');
        
        exportStatus.style.display = 'block';
        progressFill.style.width = '0%';
        statusText.textContent = 'Processing segments...';
        
        try {
            progressFill.style.width = '30%';
            
            const includeBackground = document.getElementById('bg-checkbox').checked;
            
            console.log('Calling /api/generate_svg_preview with:', {
                session_id: this.sessionId,
                epsilon: this.epsilon,
                smoothing_factor: this.smoothing,
                include_background: includeBackground
            });
            
            // Call the export endpoint
            const response = await fetch('/api/generate_svg_preview', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    session_id: this.sessionId,
                    epsilon: this.epsilon,
                    smoothing_factor: this.smoothing,
                    include_background: includeBackground
                })
            });
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Export failed');
            }
            
            progressFill.style.width = '80%';
            statusText.textContent = 'Download starting...';
            
            // Trigger download of the ZIP file
            window.location.href = data.zip_url;
            
            progressFill.style.width = '100%';
            statusText.textContent = 'Export complete!';
            
            setTimeout(() => {
                exportStatus.style.display = 'none';
                
                // Auto-advance to next image if available
                if (this.imageFiles.length > 0 && this.currentImageIndex < this.imageFiles.length - 1) {
                    this.showNotification('Moving to next image...', 'info');
                    setTimeout(() => {
                        this.navigateImage(1);
                    }, 1000);
                } else if (this.imageFiles.length > 0 && this.currentImageIndex === this.imageFiles.length - 1) {
                    this.showNotification('All images completed! 🎉', 'success');
                }
            }, 2000);
            
            this.showNotification('Export completed! ZIP file downloaded.', 'success');
            
        } catch (error) {
            console.error('Export error:', error);
            statusText.textContent = 'Error: ' + error.message;
            this.showNotification('Failed to export: ' + error.message, 'error');
            
            setTimeout(() => {
                exportStatus.style.display = 'none';
            }, 3000);
        }
    }
    
    async exportMasksDebug() {
        if (this.segments.length === 0) {
            this.showNotification('No segments to export', 'warning');
            return;
        }
        
        const exportStatus = document.getElementById('export-status');
        const progressFill = document.getElementById('progress-fill');
        const statusText = document.getElementById('status-text');
        
        exportStatus.style.display = 'block';
        progressFill.style.width = '0%';
        statusText.textContent = 'Exporting masks as PNG...';
        
        try {
            progressFill.style.width = '30%';
            
            // Call the debug export endpoint
            const response = await fetch('/api/export_masks_debug', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    session_id: this.sessionId
                })
            });
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Export failed');
            }
            
            progressFill.style.width = '80%';
            statusText.textContent = `Exported ${data.total_masks} masks. Downloading...`;
            
            // Trigger download
            window.location.href = data.download_url;
            
            progressFill.style.width = '100%';
            statusText.textContent = 'Download started!';
            
            setTimeout(() => {
                exportStatus.style.display = 'none';
            }, 2000);
            
            this.showNotification(`Exported ${data.total_masks} masks as PNG`, 'success');
            
        } catch (error) {
            console.error('Export error:', error);
            statusText.textContent = 'Error: ' + error.message;
            this.showNotification('Failed to export masks: ' + error.message, 'error');
        }
    }
    
    handleKeyboardShortcut(e) {
        // Check if user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }
        
        switch(e.key.toLowerCase()) {
            case 'p':
                this.setMode('point');
                break;
            case 'b':
                this.setMode('box');
                break;
            case 'r':
                this.setMode('rotation');
                break;
            case '+':
            case '=':
                if (window.canvasManager) window.canvasManager.zoom(1.2);
                break;
            case '-':
            case '_':
                if (window.canvasManager) window.canvasManager.zoom(0.8);
                break;
            case 'z':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    // Implement undo
                }
                break;
        }
    }
    
    showNotification(message, type = 'info') {
        // Simple notification system (can be enhanced with a library)
        const colors = {
            success: '#10b981',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#2563eb'
        };
        
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            background: ${colors[type]};
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            z-index: 1000;
            animation: slideIn 0.3s ease;
        `;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
    
    updateUI() {
        this.updateSegmentsList();
        this.updateStats();
        this.updateElementName();
    }
}



// Add CSS animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);


// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
   console.log('DOM Content Loaded - Starting initialization');
 
    try {
         // Initialize canvas manager
         console.log('Initializing canvas manager...');
         window.canvasManager = new CanvasManager('main-canvas');
         console.log('Canvas manager initialized:', window.canvasManager);
 
        // Initialize tab manager
        console.log('Initializing tab manager...');
        window.tabManager = new TabManager();
        console.log('Tab manager initialized:', window.tabManager);

        // Initialize ONE main app instance and assign it to window.app
        console.log('Initializing main app...');
        window.app = new PyPotteryTraceApp(); // L'unica istanza che ti serve
        console.log('Main app initialized:', window.app);

        // Initialize segmentation manager
        console.log('Initializing segmentation manager...');
        window.segmentationManager = new SegmentationManager();
        console.log('Segmentation manager initialized:', window.segmentationManager);

        console.log('All initialization complete!');
  } catch (error) {
     console.error('Error during initialization:', error);
 }
});