/**
 * Image Navigation Grid Module
 * Handles the image grid display and navigation in Segmentation tab
 */

const ImageGrid = {
    images: [],
    currentIndex: -1,
    projectId: null,
    
    /**
     * Initialize the image grid
     */
    init() {
        console.log('ImageGrid initialized');
    },
    
    /**
     * Load images for current project
     */
    async loadProjectImages(projectId) {
        this.projectId = projectId;
        
        try {
            const response = await fetch(`/api/projects/${projectId}/images?folder=uploads&include_status=true`);
            const data = await response.json();
            
            if (data.success) {
                this.images = data.images.map((img, index) => {
                    // Handle both string and object formats
                    if (typeof img === 'string') {
                        return {
                            filename: img,
                            index,
                            vectorized: false,
                            sessionId: null
                        };
                    } else {
                        return {
                            filename: img.filename,
                            index,
                            vectorized: img.vectorized || false,
                            sessionId: null
                        };
                    }
                });
                
                // Render grid
                this.renderGrid();
                
                // Load first image if available
                if (this.images.length > 0) {
                    this.selectImage(0);
                }
            }
        } catch (error) {
            console.error('Error loading project images:', error);
        }
    },
    
    /**
     * Load vectorization status from project metadata
     */
    async loadVectorizationStatus() {
        if (!this.projectId) return;
        
        try {
            const response = await fetch(`/api/projects/${this.projectId}`);
            const data = await response.json();
            
            if (data.success && data.project.workflow_status) {
                const processedImages = data.project.workflow_status.processed_images || [];
                
                // Update vectorization status for each image
                this.images.forEach(img => {
                    const processed = processedImages.find(p => p.filename === img.filename);
                    if (processed) {
                        img.vectorized = processed.vectorized || false;
                        img.sessionId = processed.session_id || null;
                    }
                });
            }
        } catch (error) {
            console.error('Error loading vectorization status:', error);
        }
    },
    
    /**
     * Render the image grid
     */
    renderGrid() {
        const gridContainer = document.getElementById('image-navigation-grid');
        const countEl = document.getElementById('grid-image-count');
        
        if (!gridContainer) return;
        
        // Update count
        if (countEl) {
            countEl.textContent = this.images.length;
        }
        
        if (this.images.length === 0) {
            gridContainer.innerHTML = '<p class="empty-message">No images in project</p>';
            return;
        }
        
        gridContainer.innerHTML = this.images.map((img, index) => `
            <div class="grid-image-item ${img.vectorized ? 'vectorized' : ''} ${index === this.currentIndex ? 'active' : ''}" 
                 data-index="${index}"
                 onclick="ImageGrid.selectImage(${index})"
                 title="${img.filename}${img.vectorized ? ' (Vectorized)' : ''}">
                <img src="/api/projects/${this.projectId}/images/${encodeURIComponent(img.filename)}?folder=uploads" 
                     alt="${img.filename}"
                     onerror="this.style.display='none'; this.nextElementSibling.style.paddingTop='20px';">
                <div class="grid-image-name">${this.getShortName(img.filename)}</div>
            </div>
        `).join('');
    },
    
    /**
     * Get shortened filename for display
     */
    getShortName(filename) {
        if (filename.length <= 12) return filename;
        const ext = filename.split('.').pop();
        const name = filename.substring(0, 8);
        return `${name}...${ext}`;
    },
    
    /**
     * Select an image
     */
    async selectImage(index) {
        if (index < 0 || index >= this.images.length) return;
        
        this.currentIndex = index;
        const image = this.images[index];
        
        // Update active state in grid
        document.querySelectorAll('.grid-image-item').forEach((item, idx) => {
            item.classList.toggle('active', idx === index);
        });
        
        // Update current image info
        const filenameEl = document.getElementById('filename');
        if (filenameEl) {
            filenameEl.textContent = image.filename;
        }
        
        const currentImageEl = document.getElementById('current-image-number');
        if (currentImageEl) {
            currentImageEl.textContent = index + 1;
        }
        
        const totalImagesEl = document.getElementById('total-images');
        if (totalImagesEl) {
            totalImagesEl.textContent = this.images.length;
        }
        
        // Load image in canvas
        await this.loadImageInCanvas(image);
        
        // Load existing session if available
        if (image.sessionId) {
            await this.loadExistingSession(image.sessionId);
        }
        
        // Update navigation buttons
        this.updateNavigationButtons();
    },
    
    /**
     * Load image in canvas
     */
    async loadImageInCanvas(image) {
        // This will be called by the canvas module
        // Trigger event for canvas to load the image
        const event = new CustomEvent('imageSelected', {
            detail: {
                projectId: this.projectId,
                filename: image.filename,
                index: this.currentIndex
            }
        });
        document.dispatchEvent(event);
    },
    
    /**
     * Load existing segmentation session
     */
    async loadExistingSession(sessionId) {
        try {
            const response = await fetch(`/api/projects/${this.projectId}/sessions/${sessionId}`);
            const data = await response.json();
            
            if (data.success) {
                // Trigger event to load session data
                const event = new CustomEvent('sessionLoaded', {
                    detail: data.session
                });
                document.dispatchEvent(event);
            }
        } catch (error) {
            console.error('Error loading session:', error);
        }
    },
    
    /**
     * Update navigation buttons state
     */
    updateNavigationButtons() {
        const prevBtn = document.getElementById('prev-image-btn');
        const nextBtn = document.getElementById('next-image-btn');
        
        if (prevBtn) {
            prevBtn.disabled = this.currentIndex <= 0;
        }
        
        if (nextBtn) {
            nextBtn.disabled = this.currentIndex >= this.images.length - 1;
        }
    },
    
    /**
     * Navigate to previous image
     */
    previousImage() {
        if (this.currentIndex > 0) {
            this.selectImage(this.currentIndex - 1);
        }
    },
    
    /**
     * Navigate to next image
     */
    nextImage() {
        if (this.currentIndex < this.images.length - 1) {
            this.selectImage(this.currentIndex + 1);
        }
    },
    
    /**
     * Mark current image as vectorized
     */
    async markAsVectorized(sessionId) {
        if (this.currentIndex < 0) return;
        
        const image = this.images[this.currentIndex];
        image.vectorized = true;
        image.sessionId = sessionId;
        
        // Update grid display
        this.renderGrid();
        
        // Update project metadata
        await this.updateProjectMetadata();
    },
    
    /**
     * Update project metadata with current image status
     */
    async updateProjectMetadata() {
        if (!this.projectId) return;
        
        try {
            const processedImages = this.images.map(img => ({
                filename: img.filename,
                vectorized: img.vectorized,
                session_id: img.sessionId
            }));
            
            await fetch(`/api/projects/${this.projectId}/workflow`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    status: {
                        images_vectorized: this.images.filter(img => img.vectorized).length,
                        processed_images: processedImages,
                        current_image_index: this.currentIndex
                    }
                })
            });
        } catch (error) {
            console.error('Error updating project metadata:', error);
        }
    },
    
    /**
     * Clear grid
     */
    clear() {
        this.images = [];
        this.currentIndex = -1;
        this.projectId = null;
        
        const gridContainer = document.getElementById('image-navigation-grid');
        if (gridContainer) {
            gridContainer.innerHTML = '<p class="empty-message">No images in project</p>';
        }
        
        const countEl = document.getElementById('grid-image-count');
        if (countEl) {
            countEl.textContent = '0';
        }
    }
};

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    ImageGrid.init();
    
    // Setup navigation button listeners
    const prevBtn = document.getElementById('prev-image-btn');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => ImageGrid.previousImage());
    }
    
    const nextBtn = document.getElementById('next-image-btn');
    if (nextBtn) {
        nextBtn.addEventListener('click', () => ImageGrid.nextImage());
    }
});

// Export for use in other modules
window.ImageGrid = ImageGrid;
