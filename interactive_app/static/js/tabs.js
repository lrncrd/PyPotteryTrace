// Tab Management for PyPotteryTrace Interactive

class TabManager {
    constructor() {
        this.currentTab = 'model-tab';
        this.selectedModel = null;
        this.imageFiles = [];
        this.currentImageIndex = 0;
        this.folderPath = null;
        
        this.init();
    }
    
    init() {
        this.setupTabButtons();
        this.setupFolderSelection();
        this.setupStartButton();
    }
    
    setupTabButtons() {
        const tabButtons = document.querySelectorAll('.tab-button');
        
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                if (button.disabled) return;
                
                const tabId = button.dataset.tab;
                this.switchTab(tabId);
            });
        });
    }
    
    switchTab(tabId) {
        console.log('Switching to tab:', tabId);
        
        // Update buttons
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });
        
        // Update content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === tabId);
        });
        
        this.currentTab = tabId;
        
        // If switching to segmentation tab, resize canvas
        if (tabId === 'segmentation-tab' && window.canvasManager) {
            console.log('Resizing canvas for segmentation tab');
            setTimeout(() => {
                window.canvasManager.resize();
                console.log('Canvas resized');
            }, 50);
        }
    }
    
    enableTab(tabId) {
        const button = document.querySelector(`.tab-button[data-tab="${tabId}"]`);
        if (button) {
            button.disabled = false;
        }
    }
    
    // Folder Selection
    setupFolderSelection() {
        const selectButton = document.getElementById('select-folder-btn');
        const folderInput = document.getElementById('folder-input');
        
        selectButton.addEventListener('click', () => {
            folderInput.click();
        });
        
        folderInput.addEventListener('change', (e) => {
            this.handleFolderSelection(e.target.files);
        });
    }
    
    handleFolderSelection(files) {
        console.log('=== handleFolderSelection START ===');
        console.log('Received files:', files);
        console.log('Files count:', files.length);
        
        // Show loading overlay
        this.showLoadingOverlay('Loading Images...', 'Processing your image files', 0, files.length);
        
        // Use setTimeout to allow UI to update
        setTimeout(() => {
            // Filter only image files
            const imageExtensions = ['jpg', 'jpeg', 'png', 'tiff', 'bmp', 'gif'];
            this.imageFiles = [];
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const ext = file.name.split('.').pop().toLowerCase();
                console.log(`File: ${file.name}, ext: ${ext}, webkitRelativePath: ${file.webkitRelativePath}`);
                
                if (imageExtensions.includes(ext)) {
                    this.imageFiles.push(file);
                }
                
                // Update progress every 10 files or at the end
                if (i % 10 === 0 || i === files.length - 1) {
                    this.updateLoadingProgress(i + 1, files.length);
                }
            }
            
            console.log('Filtered imageFiles count:', this.imageFiles.length);
            
            if (this.imageFiles.length === 0) {
                this.hideLoadingOverlay();
                alert('No image files found in the selected folder!');
                return;
            }
            
            // Sort files by name
            this.imageFiles.sort((a, b) => a.name.localeCompare(b.name));
            
            // Extract folder path from first file
            this.folderPath = this.imageFiles[0].webkitRelativePath.split('/')[0];
            
            // Output folder is automatically set to project's exports folder
            this.outputFolderPath = this.folderPath + '_vectorized';
            
            // Enable post-processing tab immediately (can work independently)
            this.enableTab('postprocess-tab');
            
            // Update UI
            document.getElementById('folder-info').style.display = 'block';
            document.getElementById('folder-name').textContent = this.folderPath;
            document.getElementById('images-count').textContent = this.imageFiles.length;
            
            // Show preview thumbnails
            this.showImagePreviews();
            
            // Enable start button
            this.checkStartButton();
            
            // Hide loading overlay after a brief delay
            setTimeout(() => {
                this.hideLoadingOverlay();
            }, 300);
        }, 100);
    }
    
    /**
     * Load images from a project (called by ProjectManager)
     */
    async loadProjectImages(projectId, projectName) {
        try {
            console.log('=== loadProjectImages START ===');
            console.log('Project ID:', projectId);
            console.log('Project Name:', projectName);
            
            // Fetch images list from project
            const response = await fetch(`/api/projects/${projectId}/images?folder=uploads`);
            const data = await response.json();
            
            console.log('API Response:', data);
            
            if (!data.success || !data.images || data.images.length === 0) {
                console.log('No images in project uploads folder');
                return false;
            }
            
            const totalImages = data.images.length;
            console.log(`Loading ${totalImages} images from project...`);
            
            // Show loading overlay
            this.showLoadingOverlay('Loading Project Images...', `Loading ${totalImages} images from project`, 0, totalImages);
            
            // Fetch each image and create File objects with webkitRelativePath
            const files = [];
            
            for (let i = 0; i < data.images.length; i++) {
                try {
                    const imgName = data.images[i];
                    // imgName is just a string (filename), not an object
                    const filename = typeof imgName === 'string' ? imgName : imgName.filename;
                    console.log(`Fetching image ${i + 1}/${totalImages}: ${filename}`);
                    
                    const imgResponse = await fetch(`/api/projects/${projectId}/images/${filename}?folder=uploads`);
                    const blob = await imgResponse.blob();
                    
                    // Create File object with fake webkitRelativePath
                    const file = new File([blob], filename, { type: blob.type });
                    
                    // Add fake webkitRelativePath property (needed by handleFolderSelection)
                    Object.defineProperty(file, 'webkitRelativePath', {
                        value: `${projectName}_uploads/${filename}`,
                        writable: false
                    });
                    
                    files.push(file);
                    console.log(`✓ Loaded: ${filename}`);
                    
                    // Update progress
                    this.updateLoadingProgress(i + 1, totalImages);
                } catch (err) {
                    console.error(`Failed to load image ${filename}:`, err);
                }
            }
            
            console.log(`Total files loaded: ${files.length}`);
            
            if (files.length === 0) {
                this.hideLoadingOverlay();
                console.log('No files to load!');
                return false;
            }
            
            // Use the existing handleFolderSelection function!
            console.log('Calling handleFolderSelection with', files.length, 'files');
            this.handleFolderSelection(files);
            
            console.log('=== loadProjectImages END ===');
            return true;
        } catch (error) {
            console.error('Error loading project images:', error);
            this.hideLoadingOverlay();
            return false;
        }
    }
    
    showImagePreviews() {
        const previewContainer = document.getElementById('images-preview');
        previewContainer.innerHTML = '';
        
        // Show first 20 images as thumbnails
        const previewCount = Math.min(20, this.imageFiles.length);
        
        for (let i = 0; i < previewCount; i++) {
            const file = this.imageFiles[i];
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.title = file.name;
            previewContainer.appendChild(img);
        }
        
        if (this.imageFiles.length > 20) {
            const moreText = document.createElement('div');
            moreText.style.cssText = 'grid-column: span 2; text-align: center; color: #666; font-size: 0.9em;';
            moreText.textContent = `... and ${this.imageFiles.length - 20} more`;
            previewContainer.appendChild(moreText);
        }
    }
    
    setupStartButton() {
        const startButton = document.getElementById('start-processing-btn');
        
        startButton.addEventListener('click', async () => {
            await this.startProcessing();
        });
    }
    
    checkStartButton() {
        const startButton = document.getElementById('start-processing-btn');
        const hasImages = this.imageFiles.length > 0;
        
        startButton.disabled = !hasImages;
    }
    
    async startProcessing() {
        // Get selected model
        const selectedModel = document.querySelector('input[name="model"]:checked');
        if (!selectedModel) {
            alert('Please select a model!');
            return;
        }
        
        const modelSize = selectedModel.value;
        
        // Training data is always saved (no checkbox anymore)
        const saveTraining = true;
        
        // Load model
        const statusDiv = document.getElementById('model-loading-status');
        const messageEl = document.getElementById('model-status-message');
        
        statusDiv.style.display = 'block';
        messageEl.textContent = `Loading ${modelSize} model...`;
        
        try {
            const response = await fetch('/api/load_model', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    model_size: modelSize,
                    save_training_data: saveTraining
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.selectedModel = modelSize;
                messageEl.textContent = `${modelSize} model loaded successfully!`;
                
                // Store settings in app
                if (window.app) {
                    window.app.imageFiles = this.imageFiles;
                    window.app.currentImageIndex = 0;
                    window.app.saveTrainingData = saveTraining;
                }
                
                // Switch to segmentation tab FIRST
                setTimeout(async () => {
                    statusDiv.style.display = 'none';
                    this.enableTab('segmentation-tab');
                    this.enableTab('postprocess-tab');
                    this.switchTab('segmentation-tab');
                    
                    // Wait a bit for tab switch and canvas resize
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // NOW load the first image
                    if (window.app && window.app.imageFiles.length > 0) {
                        await window.app.loadImageAtIndex(0);
                    }
                }, 500);
            } else {
                throw new Error(data.error || 'Failed to load model');
            }
        } catch (error) {
            console.error('Error loading model:', error);
            messageEl.textContent = `Error: ${error.message}`;
        }
    }
    
    // Loading overlay utilities
    showLoadingOverlay(title, message, current, total) {
        const overlay = document.getElementById('loading-overlay');
        const titleEl = document.getElementById('loading-overlay-title');
        const messageEl = document.getElementById('loading-overlay-message');
        const progressBar = document.getElementById('loading-overlay-progress-bar');
        const progressText = document.getElementById('loading-overlay-progress-text');
        
        if (overlay) {
            overlay.classList.add('active');
            if (titleEl) titleEl.textContent = title;
            if (messageEl) messageEl.textContent = message;
            if (progressBar) progressBar.style.width = '0%';
            if (progressText) progressText.textContent = `${current} / ${total} images loaded`;
        }
    }
    
    updateLoadingProgress(current, total) {
        const progressBar = document.getElementById('loading-overlay-progress-bar');
        const progressText = document.getElementById('loading-overlay-progress-text');
        
        if (progressBar && progressText) {
            const percentage = Math.round((current / total) * 100);
            progressBar.style.width = `${percentage}%`;
            progressText.textContent = `${current} / ${total} images loaded`;
        }
    }
    
    hideLoadingOverlay() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }
}

// Note: TabManager is initialized in app.js to avoid double initialization

