#!/usr/bin/env python3
"""
ML Export Handler - Export segmentation masks for machine learning training
Supports COCO format and custom formats with rotation center metadata

Author: Lorenzo Cardarelli
Version: 0.1
"""

import json
import numpy as np
from pathlib import Path
from datetime import datetime
from PIL import Image
import cv2


class MLExportHandler:
    """
    Handler for exporting segmentation masks in ML training formats.
    Supports COCO format with additional metadata for rotation centers.
    """
    
    def __init__(self):
        """Initialize ML Export Handler."""
        self.supported_formats = ['coco', 'simple']
    
    def export_coco_format(self, segments, image_path, output_path, include_rle=False, rotation_center=None):
        """
        Export segments in COCO format (MS COCO dataset format).
        
        Args:
            segments: List of segment dictionaries with mask, category, name
            image_path: Path to the original image
            output_path: Path where to save the JSON file
            include_rle: Whether to include RLE encoding (default: False, uses polygon instead)
            rotation_center: Optional dict with 'x' and 'y' keys for rotation axis
        
        Returns:
            Dict with export statistics
        """
        try:
            # Load image to get dimensions
            img = cv2.imread(image_path)
            if img is None:
                raise ValueError(f"Could not load image: {image_path}")
            
            height, width = img.shape[:2]
            image_filename = Path(image_path).name
            
            # Create COCO structure
            coco_data = {
                "info": {
                    "description": "PyPotteryTrace - Archaeological pottery vectorization dataset",
                    "version": "1.0",
                    "year": datetime.now().year,
                    "contributor": "PyPotteryTrace Interactive",
                    "date_created": datetime.now().isoformat()
                },
                "licenses": [
                    {
                        "id": 1,
                        "name": "Unknown",
                        "url": ""
                    }
                ],
                "images": [
                    {
                        "id": 1,
                        "file_name": image_filename,
                        "width": width,
                        "height": height,
                        "date_captured": datetime.now().isoformat()
                    }
                ],
                "annotations": [],
                "categories": []
            }
            
            # Add rotation center metadata if provided
            if rotation_center is not None:
                coco_data["info"]["rotation_center"] = {
                    "x": rotation_center.get('x'),
                    "y": rotation_center.get('y'),
                    "description": "Axis of rotation for profile mirroring"
                }
                
                # Also add as a special keypoint annotation
                coco_data["annotations"].append({
                    "id": 0,
                    "image_id": 1,
                    "category_id": 0,
                    "category_name": "rotation_center",
                    "keypoints": [
                        rotation_center.get('x', 0),
                        rotation_center.get('y', 0),
                        2  # visibility flag: 2 = visible
                    ],
                    "num_keypoints": 1,
                    "iscrowd": 0,
                    "area": 0,
                    "bbox": [
                        rotation_center.get('x', 0),
                        rotation_center.get('y', 0),
                        0,
                        0
                    ]
                })
            
            # Collect unique categories
            category_names = list(set(seg['category'] for seg in segments))
            category_names.sort()
            
            # Create category mapping (start from id=1, id=0 reserved for rotation_center)
            category_map = {}
            for idx, cat_name in enumerate(category_names, start=1):
                category_id = idx
                category_map[cat_name] = category_id
                
                coco_data["categories"].append({
                    "id": category_id,
                    "name": cat_name,
                    "supercategory": "pottery_element"
                })
            
            # Add rotation_center as category 0
            coco_data["categories"].insert(0, {
                "id": 0,
                "name": "rotation_center",
                "supercategory": "metadata",
                "keypoints": ["rotation_axis"],
                "skeleton": []
            })
            
            # Process each segment
            annotation_id = 1  # Start from 1 (0 is rotation_center)
            
            for segment in segments:
                try:
                    mask = np.array(segment['mask'], dtype=np.uint8)
                    
                    if mask.max() == 0:
                        print(f"Warning: Empty mask for segment '{segment['name']}', skipping")
                        continue
                    
                    # Get category ID
                    category_id = category_map[segment['category']]
                    
                    # Calculate bounding box
                    coords = np.argwhere(mask > 0)
                    if len(coords) == 0:
                        print(f"Warning: No pixels in mask for '{segment['name']}', skipping")
                        continue
                    
                    y_min, x_min = coords.min(axis=0)
                    y_max, x_max = coords.max(axis=0)
                    bbox_width = int(x_max - x_min + 1)
                    bbox_height = int(y_max - y_min + 1)
                    bbox = [int(x_min), int(y_min), bbox_width, bbox_height]
                    
                    # Calculate area
                    area = int(np.sum(mask > 0))
                    
                    # Create annotation
                    annotation = {
                        "id": annotation_id,
                        "image_id": 1,
                        "category_id": category_id,
                        "category_name": segment['category'],
                        "segmentation": [],
                        "area": area,
                        "bbox": bbox,
                        "iscrowd": 0,
                        "metadata": {
                            "name": segment['name'],
                            "should_vectorize": segment.get('should_vectorize', True)
                        }
                    }
                    
                    # Add segmentation data
                    if include_rle:
                        # RLE encoding (more compact but less human-readable)
                        rle = self._mask_to_rle(mask)
                        annotation["segmentation"] = {
                            "counts": rle,
                            "size": [height, width]
                        }
                    else:
                        # Polygon encoding (standard COCO format)
                        polygons = self._mask_to_polygons(mask)
                        annotation["segmentation"] = polygons
                    
                    coco_data["annotations"].append(annotation)
                    annotation_id += 1
                    
                except Exception as e:
                    print(f"Error processing segment '{segment.get('name', 'unknown')}': {e}")
                    continue
            
            # Save to file
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(coco_data, f, indent=2, ensure_ascii=False)
            
            print(f"✓ COCO format exported: {output_path}")
            print(f"  - Images: {len(coco_data['images'])}")
            print(f"  - Annotations: {len(coco_data['annotations'])}")
            print(f"  - Categories: {len(coco_data['categories'])}")
            if rotation_center:
                print(f"  - Rotation center: ({rotation_center['x']}, {rotation_center['y']})")
            
            return {
                'success': True,
                'output_path': str(output_path),
                'images': len(coco_data['images']),
                'annotations': len(coco_data['annotations']),
                'categories': len(coco_data['categories']),
                'rotation_center': rotation_center
            }
            
        except Exception as e:
            print(f"Error exporting COCO format: {e}")
            import traceback
            traceback.print_exc()
            raise
    
    def export_simple_format(self, segments, image_path, output_path, rotation_center=None):
        """
        Export segments in simplified JSON format (easier to parse).
        
        Args:
            segments: List of segment dictionaries
            image_path: Path to the original image
            output_path: Path where to save the JSON file
            rotation_center: Optional dict with 'x' and 'y' keys for rotation axis
        
        Returns:
            Dict with export statistics
        """
        try:
            # Load image to get dimensions
            img = cv2.imread(image_path)
            if img is None:
                raise ValueError(f"Could not load image: {image_path}")
            
            height, width = img.shape[:2]
            
            # Create simple structure
            simple_data = {
                "version": "1.0",
                "image": {
                    "filename": Path(image_path).name,
                    "width": width,
                    "height": height
                },
                "rotation_center": rotation_center,
                "masks": []
            }
            
            # Process each segment
            for idx, segment in enumerate(segments):
                try:
                    mask = np.array(segment['mask'], dtype=np.uint8)
                    
                    if mask.max() == 0:
                        print(f"Warning: Empty mask for segment '{segment['name']}', skipping")
                        continue
                    
                    # Get bounding box
                    coords = np.argwhere(mask > 0)
                    if len(coords) == 0:
                        continue
                    
                    y_min, x_min = coords.min(axis=0)
                    y_max, x_max = coords.max(axis=0)
                    
                    # Convert mask to polygon
                    polygons = self._mask_to_polygons(mask)
                    
                    mask_data = {
                        "id": idx + 1,
                        "name": segment['name'],
                        "category": segment['category'],
                        "should_vectorize": segment.get('should_vectorize', True),
                        "bbox": {
                            "x_min": int(x_min),
                            "y_min": int(y_min),
                            "x_max": int(x_max),
                            "y_max": int(y_max)
                        },
                        "polygons": polygons,
                        "area": int(np.sum(mask > 0))
                    }
                    
                    simple_data["masks"].append(mask_data)
                    
                except Exception as e:
                    print(f"Error processing segment '{segment.get('name', 'unknown')}': {e}")
                    continue
            
            # Save to file
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(simple_data, f, indent=2, ensure_ascii=False)
            
            print(f"✓ Simple format exported: {output_path}")
            print(f"  - Masks: {len(simple_data['masks'])}")
            if rotation_center:
                print(f"  - Rotation center: ({rotation_center['x']}, {rotation_center['y']})")
            
            return {
                'success': True,
                'output_path': str(output_path),
                'masks': simple_data['masks']
            }
            
        except Exception as e:
            print(f"Error exporting simple format: {e}")
            import traceback
            traceback.print_exc()
            raise
    
    def export_training_dataset(self, segments, image_path, output_dir, format='coco', rotation_center=None):
        """
        Export complete training dataset (image + annotations).
        
        Args:
            segments: List of segment dictionaries
            image_path: Path to the original image
            output_dir: Directory where to save the dataset
            format: Export format ('coco' or 'simple')
            rotation_center: Optional dict with 'x' and 'y' keys
        
        Returns:
            Dict with paths to exported files
        """
        try:
            output_dir = Path(output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)
            
            # Copy image to output directory
            import shutil
            image_filename = Path(image_path).name
            output_image_path = output_dir / image_filename
            shutil.copy2(image_path, output_image_path)
            
            # Export annotations
            base_name = Path(image_path).stem
            
            if format == 'coco':
                annotations_path = output_dir / f'{base_name}_coco.json'
                self.export_coco_format(
                    segments=segments,
                    image_path=image_path,
                    output_path=str(annotations_path),
                    include_rle=False,
                    rotation_center=rotation_center
                )
            else:
                annotations_path = output_dir / f'{base_name}_masks.json'
                self.export_simple_format(
                    segments=segments,
                    image_path=image_path,
                    output_path=str(annotations_path),
                    rotation_center=rotation_center
                )
            
            print(f"✓ Training dataset exported to: {output_dir}")
            
            return {
                'success': True,
                'output_dir': str(output_dir),
                'image_path': str(output_image_path),
                'annotations_path': str(annotations_path)
            }
            
        except Exception as e:
            print(f"Error exporting training dataset: {e}")
            import traceback
            traceback.print_exc()
            raise
    
    def _mask_to_polygons(self, mask):
        """
        Convert binary mask to COCO polygon format.
        
        Args:
            mask: Binary mask as numpy array (H, W)
        
        Returns:
            List of polygons, each polygon is a flat list [x1,y1,x2,y2,...]
        """
        # Find contours
        contours, _ = cv2.findContours(
            mask.astype(np.uint8),
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )
        
        polygons = []
        for contour in contours:
            # Skip small contours (noise)
            if contour.shape[0] < 3:
                continue
            
            # Flatten contour to [x1, y1, x2, y2, ...] format
            contour = contour.flatten().tolist()
            
            # COCO format requires at least 6 coordinates (3 points)
            if len(contour) >= 6:
                polygons.append(contour)
        
        return polygons
    
    def _mask_to_rle(self, mask):
        """
        Convert binary mask to RLE (Run Length Encoding).
        
        Args:
            mask: Binary mask as numpy array (H, W)
        
        Returns:
            RLE encoded string
        """
        # Flatten mask in column-major order (Fortran style)
        pixels = mask.T.flatten()
        
        # Add a 0 at the beginning and end to handle edge cases
        pixels = np.concatenate([[0], pixels, [0]])
        
        # Find run starts and ends
        runs = np.where(pixels[1:] != pixels[:-1])[0] + 1
        runs[1::2] -= runs[::2]
        
        return ' '.join(str(x) for x in runs)
    
    def load_coco_annotations(self, json_path):
        """
        Load and parse COCO format annotations.
        
        Args:
            json_path: Path to COCO JSON file
        
        Returns:
            Dict with parsed data
        """
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                coco_data = json.load(f)
            
            # Extract rotation center if present
            rotation_center = coco_data.get('info', {}).get('rotation_center')
            
            return {
                'success': True,
                'coco_data': coco_data,
                'rotation_center': rotation_center,
                'num_images': len(coco_data.get('images', [])),
                'num_annotations': len(coco_data.get('annotations', [])),
                'num_categories': len(coco_data.get('categories', []))
            }
            
        except Exception as e:
            print(f"Error loading COCO annotations: {e}")
            import traceback
            traceback.print_exc()
            raise
