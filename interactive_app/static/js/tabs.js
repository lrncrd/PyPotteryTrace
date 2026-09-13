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
        this.setupSetupImageUpload();
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

        // GUARD: Block switching away if mask is currently in edit mode
        if (window.segmentationManager && window.segmentationManager.isEditingPolygon && tabId !== 'segmentation-tab') {
            if (window.app) {
                window.app.showNotification('Please finish or cancel mask editing before leaving (click "Done Editing" or "Cancel")', 'warning');
            }
            return;
        }

        // GUARD: Block switching to tabs that require an active project if none is loaded
        const projectRequiredTabs = ['segmentation-tab', 'svg-editor-tab', 'postprocess-tab'];
        if (projectRequiredTabs.includes(tabId)) {
            const hasProject = (window.ProjectManager && window.ProjectManager.currentProject) || sessionStorage.getItem('current_project_id');
            if (!hasProject) {
                if (window.app && window.app.showNotification) {
                    window.app.showNotification('Please select or open a project first', 'warning');
                } else if (window.ProjectManager && window.ProjectManager.showNotification) {
                    window.ProjectManager.showNotification('Please select or open a project first', 'warning');
                }
                return;
            }
        }

        // Update buttons
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Update content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === tabId);
        });

        this.currentTab = tabId;

        // If switching to segmentation tab, resize canvas and reset view
        if (tabId === 'segmentation-tab') {
            console.log('Syncing canvas for segmentation tab');
            const syncCanvas = () => {
                if (window.canvasManager) {
                    window.canvasManager.resize();
                    if (!window.canvasManager.image && window.ImageGrid && window.ImageGrid.images && window.ImageGrid.images.length > 0) {
                        const targetIdx = window.ImageGrid.currentIndex >= 0 ? window.ImageGrid.currentIndex : 0;
                        window.ImageGrid.selectImage(targetIdx);
                    } else if (window.canvasManager.image) {
                        window.canvasManager.fitToCanvas();
                        window.canvasManager.redraw();
                    }
                }
            };
            setTimeout(syncCanvas, 50);
            setTimeout(syncCanvas, 150);
            setTimeout(syncCanvas, 300);
        }

        // If switching to SVG Editor tab, resize canvas and reset view properly
        if (tabId === 'svg-editor-tab' || tabId === 'svg-tab') {
            const syncSvgCanvas = () => {
                if (window.svgEditor) {
                    window.svgEditor.handleTabActivated();
                }
            };
            setTimeout(syncSvgCanvas, 50);
            setTimeout(syncSvgCanvas, 150);
            setTimeout(syncSvgCanvas, 300);
        }

        // If switching to Post-Processing tab, ALWAYS load vectorized files
        if (tabId === 'postprocess-tab' && window.postProcessingManager) {
            const pId = window.postProcessingManager.currentProjectId || sessionStorage.getItem('current_project_id');
            const pName = sessionStorage.getItem('current_project_name');
            if (pId) {
                window.postProcessingManager.currentProjectId = pId;
                window.postProcessingManager.updateProjectInfo(pId, pName);
                console.log('Loading vectorized files for Post-Processing tab:', pId);
                window.postProcessingManager.loadProjectVectorizedFiles();
            }
        }

        // If switching to Projects tab, refresh the project list
        if (tabId === 'projects-tab' || tabId === 'project-tab') {
            const pm = (typeof ProjectManager !== 'undefined') ? ProjectManager : window.ProjectManager;
            if (pm && pm.loadProjectsList) {
                console.log('Refreshing project list');
                pm.loadProjectsList();
            }
        }
    }

    enableTab(tabId) {
        const button = document.querySelector(`.tab-button[data-tab="${tabId}"]`);
        if (button) {
            button.disabled = false;
        }
    }

    // Folder Selection (legacy - now handled by project manager)
    setupFolderSelection() {
        const selectButton = document.getElementById('select-folder-btn');
        const folderInput = document.getElementById('folder-input');

        // Skip if elements don't exist (folder selection removed from UI)
        if (!selectButton || !folderInput) {
            console.log('Folder selection elements not found - using project manager instead');
            return;
        }

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

            // Update UI - show project images info, hide "no project" message
            const noProjectMsg = document.getElementById('no-project-message');
            const projectImagesInfo = document.getElementById('project-images-info');
            const setupDropZone = document.getElementById('setup-drop-zone');
            if (noProjectMsg) noProjectMsg.style.display = 'none';
            if (projectImagesInfo) projectImagesInfo.style.display = 'flex';
            if (setupDropZone) setupDropZone.style.display = 'flex';

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

            // Fetch images list from project with include_status=true
            const response = await fetch(`/api/projects/${projectId}/images?folder=uploads&include_status=true`);
            const data = await response.json();

            console.log('API Response:', data);

            if (!data.success || !data.images || data.images.length === 0) {
                console.log('No images in project uploads folder');
                const noProjectMsg = document.getElementById('no-project-message');
                const projectImagesInfo = document.getElementById('project-images-info');
                const setupDropZone = document.getElementById('setup-drop-zone');
                if (noProjectMsg) noProjectMsg.style.display = 'none';
                if (projectImagesInfo) projectImagesInfo.style.display = 'flex';
                if (setupDropZone) setupDropZone.style.display = 'flex';
                const folderNameEl = document.getElementById('folder-name');
                const imagesCountEl = document.getElementById('images-count');
                const previewEl = document.getElementById('images-preview');
                if (folderNameEl) folderNameEl.textContent = projectName || 'Project';
                if (imagesCountEl) imagesCountEl.textContent = '0';
                if (previewEl) previewEl.innerHTML = '';
                return false;
            }

            // Also check project workflow status for existing vectorization
            let processedMap = {};
            try {
                const projResp = await fetch(`/api/projects/${projectId}`);
                const projData = await projResp.json();
                if (projData.success && projData.project && projData.project.workflow_status) {
                    const processed = projData.project.workflow_status.processed_images || [];
                    processed.forEach(p => {
                        if (p.filename && p.vectorized) {
                            processedMap[p.filename] = true;
                        }
                    });
                }
            } catch (e) {
                console.warn('Could not fetch project workflow status:', e);
            }

            const totalImages = data.images.length;
            console.log(`Loading ${totalImages} images from project...`);

            // Show loading overlay
            this.showLoadingOverlay('Loading Project Images...', `Loading ${totalImages} images from project`, 0, totalImages);

            // Fetch each image and create File objects with webkitRelativePath
            const files = [];

            for (let i = 0; i < data.images.length; i++) {
                try {
                    const item = data.images[i];
                    const filename = typeof item === 'string' ? item : item.filename;
                    const isVectorized = (typeof item === 'object' && item.vectorized) || !!processedMap[filename];
                    console.log(`Fetching image ${i + 1}/${totalImages}: ${filename}`);

                    const imgResponse = await fetch(`/api/projects/${projectId}/images/${encodeURIComponent(filename)}?folder=uploads`);
                    const blob = await imgResponse.blob();

                    // Create File object with fake webkitRelativePath
                    const file = new File([blob], filename, { type: blob.type });
                    file.vectorized = isVectorized;

                    // Add fake webkitRelativePath property (needed by handleFolderSelection)
                    Object.defineProperty(file, 'webkitRelativePath', {
                        value: `${projectName}_uploads/${filename}`,
                        writable: false
                    });

                    files.push(file);
                    console.log(`✓ Loaded: ${filename} (vectorized: ${isVectorized})`);

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
        if (!previewContainer) return;
        previewContainer.innerHTML = '';

        // Show thumbnails (up to 100)
        const previewCount = Math.min(100, this.imageFiles.length);

        for (let i = 0; i < previewCount; i++) {
            const file = this.imageFiles[i];
            const thumb = document.createElement('div');
            thumb.className = `images-preview-thumb ${file.vectorized ? 'vectorized' : ''}`;
            thumb.dataset.filename = file.name;
            thumb.dataset.index = i;
            thumb.title = `${file.name}${file.vectorized ? ' (Vectorized)' : ''} — Click to view in Segmentation`;

            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.alt = file.name;

            const nameEl = document.createElement('span');
            nameEl.className = 'images-preview-name';
            nameEl.textContent = file.name;

            thumb.appendChild(img);
            thumb.appendChild(nameEl);

            thumb.addEventListener('click', async () => {
                if (window.tabManager) {
                    window.tabManager.switchTab('segmentation-tab');
                }
                if (window.ImageGrid && window.ImageGrid.images && window.ImageGrid.images.length > 0) {
                    const imgIndex = window.ImageGrid.images.findIndex(item => item.filename === file.name);
                    const targetIdx = imgIndex !== -1 ? imgIndex : i;
                    if (targetIdx >= 0 && targetIdx < window.ImageGrid.images.length) {
                        await window.ImageGrid.selectImage(targetIdx);
                    }
                }
                setTimeout(() => {
                    if (window.canvasManager) {
                        window.canvasManager.resize();
                        window.canvasManager.fitToCanvas();
                        window.canvasManager.redraw();
                    }
                }, 100);
            });

            previewContainer.appendChild(thumb);
        }

        if (this.imageFiles.length > previewCount) {
            const moreText = document.createElement('div');
            moreText.className = 'images-preview-more';
            moreText.textContent = `... and ${this.imageFiles.length - previewCount} more images`;
            previewContainer.appendChild(moreText);
        }
    }

    markImageAsVectorized(filename) {
        if (!filename) return;
        const file = this.imageFiles.find(f => f.name === filename);
        if (file) {
            file.vectorized = true;
        }
        const thumbs = document.querySelectorAll('.images-preview-thumb');
        thumbs.forEach(thumb => {
            if (thumb.dataset.filename === filename) {
                thumb.classList.add('vectorized');
                thumb.title = `${filename} (Vectorized) — Click to view in Segmentation`;
            }
        });
    }


    checkStartButton() {
        const hasImages = this.imageFiles.length > 0;

        // If images are present, enable segmentation tab so user can proceed.
        // Model loading is handled separately by server-side endpoints or other UI flows.
        if (hasImages) {
            this.enableTab('segmentation-tab');
        }
    }

    // startProcessing removed: model loading can be triggered via other UI flows or server-side endpoints.

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

    setupSetupImageUpload() {
        const dropZone = document.getElementById('setup-drop-zone');
        const fileInput = document.getElementById('setup-file-input');

        if (!dropZone || !fileInput) return;

        // Click browse handler
        dropZone.addEventListener('click', () => fileInput.click());

        // File input change
        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                this.uploadFilesToProject(e.target.files);
                fileInput.value = '';
            }
        });

        // Drag and drop handlers on dropZone
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('drag-over');
            });
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('drag-over');
            });
        });

        dropZone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            if (dt && dt.files && dt.files.length > 0) {
                this.uploadFilesToProject(dt.files);
            }
        });

        // Also allow drag and drop on the folder-info container
        const folderInfo = document.getElementById('folder-info');
        if (folderInfo) {
            folderInfo.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('drag-over');
            });
            folderInfo.addEventListener('dragleave', (e) => {
                if (!folderInfo.contains(e.relatedTarget)) {
                    dropZone.classList.remove('drag-over');
                }
            });
            folderInfo.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('drag-over');
                const dt = e.dataTransfer;
                if (dt && dt.files && dt.files.length > 0) {
                    this.uploadFilesToProject(dt.files);
                }
            });
        }
    }

    async uploadFilesToProject(files) {
        const pm = (typeof ProjectManager !== 'undefined') ? ProjectManager : window.ProjectManager;
        const projectId = (pm && pm.currentProject)
            ? pm.currentProject.project_id
            : sessionStorage.getItem('current_project_id');
        const projectName = (pm && pm.currentProject)
            ? pm.currentProject.project_name
            : sessionStorage.getItem('current_project_name') || 'Project';

        if (!projectId) {
            if (pm && pm.showNotification) {
                pm.showNotification('Please select or open a project first.', 'error');
            } else {
                alert('Please select or open a project first.');
            }
            return;
        }

        // Filter valid image extensions
        const validExtensions = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp'];
        const imageFiles = Array.from(files).filter(file => {
            const ext = '.' + file.name.split('.').pop().toLowerCase();
            return validExtensions.includes(ext);
        });

        if (imageFiles.length === 0) {
            if (pm && pm.showNotification) {
                pm.showNotification('No valid image files selected (supported: PNG, JPG, BMP, TIFF).', 'error');
            }
            return;
        }

        if (pm && pm.showNotification) {
            pm.showNotification(`Uploading ${imageFiles.length} image(s)...`, 'info');
        }

        this.showLoadingOverlay('Adding Images...', `Uploading ${imageFiles.length} image(s) to project`, 0, imageFiles.length);

        const formData = new FormData();
        imageFiles.forEach(file => {
            formData.append('files', file);
        });

        try {
            const response = await fetch(`/api/projects/${projectId}/upload`, {
                method: 'POST',
                body: formData
            });

            const data = await response.json();

            if (data.success) {
                const count = data.count !== undefined ? data.count : imageFiles.length;
                if (pm && pm.showNotification) {
                    pm.showNotification(`${count} image(s) added successfully!`, 'success');
                }

                // 1. Immediately reload the project images in Setup tab (this TabManager)
                await this.loadProjectImages(projectId, projectName);

                // 2. Also reload segmentation grid so new images are available in Segmentation tab
                if (pm && pm.loadProjectImages) {
                    await pm.loadProjectImages(projectId);
                } else if (window.ImageGrid && window.ImageGrid.loadProjectImages) {
                    await window.ImageGrid.loadProjectImages(projectId);
                }
            } else {
                if (pm && pm.showNotification) {
                    pm.showNotification(`Error uploading: ${data.error}`, 'error');
                }
            }
        } catch (error) {
            console.error('Error uploading images:', error);
            if (pm && pm.showNotification) {
                pm.showNotification('Failed to upload images', 'error');
            }
        } finally {
            this.hideLoadingOverlay();
        }
    }
}

// Note: TabManager is initialized in app.js to avoid double initialization

