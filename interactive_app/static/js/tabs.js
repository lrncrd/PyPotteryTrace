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
        
        // Output folder selection
        const selectOutputButton = document.getElementById('select-output-folder-btn');
        const outputFolderInput = document.getElementById('output-folder-input');
        
        selectOutputButton.addEventListener('click', () => {
            outputFolderInput.click();
        });
        
        outputFolderInput.addEventListener('change', (e) => {
            this.handleOutputFolderSelection(e.target.files);
        });
    }
    
    handleFolderSelection(files) {
        // Filter only image files
        const imageExtensions = ['jpg', 'jpeg', 'png', 'tiff', 'bmp', 'gif'];
        this.imageFiles = Array.from(files).filter(file => {
            const ext = file.name.split('.').pop().toLowerCase();
            return imageExtensions.includes(ext);
        });
        
        if (this.imageFiles.length === 0) {
            alert('No image files found in the selected folder!');
            return;
        }
        
        // Sort files by name
        this.imageFiles.sort((a, b) => a.name.localeCompare(b.name));
        
        // Extract folder path from first file
        this.folderPath = this.imageFiles[0].webkitRelativePath.split('/')[0];
        
        // ALWAYS set default output folder (input_folder + "_vectorized")
        this.outputFolderPath = this.folderPath + '_vectorized';
        document.getElementById('output-folder-name').textContent = this.outputFolderPath;
        
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
    }
    
    handleOutputFolderSelection(files) {
        if (files.length === 0) return;
        
        // Extract folder path from first file
        const folderPath = files[0].webkitRelativePath.split('/')[0];
        this.outputFolderPath = folderPath;
        
        // Update UI
        document.getElementById('output-folder-name').textContent = folderPath;
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
        
        // Get training data checkbox
        const saveTraining = document.getElementById('save-training-data').checked;
        
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
}

// Note: TabManager is initialized in app.js to avoid double initialization
