"""
SAM2 Handler for PyPotteryTrace Interactive
Manages Segment Anything Model 2 for interactive segmentation

Supports:
- Point prompts (positive/negative clicks)
- Box prompts (bounding boxes)
- Multiple prompts combination
- Mask refinement
"""

import os
import numpy as np
import torch
import cv2
from pathlib import Path
from typing import List, Tuple, Optional, Dict

# Import SAM2
try:
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    SAM2_AVAILABLE = True
except ImportError:
    SAM2_AVAILABLE = False
    print("Warning: SAM2 not installed. Please install: pip install git+https://github.com/facebookresearch/segment-anything-2.git")

# Checkpoint storage: shared across the suite when launched by the PyPottery Suite
# launcher (PYPOTTERY_MODEL_CACHE set, so a checkpoint already downloaded by another
# app isn't fetched again, and updating this app doesn't wipe it). Standalone (no
# launcher), self-contained under this app's own "models" folder as before.
_suite_model_cache = os.environ.get('PYPOTTERY_MODEL_CACHE')
MODELS_DIR = Path(_suite_model_cache) / "sam2" if _suite_model_cache else Path('models')


class SAM2Handler:
    """Handler for SAM2 segmentation model."""
    
    # Available model configurations
    MODEL_CONFIGS = {
        'tiny': 'sam2_hiera_t.yaml',
        'small': 'sam2_hiera_s.yaml',
        'base': 'sam2_hiera_b+.yaml',
        'large': 'sam2_hiera_l.yaml'
    }
    
    # Model checkpoint URLs (will be downloaded automatically)
    MODEL_CHECKPOINTS = {
        'tiny': 'https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_tiny.pt',
        'small': 'https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_small.pt',
        'base': 'https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_base_plus.pt',
        'large': 'https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_large.pt'
    }
    
    # Approximate model sizes in MB
    MODEL_SIZES = {
        'tiny': 40,
        'small': 180,
        'base': 230,
        'large': 900
    }
    
    @staticmethod
    def get_model_info(model_size: str) -> Dict:
        """
        Get information about a model without loading it.
        
        Args:
            model_size: Model size ('tiny', 'small', 'base', 'large')
            
        Returns:
            Dictionary with model info (exists, path, url, size_mb)
        """
        if model_size not in SAM2Handler.MODEL_CHECKPOINTS:
            raise ValueError(f"Invalid model size: {model_size}")
        
        url = SAM2Handler.MODEL_CHECKPOINTS[model_size]
        filename = url.split('/')[-1]
        models_dir = MODELS_DIR
        checkpoint_path = models_dir / filename
        
        return {
            'model_size': model_size,
            'exists': checkpoint_path.exists(),
            'path': str(checkpoint_path),
            'url': url,
            'size_mb': SAM2Handler.MODEL_SIZES[model_size],
            'filename': filename
        }
    
    @staticmethod
    def download_with_progress(model_size: str, progress_callback=None) -> str:
        """
        Download model checkpoint with progress tracking.
        
        Args:
            model_size: Model size to download
            progress_callback: Function to call with progress updates
                              Signature: callback(downloaded_bytes, total_bytes, status)
            
        Returns:
            Path to downloaded checkpoint
        """
        if model_size not in SAM2Handler.MODEL_CHECKPOINTS:
            raise ValueError(f"Invalid model size: {model_size}")
        
        url = SAM2Handler.MODEL_CHECKPOINTS[model_size]
        models_dir = MODELS_DIR
        models_dir.mkdir(parents=True, exist_ok=True)
        
        filename = url.split('/')[-1]
        checkpoint_path = models_dir / filename
        
        if checkpoint_path.exists():
            if progress_callback:
                # File already exists, report 100% immediately
                file_size = checkpoint_path.stat().st_size
                progress_callback(file_size, file_size, 'complete')
            return str(checkpoint_path)
        
        # Download with progress
        import urllib.request
        
        def report_hook(block_num, block_size, total_size):
            if progress_callback:
                downloaded = block_num * block_size
                if total_size > 0:
                    progress_callback(downloaded, total_size, 'downloading')
        
        if progress_callback:
            progress_callback(0, SAM2Handler.MODEL_SIZES[model_size] * 1024 * 1024, 'starting')
        
        urllib.request.urlretrieve(url, checkpoint_path, reporthook=report_hook)
        
        if progress_callback:
            file_size = checkpoint_path.stat().st_size
            progress_callback(file_size, file_size, 'complete')
        
        return str(checkpoint_path)
    
    def __init__(self, model_size: str = 'small', device: str = 'auto'):
        """
        Initialize SAM2 handler.
        
        Args:
            model_size: Model size ('tiny', 'small', 'base', 'large')
            device: Device to run on ('cuda', 'cpu', 'auto')
        """
        if not SAM2_AVAILABLE:
            raise ImportError("SAM2 is not installed. Please install it first.")
        
        self.model_size = model_size
        
        # Set device
        if device == 'auto':
            self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        else:
            self.device = device
        
        print(f"Initializing SAM2 ({model_size}) on {self.device}...")
        
        # Load model
        self._load_model()
        
        # Current image state
        self.current_image = None
        self.current_image_path = None
        self.image_embedding = None
        
    def _load_model(self):
        """Load SAM2 model."""
        config = self.MODEL_CONFIGS[self.model_size]
        checkpoint_url = self.MODEL_CHECKPOINTS[self.model_size]
        
        # Download checkpoint if needed
        checkpoint_path = self._download_checkpoint(checkpoint_url)
        
        # Build SAM2 model
        sam2_model = build_sam2(config, checkpoint_path, device=self.device)
        
        # Create predictor
        self.predictor = SAM2ImagePredictor(sam2_model)
        
        print(f"SAM2 model loaded successfully")
    
    def _download_checkpoint(self, url: str) -> str:
        """
        Download model checkpoint if not already present.
        
        Args:
            url: URL to download checkpoint from
            
        Returns:
            Path to checkpoint file
        """
        models_dir = MODELS_DIR
        models_dir.mkdir(parents=True, exist_ok=True)
        
        filename = url.split('/')[-1]
        checkpoint_path = models_dir / filename
        
        if checkpoint_path.exists():
            print(f"Using cached checkpoint: {checkpoint_path}")
            return str(checkpoint_path)
        
        print(f"Downloading checkpoint from {url}...")
        import urllib.request
        urllib.request.urlretrieve(url, checkpoint_path)
        print(f"Checkpoint downloaded to {checkpoint_path}")
        
        return str(checkpoint_path)
    
    def set_image(self, image_path: str) -> np.ndarray:
        """
        Set the image to segment.
        
        Args:
            image_path: Path to image file
            
        Returns:
            Image as numpy array
        """
        # Load image
        image = cv2.imread(image_path)
        if image is None:
            raise ValueError(f"Could not load image from {image_path}")
        
        # Convert BGR to RGB
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        
        # Set image in predictor (computes embeddings)
        self.predictor.set_image(image)
        
        self.current_image = image
        self.current_image_path = image_path
        
        print(f"Image set: {image_path} ({image.shape[1]}x{image.shape[0]})")
        
        return image
    
    def segment_with_points(
        self,
        points: List[Tuple[int, int]],
        labels: List[int],
        multimask_output: bool = False
    ) -> np.ndarray:
        """
        Segment with point prompts.
        
        Args:
            points: List of (x, y) coordinates
            labels: List of labels (1 = positive, 0 = negative)
            multimask_output: If True, returns multiple masks
            
        Returns:
            Binary mask (H, W) as numpy array
        """
        if self.current_image is None:
            raise ValueError("No image set. Call set_image() first.")
        
        # Convert to numpy arrays
        point_coords = np.array(points, dtype=np.float32)
        point_labels = np.array(labels, dtype=np.int32)
        
        # Predict mask
        masks, scores, logits = self.predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            multimask_output=multimask_output
        )
        
        # Return best mask
        if multimask_output:
            # Select mask with highest score
            best_idx = np.argmax(scores)
            mask = masks[best_idx]
        else:
            mask = masks[0]
        
        return mask.astype(np.uint8)
    
    def segment_with_box(
        self,
        box: Tuple[int, int, int, int],
        multimask_output: bool = False
    ) -> np.ndarray:
        """
        Segment with box prompt.
        
        Args:
            box: Bounding box as (x1, y1, x2, y2)
            multimask_output: If True, returns multiple masks
            
        Returns:
            Binary mask (H, W) as numpy array
        """
        if self.current_image is None:
            raise ValueError("No image set. Call set_image() first.")
        
        # Convert to numpy array
        box_coords = np.array(box, dtype=np.float32)
        
        # Predict mask
        masks, scores, logits = self.predictor.predict(
            box=box_coords,
            multimask_output=multimask_output
        )
        
        # Return best mask
        if multimask_output:
            best_idx = np.argmax(scores)
            mask = masks[best_idx]
        else:
            mask = masks[0]
        
        return mask.astype(np.uint8)
    
    def segment_with_combined_prompts(
        self,
        points: Optional[List[Tuple[int, int]]] = None,
        labels: Optional[List[int]] = None,
        box: Optional[Tuple[int, int, int, int]] = None,
        multimask_output: bool = False
    ) -> np.ndarray:
        """
        Segment with combined point and box prompts.
        
        Args:
            points: List of (x, y) coordinates (optional)
            labels: List of labels for points (optional)
            box: Bounding box as (x1, y1, x2, y2) (optional)
            multimask_output: If True, returns multiple masks
            
        Returns:
            Binary mask (H, W) as numpy array
        """
        if self.current_image is None:
            raise ValueError("No image set. Call set_image() first.")
        
        # Prepare inputs
        point_coords = np.array(points, dtype=np.float32) if points else None
        point_labels = np.array(labels, dtype=np.int32) if labels else None
        box_coords = np.array(box, dtype=np.float32) if box else None
        
        # Predict mask
        masks, scores, logits = self.predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box_coords,
            multimask_output=multimask_output
        )
        
        # Return best mask
        if multimask_output:
            best_idx = np.argmax(scores)
            mask = masks[best_idx]
        else:
            mask = masks[0]
        
        return mask.astype(np.uint8)
    
    def refine_mask(
        self,
        initial_mask: np.ndarray,
        additional_points: List[Tuple[int, int]],
        additional_labels: List[int]
    ) -> np.ndarray:
        """
        Refine an existing mask with additional points.
        
        Args:
            initial_mask: Initial binary mask
            additional_points: New points to add
            additional_labels: Labels for new points
            
        Returns:
            Refined binary mask
        """
        if self.current_image is None:
            raise ValueError("No image set. Call set_image() first.")
        
        # Convert mask to logits (required by SAM2)
        mask_input = initial_mask[None, :, :].astype(np.float32)
        
        # Prepare point inputs
        point_coords = np.array(additional_points, dtype=np.float32)
        point_labels = np.array(additional_labels, dtype=np.int32)
        
        # Predict refined mask
        masks, scores, logits = self.predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            mask_input=mask_input,
            multimask_output=False
        )
        
        return masks[0].astype(np.uint8)
    
    def get_image_info(self) -> Dict:
        """Get information about current image."""
        if self.current_image is None:
            return {'loaded': False}
        
        return {
            'loaded': True,
            'path': self.current_image_path,
            'width': self.current_image.shape[1],
            'height': self.current_image.shape[0],
            'channels': self.current_image.shape[2]
        }


# Example usage and testing
if __name__ == '__main__':
    # Test SAM2 handler
    handler = SAM2Handler(model_size='small')
    
    print("SAM2Handler initialized successfully!")
    print(f"Model: {handler.model_size}")
    print(f"Device: {handler.device}")
