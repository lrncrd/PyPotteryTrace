"""
Vectorization Handler for PyPotteryTrace Interactive
Adapts the existing vectorization engine to work with segmented elements

Features:
- Extract and vectorize individual segmented regions
- Convert masks to vector paths
- Mirror profiles around rotation center
- Export organized SVG with categories
"""

import sys
import os
from pathlib import Path
import numpy as np
import cv2
import svgwrite
from rdp import rdp
from typing import List, Tuple, Dict, Any, Optional
import tempfile
import xml.etree.ElementTree as ET
import re

# Add parent directory to path to import existing modules
sys.path.append(str(Path(__file__).parent.parent))

# Import existing vectorization functions
from archaeological_vectorizer import (
    smooth_path_to_bezier,
    create_simple_path,
    calculate_path_length,
    vectorize_archaeological_drawing
)


def sanitize_svg_id(name: str) -> str:
    """
    Convert a name into a valid SVG ID.
    SVG IDs must start with a letter and contain only letters, digits, underscores, colons, periods, and hyphens.
    
    Args:
        name: Original name string
        
    Returns:
        Valid SVG ID string
    """
    # Replace spaces with underscores
    sanitized = name.replace(' ', '_')
    
    # Remove parentheses and other invalid characters (keep only word chars, colon, period, hyphen)
    sanitized = re.sub(r'[^\w:.-]', '', sanitized)
    
    # Ensure it starts with a letter (prepend 'id_' if it doesn't)
    if not sanitized or not sanitized[0].isalpha():
        sanitized = 'id_' + sanitized
    
    return sanitized



class VectorizationHandler:
    """Handler for vectorizing segmented elements."""
    
    # Element categories
    CATEGORIES = {
        'Profile': {
            'color': '#000000',
            'stroke_width': 1.5,
            'fill': 'none',
            'description': 'Vessel profile/outline'
        },
        'Profile_Mirrored': {
            'color': '#000000',
            'stroke_width': 1.5,
            'fill': 'none',
            'description': 'Mirrored profile (around rotation center)'
        },
        'Symmetry_Line': {
            'color': '#999999',
            'stroke_width': 0.5,
            'fill': 'none',
            'description': 'Symmetry line (vertical axis of rotation)'
        },
        'Diameter': {
            'color': '#666666',
            'stroke_width': 0.8,
            'fill': 'none',
            'description': 'Diameter line (horizontal)'
        },
        'Application': {
            'color': '#000000',
            'stroke_width': 1.2,
            'fill': 'none',
            'description': 'Applied elements (handles, spouts)'
        },
        'Handle': {
            'color': '#000000',
            'stroke_width': 1.0,
            'fill': 'none',
            'description': 'Handles and attachments'
        },
        'Prospectus': {
            'color': '#000000',
            'stroke_width': 1.0,
            'fill': 'none',
            'description': 'Front view/prospectus'
        },
        'Decoration': {
            'color': '#000000',
            'stroke_width': 0.5,
            'fill': 'black',
            'description': 'Painted decorations'
        },
        'Running_Element': {
            'color': '#000000',
            'stroke_width': 1.0,
            'fill': 'none',
            'description': 'Running element (mirrored, no construction lines)'
        },
        'Running_Element_Mirrored': {
            'color': '#000000',
            'stroke_width': 1.0,
            'fill': 'none',
            'description': 'Mirrored running element'
        },
        'Detail': {
            'color': '#000000',
            'stroke_width': 0.8,
            'fill': 'none',
            'description': 'Detail or annotation'
        }
    }
    
    def __init__(self):
        """Initialize vectorization handler."""
        pass
    
    def mask_to_contours(self, mask: np.ndarray) -> List[List[Tuple[int, int]]]:
        """
        Convert binary mask to contours for display.
        
        Args:
            mask: Binary mask (H, W)
            
        Returns:
            List of contours, each contour is a list of (x, y) points
        """
        # Ensure mask is uint8
        mask_uint8 = (mask * 255).astype(np.uint8) if mask.dtype != np.uint8 else mask
        
        # Find contours
        contours, _ = cv2.findContours(
            mask_uint8,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )
        
        # Convert to list of points
        contour_list = []
        for contour in contours:
            points = []
            for point in contour:
                x, y = point[0]
                points.append((int(x), int(y)))
            if len(points) >= 3:  # Only keep contours with at least 3 points
                contour_list.append(points)
        
        return contour_list
    
    def improve_mask(self, mask: np.ndarray, dilate_size: int = 5, close_size: int = 7, is_manual: bool = False) -> np.ndarray: #5
        """
        Improve mask quality with morphological operations.
        
        Args:
            mask: Binary mask (0/1 or 0/255)
            dilate_size: Size of dilation kernel (makes mask bigger, fills gaps)
            close_size: Size of closing kernel (removes small holes)
            is_manual: If True, skip dilation (for manually drawn masks)
            
        Returns:
            Improved binary mask (0/255)
        """
        # Ensure mask is uint8
        mask_uint8 = mask.astype(np.uint8) if mask.dtype != np.uint8 else mask
        
        # Check if mask is 0/1 or 0/255 format
        unique_vals = np.unique(mask_uint8)
        
        # Convert to 0/255 if needed
        if len(unique_vals) > 0 and unique_vals.max() <= 1:
            binary_mask = mask_uint8 * 255
        else:
            # Make binary (0 or 255) with threshold
            _, binary_mask = cv2.threshold(mask_uint8, 127, 255, cv2.THRESH_BINARY)
        
        # For manual masks, skip morphological operations to preserve exact shape
        if is_manual:
            print("  → Manual mask: skipping dilation/morphological operations")
            return binary_mask
        
        # Simple approach: closing + light dilation + smoothing
        
        # 1. Morphological closing to fill small holes (1 iteration)
        if close_size > 0:
            kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_size, close_size))
            binary_mask = cv2.morphologyEx(binary_mask, cv2.MORPH_CLOSE, kernel_close, iterations=1)
        
        # 2. Light dilation to expand edges slightly (1 iteration)
        if dilate_size > 0:
            kernel_dilate = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_size, dilate_size))
            binary_mask = cv2.dilate(binary_mask, kernel_dilate, iterations=1)
        
        # 3. Small erosion to smooth the edges
        kernel_smooth = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        binary_mask = cv2.erode(binary_mask, kernel_smooth, iterations=1)
        
        return binary_mask
    
    def polygon_to_mask(self, vertices: List[List[float]], width: int, height: int) -> np.ndarray:
        """
        Convert polygon vertices to binary mask.
        
        Args:
            vertices: List of [x, y] vertex coordinates
            width: Image width
            height: Image height
            
        Returns:
            Binary mask (0/255)
        """
        # Create empty mask
        mask = np.zeros((height, width), dtype=np.uint8)
        
        # Convert vertices to numpy array for cv2.fillPoly
        pts = np.array(vertices, dtype=np.int32).reshape((-1, 1, 2))
        
        # Fill polygon
        cv2.fillPoly(mask, [pts], 255)
        
        return mask
    
    def vectorize_from_png(
        self,
        png_path: str,
        category: str,
        name: str,
        epsilon: float = 1.5,
        smoothing_factor: float = 0.3,
        debug_svg_dir: Optional[str] = None  # NEW: save intermediate SVG for debugging
    ) -> Dict[str, Any]:
        """
        Vectorize from a saved PNG file (already masked, full-size, white background).
        
        This is the preferred method as it uses the exact same PNG that works in notebooks.
        The PNG should be:
        - Same dimensions as original image
        - Masked region visible
        - Everything else white (255, 255, 255)
        
        Args:
            png_path: Path to the saved PNG file
            category: Element category ('Profile', 'Decoration', etc.)
            name: Element name
            epsilon: RDP simplification parameter
            smoothing_factor: Bezier smoothing factor
            debug_svg_dir: Directory to save intermediate SVG files for debugging
            
        Returns:
            Dictionary with vectorized paths and metadata
        """
        # Create SVG output path (permanent if debug_svg_dir provided, temp otherwise)
        if debug_svg_dir:
            safe_name = name.replace(' ', '_').replace('/', '_')
            svg_output_path = Path(debug_svg_dir) / f"{category}_{safe_name}.svg"
            delete_svg = False
            print(f"  → SVG will be saved to: {svg_output_path}")
        else:
            with tempfile.NamedTemporaryFile(suffix='.svg', delete=False) as tmp_output:
                svg_output_path = tmp_output.name
            delete_svg = True
        
        try:
            # Use the complete vectorize_archaeological_drawing function
            # directly on the saved PNG (like in the notebook!)
            print(f"  → Vectorizing from PNG: {Path(png_path).name}")
            
            # Determine if we should use extract_profile_mode for Profile category
            is_profile_mode = (category == 'Profile' or category == 'Running_Element')
            if is_profile_mode:
                print(f"  → Using extract_profile_mode for {category} category")
            
            result = vectorize_archaeological_drawing(
                image_path=png_path,  # Use the saved PNG directly!
                output_svg_path=str(svg_output_path),
                epsilon=epsilon,
                smoothing_factor=smoothing_factor,
                lines_threshold=100,
                points_threshold=30,
                min_dotted_area=10,
                max_dotted_area=200,
                dotted_circularity=0.2,
                dark_threshold=100,
                min_decoration_area=20000,
                filter_branches=True,
                show_debug_plots=False,
                save_debug_images=False,
                include_background_image=False,
                extract_profile_mode=is_profile_mode  # Attiva modalità profilo per Profile
            )
            
            print(f"  → Vectorization complete: {result.get('total_paths_extracted', 0)} paths extracted")
            
            # Extract paths from SVG
            paths = self._extract_paths_from_svg(str(svg_output_path))
            
            print(f"  → Extracted {len(paths)} SVG paths")
            
            # Prepare return dictionary
            result_dict = {
                'name': name,
                'category': category,
                'paths': paths,
                'style': self.CATEGORIES.get(category, self.CATEGORIES['Detail']),
                'stats': {
                    'total_paths': len(paths),
                    'dotted_points': result.get('dotted_points_count', 0),
                    'decorations': result.get('decorations_count', 0)
                }
            }
            
            # Add profile_data if it exists (from extract_profile_mode)
            if 'profile_data' in result:
                result_dict['stats']['profile_data'] = result['profile_data']
            
            return result_dict
            
        finally:
            # Clean up temporary SVG file only if not in debug mode
            if delete_svg and os.path.exists(str(svg_output_path)):
                os.unlink(str(svg_output_path))
    
    def vectorize_from_vertices(
        self,
        vertices: List[List[float]],
        category: str,
        name: str,
        width: int,
        height: int,
        epsilon: float = 1.5,
        smoothing_factor: float = 0.3,
        debug_svg_dir: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Vectorize directly from polygon vertices (for manual masks).
        
        This creates an SVG path directly from the user-defined vertices,
        without going through rasterization. The vertices ARE the final contour.
        
        For Profile category, it also returns profile_data with outer_contour
        (only external side) so that mirroring logic can be applied correctly.
        
        Args:
            vertices: List of [x, y] coordinates defining the polygon
            category: Element category ('Profile', 'Decoration', etc.)
            name: Element name
            width: Image width
            height: Image height
            epsilon: RDP simplification (not used, vertices already simplified)
            smoothing_factor: Bezier smoothing factor for smooth curves
            debug_svg_dir: Directory to save SVG for debugging
            
        Returns:
            Dictionary with vectorized paths and metadata
        """
        import numpy as np
        from archaeological_vectorizer import extract_left_side_of_profile, smooth_path_to_bezier
        
        # Convert vertices to numpy array in [y, x] format (row, col) for smooth_path_to_bezier
        # smooth_path_to_bezier expects format: [(y1,x1), (y2,x2), ...]
        vertices_yx = np.array([[v[1], v[0]] for v in vertices], dtype=np.float32)
        
        # Create smooth Bezier path from vertices (same as automatic pipeline)
        if smoothing_factor > 0 and len(vertices_yx) >= 3:
            path_d = smooth_path_to_bezier(vertices_yx, smoothing_factor)
            # Add Z to close the path
            if path_d and not path_d.strip().endswith('Z'):
                path_d += " Z"
            print(f"  → Created smooth Bezier path with smoothing_factor={smoothing_factor}")
        else:
            # Fallback to simple lines if smoothing disabled or too few vertices
            path_parts = []
            for i, v in enumerate(vertices):
                if i == 0:
                    path_parts.append(f"M {v[0]:.2f} {v[1]:.2f}")
                else:
                    path_parts.append(f"L {v[0]:.2f} {v[1]:.2f}")
            path_parts.append("Z")  # Close path
            path_d = " ".join(path_parts)
        
        # Convert vertices to numpy array in [y, x] format for profile logic
        full_profile = np.array([[v[1], v[0]] for v in vertices], dtype=np.int32)
        
        # Create SVG file if debug_svg_dir provided
        svg_file = None
        if debug_svg_dir:
            safe_name = name.replace(' ', '_').replace('/', '_')
            svg_file = str(Path(debug_svg_dir) / f"{category}_{safe_name}.svg")
            
            # Create simple SVG with just the path
            dwg = svgwrite.Drawing(
                svg_file,
                size=(f'{width}px', f'{height}px'),
                viewBox=f'0 0 {width} {height}',
                profile='full'
            )
            style = self.CATEGORIES.get(category, self.CATEGORIES['Detail'])
            dwg.add(dwg.path(
                d=path_d,
                stroke=style.get('color', '#000000'),
                stroke_width=style.get('stroke_width', 1.0),
                fill=style.get('fill', 'none')
            ))
            dwg.save()
            print(f"  → Manual SVG saved to: {svg_file}")
        
        # Prepare result dictionary
        result_dict = {
            'name': name,
            'category': category,
            'paths': [path_d],  # Single path with all vertices
            'style': self.CATEGORIES.get(category, self.CATEGORIES['Detail']),
            'svg_file': svg_file,
            'is_manual': True,
            'stats': {
                'total_paths': 1,
                'vertex_count': len(vertices)
            }
        }
        
        # For Profile and Running_Element, extract ONLY external contour for mirroring
        if category in ['Profile', 'Running_Element']:
            # Extract only the left/external side for mirroring
            # This is what the automatic pipeline does
            try:
                outer_contour = extract_left_side_of_profile(full_profile, vertical_confidence=30)
                print(f"  → Extracted external contour: {len(full_profile)} → {len(outer_contour)} points")
            except Exception as e:
                print(f"  ⚠ Error extracting external contour: {e}, using full profile")
                outer_contour = full_profile
            
            result_dict['stats']['profile_data'] = {
                'full_closed_profile': full_profile,  # Complete polygon (for the main drawing)
                'outer_contour': outer_contour,       # Only external side (for mirroring)
                'is_manual': True
            }
            print(f"  → Added profile_data: full={len(full_profile)}, outer={len(outer_contour)} points")
        
        return result_dict
    
    def vectorize_segment(
        self,
        image_path: str,
        mask: List[List[int]],  # Mask from frontend
        category: str,
        name: str,
        epsilon: float = 1.5,
        smoothing_factor: float = 0.3,
        use_skeletonization: bool = True,
        return_components: bool = False,  # NEW: return classified components instead of SVG paths
        debug_output_dir: Optional[str] = None  # NEW: directory to save intermediate PNG
    ) -> Dict[str, Any]:
        """
        Vectorize a single segmented element using the archaeological vectorization algorithm.
        
        Process:
        1. SAM2 generates binary mask
        2. Apply mask to FULL original image (non-masked pixels = white)
        3. Apply archaeological_vectorizer algorithm
        4. SVG coordinates are already correct (no translation needed!)
        
        Args:
            image_path: Path to original image
            mask: Binary mask as 2D list from SAM2
            category: Element category ('Profile', 'Decoration', etc.)
            name: Element name
            epsilon: RDP simplification parameter
            smoothing_factor: Bezier smoothing factor
            use_skeletonization: Whether to use skeletonization (for lines)
            return_components: If True, return classified components (lines, points, decorations) 
                             instead of just SVG paths
            
        Returns:
            Dictionary with vectorized paths and metadata
        """
        # Convert mask from list to numpy array
        mask_array = np.array(mask, dtype=np.uint8)
        
        # Improve mask quality with morphological operations
        print(f"Improving mask quality for {category} '{name}'...")
        mask_array = self.improve_mask(
            mask_array,
            dilate_size=10,   # Moderato: 10 pixel di espansione
            close_size=10     # Riempie buchi di 10x10 pixel
        )
        
        # Load original image (FULL SIZE)
        image = cv2.imread(image_path)
        if image is None:
            raise ValueError(f"Could not load image: {image_path}")
        
        # Create masked image: keep masked region, set rest to white
        # This is the FULL original image with only the masked area visible
        masked_image = image.copy()
        masked_image[mask_array == 0] = 255  # Non-masked pixels = white
        
        print(f"Processing full image: {masked_image.shape[1]}x{masked_image.shape[0]} pixels")
        
        # Save masked image to temporary file (FULL SIZE!)
        # Also save to debug directory if provided
        if debug_output_dir:
            safe_name = name.replace(' ', '_').replace('/', '_')
            debug_png_path = Path(debug_output_dir) / f"vectorize_{category}_{safe_name}.png"
            cv2.imwrite(str(debug_png_path), masked_image)
            print(f"  → Debug PNG saved: {debug_png_path}")
        
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp_input:
            tmp_input_path = tmp_input.name
            cv2.imwrite(tmp_input_path, masked_image)
        
        # Create temporary output SVG path
        with tempfile.NamedTemporaryFile(suffix='.svg', delete=False) as tmp_output:
            tmp_output_path = tmp_output.name
        
        try:
            # Use the complete vectorize_archaeological_drawing function
            # with optimized parameters on FULL SIZE IMAGE
            print(f"Vectorizing {category} '{name}' using archaeological algorithm...")
            
            result = vectorize_archaeological_drawing(
                image_path=tmp_input_path,
                output_svg_path=tmp_output_path,
                epsilon=epsilon,
                smoothing_factor=smoothing_factor,
                lines_threshold=25,  # High to get clean lines
                points_threshold=30,
                min_dotted_area=10,
                max_dotted_area=200,
                dotted_circularity=0.2,
                dark_threshold=100, #100
                min_decoration_area=20000000,
                filter_branches=True,
                show_debug_plots=False,
                save_debug_images=False,
                include_background_image=False
            )
            
            print(f"  ✓ Vectorization complete: {result.get('total_paths_extracted', 0)} paths extracted")
            
            # Extract paths from SVG - NO TRANSLATION NEEDED!
            # Coordinates are already in original image space
            paths = self._extract_paths_from_svg(tmp_output_path)
            
            print(f"  ✓ Extracted {len(paths)} SVG paths (coordinates already correct!)")
            
            return {
                'name': name,
                'category': category,
                'paths': paths,
                'style': self.CATEGORIES.get(category, self.CATEGORIES['Detail']),
                'stats': {
                    'total_paths': len(paths),
                    'dotted_points': result.get('dotted_points_count', 0),
                    'decorations': result.get('decorations_count', 0)
                }
            }
            
        finally:
            # Clean up temporary files
            if os.path.exists(tmp_input_path):
                os.unlink(tmp_input_path)
            if os.path.exists(tmp_output_path):
                os.unlink(tmp_output_path)
    
    def _extract_paths_from_svg(self, svg_path: str) -> List[str]:
        """
        Extract path data from generated SVG file.
        
        Args:
            svg_path: Path to SVG file
            
        Returns:
            List of SVG path strings
        """
        paths = []
        
        try:
            tree = ET.parse(svg_path)
            root = tree.getroot()
            
            # Handle SVG namespace
            ns = {'svg': 'http://www.w3.org/2000/svg'}
            
            # Find all path elements
            for path_elem in root.findall('.//svg:path', ns):
                path_data = path_elem.get('d', '')
                if path_data:
                    # Fix path data: ensure spaces between numbers
                    path_data = self._fix_path_spacing(path_data)
                    print(f"DEBUG _extract_paths_from_svg: {path_data[:100]}")
                    paths.append(path_data)
            
            # Also check without namespace (in case SVG doesn't use it)
            if not paths:
                for path_elem in root.findall('.//path'):
                    path_data = path_elem.get('d', '')
                    if path_data:
                        path_data = self._fix_path_spacing(path_data)
                        print(f"DEBUG _extract_paths_from_svg (no ns): {path_data[:100]}")
                        paths.append(path_data)
                        
        except Exception as e:
            print(f"Error extracting paths from SVG: {e}")
            
        return paths
    
    def _translate_svg_path(self, path_data: str, offset_x: int, offset_y: int) -> str:
        """
        Translate SVG path coordinates by adding offset.
        
        Args:
            path_data: Original SVG path string
            offset_x: X offset to add to all coordinates
            offset_y: Y offset to add to all coordinates
            
        Returns:
            Translated SVG path string
        """
        import re
        
        def translate_number(match):
            """Helper to translate individual numbers in path."""
            return match.group(0)  # We'll handle coordinates in pairs
        
        # Split path into tokens (commands and numbers)
        tokens = re.findall(r'[a-zA-Z]|[-+]?[0-9]*\.?[0-9]+', path_data)
        
        translated_tokens = []
        i = 0
        current_command = None
        
        while i < len(tokens):
            token = tokens[i]
            
            # Check if it's a command letter
            if re.match(r'[a-zA-Z]', token):
                current_command = token
                translated_tokens.append(token)
                i += 1
            else:
                # It's a number - handle based on command
                if current_command in ['M', 'L', 'T']:
                    # Absolute coordinates (x, y)
                    x = float(tokens[i]) + offset_x
                    y = float(tokens[i + 1]) + offset_y
                    translated_tokens.append(f'{x:.2f}')
                    translated_tokens.append(f'{y:.2f}')
                    i += 2
                elif current_command == 'C':
                    # Cubic bezier: x1 y1 x2 y2 x y
                    for _ in range(3):  # 3 coordinate pairs
                        x = float(tokens[i]) + offset_x
                        y = float(tokens[i + 1]) + offset_y
                        translated_tokens.append(f'{x:.2f}')
                        translated_tokens.append(f'{y:.2f}')
                        i += 2
                elif current_command == 'S':
                    # Smooth cubic bezier: x2 y2 x y
                    for _ in range(2):  # 2 coordinate pairs
                        x = float(tokens[i]) + offset_x
                        y = float(tokens[i + 1]) + offset_y
                        translated_tokens.append(f'{x:.2f}')
                        translated_tokens.append(f'{y:.2f}')
                        i += 2
                elif current_command == 'Q':
                    # Quadratic bezier: x1 y1 x y
                    for _ in range(2):  # 2 coordinate pairs
                        x = float(tokens[i]) + offset_x
                        y = float(tokens[i + 1]) + offset_y
                        translated_tokens.append(f'{x:.2f}')
                        translated_tokens.append(f'{y:.2f}')
                        i += 2
                elif current_command in ['H']:
                    # Horizontal line: x only
                    x = float(tokens[i]) + offset_x
                    translated_tokens.append(f'{x:.2f}')
                    i += 1
                elif current_command in ['V']:
                    # Vertical line: y only
                    y = float(tokens[i]) + offset_y
                    translated_tokens.append(f'{y:.2f}')
                    i += 1
                elif current_command in ['m', 'l', 't', 'c', 's', 'q', 'h', 'v']:
                    # Relative commands - don't translate
                    translated_tokens.append(tokens[i])
                    i += 1
                elif current_command == 'Z':
                    # Close path - no coordinates
                    i += 1
                else:
                    # Unknown command - keep as is
                    translated_tokens.append(tokens[i])
                    i += 1
        
        # Join tokens back into path string
        return ' '.join(translated_tokens)
    
    def _fix_path_spacing(self, path_data: str) -> str:
        """
        Fix SVG path spacing to ensure proper format.
        Adds spaces between coordinates if they're missing.
        
        Args:
            path_data: Original path data string
            
        Returns:
            Fixed path data string
        """
        import re
        
        # Replace comma-separated coordinates with space-separated ones
        # and ensure space after commands
        # Pattern: number followed immediately by another number (no space/comma)
        # Example: 1832.46142.00 -> 1832.46 142.00
        
        # First, replace commas with spaces
        path_data = path_data.replace(',', ' ')
        
        # Then add space between a decimal point followed by a digit and another number
        # Pattern: digit.digit followed immediately by digit (no space)
        # Example: 142.00208 -> 142.00 208
        path_data = re.sub(r'(\d)(\-?\d+\.?\d*)', r'\1 \2', path_data)
        
        # Clean up multiple spaces
        path_data = re.sub(r'\s+', ' ', path_data)
        
        # Ensure space after command letters
        path_data = re.sub(r'([MLCSQTAZ])(\-?\d)', r'\1 \2', path_data, flags=re.IGNORECASE)
        
        return path_data.strip()
    
    def components_to_json(self, components: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert classified components to JSON-serializable format.
        
        Args:
            components: Dictionary with classified components (lines, dotted_points, painted_decorations)
            
        Returns:
            JSON-serializable dictionary
        """
        import cv2
        from archaeological_vectorizer import calculate_path_length
        
        json_data = {
            'lines': [],
            'dotted_points': [],
            'painted_decorations': []
        }
        
        # Convert lines (list of numpy arrays)
        for i, line_path in enumerate(components.get('lines', [])):
            if isinstance(line_path, np.ndarray):
                json_data['lines'].append({
                    'id': i,
                    'points': line_path.tolist(),  # Convert numpy array to list
                    'length': float(calculate_path_length(line_path))
                })
        
        # Convert dotted points (list of tuples (center_y, center_x, radius))
        for i, point_data in enumerate(components.get('dotted_points', [])):
            if len(point_data) == 3:
                center_y, center_x, radius = point_data
                json_data['dotted_points'].append({
                    'id': i,
                    'x': int(center_x),
                    'y': int(center_y),
                    'radius': int(radius)
                })
        
        # Convert painted decorations (list of contour arrays)
        for i, contour in enumerate(components.get('painted_decorations', [])):
            if isinstance(contour, np.ndarray):
                # Contour is numpy array with shape (N, 1, 2) from cv2.findContours
                # or (N, 2) from our processing
                if len(contour.shape) == 3:
                    # cv2 format: (N, 1, 2)
                    points = contour.reshape(-1, 2).tolist()
                else:
                    # Our format: (N, 2)
                    points = contour.tolist()
                
                # Calculate area
                area = cv2.contourArea(contour)
                
                json_data['painted_decorations'].append({
                    'id': i,
                    'points': points,
                    'area': float(area)
                })
        
        return json_data
    
    def filtered_components_to_svg(
        self,
        filtered_components: Dict[str, List],
        output_path: str,
        width: int,
        height: int,
        epsilon: float = 1.5,
        smoothing_factor: float = 0.3,
        include_background: bool = False,
        background_image: Optional[str] = None
    ):
        """
        Export filtered components to SVG.
        
        Args:
            filtered_components: Filtered components from frontend {lines: [], dottedPoints: [], decorations: []}
            output_path: Path to save SVG
            width: SVG width in pixels
            height: SVG height in pixels
            epsilon: RDP simplification parameter
            smoothing_factor: Bezier smoothing factor
            include_background: Whether to include background image
            background_image: Path to background image
        """
        import base64
        from archaeological_vectorizer import smooth_path_to_bezier, create_simple_path
        
        # Create SVG
        dwg = svgwrite.Drawing(output_path, size=(f'{width}px', f'{height}px'), profile='full')
        
        # Add background if requested
        if include_background and background_image:
            with open(background_image, 'rb') as img_file:
                img_data = base64.b64encode(img_file.read()).decode('utf-8')
                img_format = 'jpeg' if background_image.lower().endswith(('.jpg', '.jpeg')) else 'png'
                
                dwg.add(dwg.image(
                    href=f'data:image/{img_format};base64,{img_data}',
                    insert=(0, 0),
                    size=(f'{width}px', f'{height}px'),
                    opacity=0.3
                ))
        
        # Create group for lines
        lines_group = dwg.g(id='lines', stroke='black', stroke_width=1.5, fill='none')
        for line in filtered_components.get('lines', []):
            if 'points' in line and len(line['points']) > 1:
                # Convert points to numpy array for processing
                points_array = np.array(line['points'])
                
                # Apply RDP simplification
                from rdp import rdp
                simplified = rdp(points_array, epsilon=epsilon)
                
                if len(simplified) >= 2:
                    # Create SVG path with smoothing
                    if smoothing_factor > 0:
                        path_data = smooth_path_to_bezier(simplified, smoothing_factor)
                    else:
                        path_data = create_simple_path(simplified)
                    
                    lines_group.add(dwg.path(d=path_data))
        dwg.add(lines_group)
        
        # Create group for dotted points
        points_group = dwg.g(id='dotted_points', fill='red', stroke='none')
        for point in filtered_components.get('dottedPoints', []):
            if 'x' in point and 'y' in point and 'radius' in point:
                points_group.add(dwg.circle(
                    center=(point['x'], point['y']),
                    r=point['radius']
                ))
        dwg.add(points_group)
        
        # Create group for decorations
        decorations_group = dwg.g(id='painted_decorations', stroke='black', stroke_width=1, fill='black')
        for decoration in filtered_components.get('decorations', []):
            if 'points' in decoration and len(decoration['points']) > 2:
                # Convert points to numpy array
                points_array = np.array(decoration['points'])
                
                # Apply light simplification
                from rdp import rdp
                simplified = rdp(points_array, epsilon=epsilon * 0.5)
                
                if len(simplified) >= 3:
                    # Create closed path
                    if smoothing_factor > 0:
                        path_data = smooth_path_to_bezier(simplified, smoothing_factor * 0.3)
                    else:
                        path_data = create_simple_path(simplified)
                    
                    path_data += " Z"  # Close the path
                    decorations_group.add(dwg.path(d=path_data))
        dwg.add(decorations_group)
        
        # Save
        dwg.save()
        print(f"SVG exported to {output_path}")


    
    def _vectorize_outline(
        self,
        mask: np.ndarray,
        epsilon: float,
        smoothing_factor: float
    ) -> List[str]:
        """
        Vectorize as outline (for profiles, sections).
        
        Args:
            mask: Binary mask
            epsilon: RDP simplification
            smoothing_factor: Bezier smoothing
            
        Returns:
            List of SVG path strings
        """
        # Find contours
        contours, _ = cv2.findContours(
            mask,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_NONE  # Get all points for better vectorization
        )
        
        svg_paths = []
        
        for contour in contours:
            # Skip very small contours
            if len(contour) < 10:
                continue
            
            # Convert to points array (y, x) format for compatibility
            points = np.array([[p[0][1], p[0][0]] for p in contour])
            
            # Apply RDP simplification
            simplified = rdp(points, epsilon=epsilon)
            
            if len(simplified) < 3:
                continue
            
            # Create SVG path with smoothing
            if smoothing_factor > 0:
                path_data = smooth_path_to_bezier(simplified, smoothing_factor)
            else:
                path_data = create_simple_path(simplified)
            
            svg_paths.append(path_data)
        
        return svg_paths
    
    def _vectorize_filled_region(
        self,
        mask: np.ndarray,
        epsilon: float,
        smoothing_factor: float
    ) -> List[str]:
        """
        Vectorize as filled region (for decorations).
        
        Args:
            mask: Binary mask
            epsilon: RDP simplification
            smoothing_factor: Bezier smoothing
            
        Returns:
            List of SVG path strings
        """
        # Find contours
        contours, _ = cv2.findContours(
            mask,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )
        
        svg_paths = []
        
        for contour in contours:
            if len(contour) < 5:
                continue
            
            # Convert to points array (y, x) format
            points = np.array([[p[0][1], p[0][0]] for p in contour])
            
            # Apply light simplification to preserve shape
            simplified = rdp(points, epsilon=epsilon * 0.5)
            
            if len(simplified) < 3:
                continue
            
            # Create closed path
            if smoothing_factor > 0:
                path_data = smooth_path_to_bezier(simplified, smoothing_factor * 0.3)
            else:
                path_data = create_simple_path(simplified)
            
            # Close the path
            path_data += " Z"
            
            svg_paths.append(path_data)
        
        return svg_paths
    
    def create_mirrored_profile_svg(
        self,
        profile_path: np.ndarray,
        center_x: int,
        output_path: str,
        width: int,
        height: int,
        epsilon: float = 1.5,
        smoothing_factor: float = 0.3
    ):
        """
        Create SVG with mirrored profile around rotation center.
        
        Args:
            profile_path: Profile contour as numpy array (y, x)
            center_x: X coordinate of rotation center
            output_path: Path to save SVG
            width: SVG width
            height: SVG height
            epsilon: RDP simplification
            smoothing_factor: Bezier smoothing
        """
        from archaeological_vectorizer import smooth_path_to_bezier, create_simple_path
        
        # Mirror the profile path around center_x
        mirrored_path = profile_path.copy()
        mirrored_path[:, 1] = 2 * center_x - profile_path[:, 1]  # Mirror x coordinates
        
        # Create SVG
        dwg = svgwrite.Drawing(output_path, size=(f'{width}px', f'{height}px'), profile='full')
        
        # Create group for mirrored profile
        mirror_group = dwg.g(id='mirrored_profile', stroke='black', stroke_width=1.5, fill='none')
        
        # Apply RDP simplification
        simplified = rdp(mirrored_path, epsilon=epsilon)
        
        if len(simplified) >= 2:
            # Create SVG path with smoothing
            if smoothing_factor > 0:
                path_data = smooth_path_to_bezier(simplified, smoothing_factor)
            else:
                path_data = create_simple_path(simplified)
            
            mirror_group.add(dwg.path(d=path_data))
        
        dwg.add(mirror_group)
        dwg.save()
        
        print(f"✓ Mirrored profile SVG saved: {output_path}")
    
    def create_outer_contour_svg(
        self,
        profile_path: np.ndarray,
        output_path: str,
        width: int,
        height: int,
        epsilon: float = 1.5,
        smoothing_factor: float = 0.3,
        layer_id: str = 'outer_contour',
        stroke_color: str = '#000000',
        stroke_width: float = 1.0
    ):
        """
        Create SVG with outer contour only (open path, not mirrored).
        Used for Running_Element category.
        
        Args:
            profile_path: Profile contour as numpy array (y, x)
            output_path: Path to save SVG
            width: SVG width
            height: SVG height
            epsilon: RDP simplification
            smoothing_factor: Bezier smoothing
            layer_id: SVG group ID
            stroke_color: Stroke color
            stroke_width: Stroke width
        """
        from archaeological_vectorizer import smooth_path_to_bezier, create_simple_path
        
        # Create SVG
        dwg = svgwrite.Drawing(output_path, size=(f'{width}px', f'{height}px'), profile='full')
        
        # Create group for outer contour
        contour_group = dwg.g(id=layer_id, stroke=stroke_color, stroke_width=stroke_width, fill='none')
        
        # Apply RDP simplification
        simplified = rdp(profile_path, epsilon=epsilon)
        
        if len(simplified) >= 2:
            # Create SVG path with smoothing (OPEN path - no Z command)
            if smoothing_factor > 0:
                path_data = smooth_path_to_bezier(simplified, smoothing_factor)
            else:
                path_data = create_simple_path(simplified)
            
            contour_group.add(dwg.path(d=path_data))
        
        dwg.add(contour_group)
        dwg.save()
        
        print(f"✓ Outer contour SVG saved: {output_path}")
    
    def create_symmetry_line_svg(
        self,
        center_x: int,
        y_top: int,
        y_bottom: int,
        output_path: str,
        width: int,
        height: int
    ):
        """
        Create SVG with symmetry line (vertical axis of rotation).
        
        Args:
            center_x: X coordinate of rotation center (vertical line)
            y_top: Y coordinate of top point
            y_bottom: Y coordinate of bottom point
            output_path: Path to save SVG
            width: SVG width
            height: SVG height
        """
        # Create SVG
        dwg = svgwrite.Drawing(output_path, size=(f'{width}px', f'{height}px'), profile='full')
        
        # Create group for symmetry line (vertical)
        symmetry_group = dwg.g(id='symmetry_line', stroke='#999999', stroke_width=0.5, fill='none')
        
        # Draw vertical line as PATH (not <line>) so it can be extracted by _extract_paths_from_svg
        path_data = f"M {center_x},{y_top} L {center_x},{y_bottom}"
        symmetry_group.add(dwg.path(d=path_data))
        
        dwg.add(symmetry_group)
        dwg.save()
        
        print(f"✓ Symmetry line SVG saved: {output_path}")
    
    def create_diameter_line_svg(
        self,
        center_x: int,
        center_y: int,
        x_left: int,
        x_right: int,
        output_path: str,
        width: int,
        height: int
    ):
        """
        Create SVG with diameter line (horizontal line at center_y).
        
        Args:
            center_x: X coordinate of rotation center
            center_y: Y coordinate where to draw horizontal line
            x_left: Left X coordinate (start of line)
            x_right: Right X coordinate (end of line)
            output_path: Path to save SVG
            width: SVG width
            height: SVG height
        """
        # Create SVG
        dwg = svgwrite.Drawing(output_path, size=(f'{width}px', f'{height}px'), profile='full')
        
        # Create group for diameter line (horizontal)
        diameter_group = dwg.g(id='diameter_line', stroke='#666666', stroke_width=0.8, fill='none')
        
        # Draw horizontal line as PATH (not <line>) so it can be extracted by _extract_paths_from_svg
        path_data = f"M {x_left},{center_y} L {x_right},{center_y}"
        diameter_group.add(dwg.path(d=path_data))
        
        dwg.add(diameter_group)
        dwg.save()
        
        print(f"✓ Diameter line SVG saved: {output_path}")
    
    def merge_profile_with_running_element(
        self,
        profile_mirrored_path: np.ndarray,
        running_element_mirrored_path: np.ndarray,
        output_path: str,
        width: int,
        height: int,
        epsilon: float = 1.5,
        smoothing_factor: float = 0.3,
        proximity_threshold: float = 50.0
    ):
        """
        Merge Profile_Mirrored with Running_Element_Mirrored by removing overlapping sections.
        
        Strategy:
        1. Find closest points between the two paths
        2. Cut Profile_Mirrored at the intersection region
        3. Connect the remaining Profile_Mirrored segments with Running_Element_Mirrored
        
        Args:
            profile_mirrored_path: Profile contour as numpy array (y, x)
            running_element_mirrored_path: Running element contour as numpy array (y, x)
            output_path: Path to save merged SVG
            width: SVG width
            height: SVG height
            epsilon: RDP simplification
            smoothing_factor: Bezier smoothing
            proximity_threshold: Distance threshold to consider points "close"
        """
        from archaeological_vectorizer import smooth_path_to_bezier, create_simple_path
        from scipy.spatial import distance_matrix
        
        print(f"\n{'='*60}")
        print(f"Merging Profile_Mirrored with Running_Element_Mirrored")
        print(f"Profile points: {len(profile_mirrored_path)}")
        print(f"Running element points: {len(running_element_mirrored_path)}")
        print(f"Proximity threshold: {proximity_threshold}px")
        print(f"{'='*60}\n")
        
        # Calculate distance matrix between all points
        distances = distance_matrix(profile_mirrored_path, running_element_mirrored_path)
        
        # Find points where distance is below threshold
        close_points = np.where(distances < proximity_threshold)
        
        if len(close_points[0]) == 0:
            print("⚠️ No close points found - keeping Profile_Mirrored unchanged")
            # Just save the original profile_mirrored
            self.create_outer_contour_svg(
                profile_mirrored_path, output_path, width, height, 
                epsilon, smoothing_factor, 'merged_profile', '#000000', 1.5
            )
            return
        
        # Find the START and END indices in profile where it's close to running element
        profile_close_indices = close_points[0]
        cut_start = np.min(profile_close_indices)
        cut_end = np.max(profile_close_indices)
        
        print(f"  Found {len(profile_close_indices)} close points")
        print(f"  Profile cut region: indices {cut_start} to {cut_end}")
        
        # Split Profile_Mirrored into segments
        # Keep: [0:cut_start] and [cut_end:end]
        # Remove: [cut_start:cut_end] (the part close to running element)
        
        if cut_start > 0 and cut_end < len(profile_mirrored_path) - 1:
            # Profile is cut in the middle - keep both ends
            segment_before = profile_mirrored_path[:cut_start]
            segment_after = profile_mirrored_path[cut_end:]
            
            print(f"  Profile segment BEFORE: {len(segment_before)} points")
            print(f"  Profile segment AFTER: {len(segment_after)} points")
            
            # Merged path: segment_before + running_element + segment_after
            merged_path = np.vstack([segment_before, running_element_mirrored_path, segment_after])
            
        elif cut_start == 0:
            # Cut at the beginning - keep only the end
            segment_after = profile_mirrored_path[cut_end:]
            print(f"  Profile cut at START - keeping end segment: {len(segment_after)} points")
            merged_path = np.vstack([running_element_mirrored_path, segment_after])
            
        elif cut_end == len(profile_mirrored_path) - 1:
            # Cut at the end - keep only the beginning
            segment_before = profile_mirrored_path[:cut_start]
            print(f"  Profile cut at END - keeping start segment: {len(segment_before)} points")
            merged_path = np.vstack([segment_before, running_element_mirrored_path])
            
        else:
            # Shouldn't happen, but fallback
            print("  ⚠️ Unexpected cut configuration - using full running element")
            merged_path = running_element_mirrored_path
        
        print(f"  ✓ Merged path: {len(merged_path)} total points\n")
        
        # Create SVG with merged path
        dwg = svgwrite.Drawing(output_path, size=(f'{width}px', f'{height}px'), profile='full')
        merged_group = dwg.g(id='merged_profile', stroke='#000000', stroke_width=1.5, fill='none')
        
        # Apply RDP simplification
        simplified = rdp(merged_path, epsilon=epsilon)
        
        if len(simplified) >= 2:
            # Create SVG path with smoothing
            if smoothing_factor > 0:
                path_data = smooth_path_to_bezier(simplified, smoothing_factor)
            else:
                path_data = create_simple_path(simplified)
            
            merged_group.add(dwg.path(d=path_data))
        
        dwg.add(merged_group)
        dwg.save()
        
        print(f"✓ Merged profile SVG saved: {output_path}")
    
    def extend_running_element_to_profile(
        self,
        running_element_path: np.ndarray,
        profile_path: np.ndarray,
        output_path: str,
        width: int,
        height: int,
        epsilon: float = 1.5,
        smoothing_factor: float = 0.3,
        layer_id: str = 'running_element_extended',
        stroke_color: str = '#000000',
        stroke_width: float = 1.0
    ):
        """
        Extend the endpoints of Running_Element to touch the Profile.
        
        Args:
            running_element_path: Running element contour as numpy array (y, x)
            profile_path: Profile contour as numpy array (y, x)
            output_path: Path to save extended SVG
            width: SVG width
            height: SVG height
            epsilon: RDP simplification
            smoothing_factor: Bezier smoothing
            layer_id: SVG group ID
            stroke_color: Stroke color
            stroke_width: Stroke width
        """
        from archaeological_vectorizer import smooth_path_to_bezier, create_simple_path
        from scipy.spatial import distance_matrix
        
        print(f"\n{'='*60}")
        print(f"Extending Running_Element endpoints to touch Profile")
        print(f"Running element points: {len(running_element_path)}")
        print(f"Profile points: {len(profile_path)}")
        print(f"{'='*60}\n")
        
        # Get the two endpoints of running element (first and last points)
        start_point = running_element_path[0]
        end_point = running_element_path[-1]
        
        print(f"  Running element START: y={start_point[0]:.1f}, x={start_point[1]:.1f}")
        print(f"  Running element END: y={end_point[0]:.1f}, x={end_point[1]:.1f}")
        
        # Find closest points on profile to each endpoint
        distances_to_start = np.sqrt(np.sum((profile_path - start_point)**2, axis=1))
        distances_to_end = np.sqrt(np.sum((profile_path - end_point)**2, axis=1))
        
        closest_to_start_idx = np.argmin(distances_to_start)
        closest_to_end_idx = np.argmin(distances_to_end)
        
        closest_to_start = profile_path[closest_to_start_idx]
        closest_to_end = profile_path[closest_to_end_idx]
        
        dist_start = distances_to_start[closest_to_start_idx]
        dist_end = distances_to_end[closest_to_end_idx]
        
        print(f"\n  Closest profile point to START: y={closest_to_start[0]:.1f}, x={closest_to_start[1]:.1f} (dist={dist_start:.1f}px)")
        print(f"  Closest profile point to END: y={closest_to_end[0]:.1f}, x={closest_to_end[1]:.1f} (dist={dist_end:.1f}px)")
        
        # Create extended path: [profile_start] + [running_element] + [profile_end]
        extended_path = np.vstack([
            [closest_to_start],  # Add connection to profile at start
            running_element_path,  # Original running element
            [closest_to_end]  # Add connection to profile at end
        ])
        
        print(f"\n  ✓ Extended path: {len(extended_path)} points (added 2 connection points)\n")
        
        # Create SVG
        dwg = svgwrite.Drawing(output_path, size=(f'{width}px', f'{height}px'), profile='full')
        contour_group = dwg.g(id=layer_id, stroke=stroke_color, stroke_width=stroke_width, fill='none')
        
        # Apply RDP simplification
        simplified = rdp(extended_path, epsilon=epsilon)
        
        if len(simplified) >= 2:
            # Create SVG path with smoothing (OPEN path)
            if smoothing_factor > 0:
                path_data = smooth_path_to_bezier(simplified, smoothing_factor)
            else:
                path_data = create_simple_path(simplified)
            
            contour_group.add(dwg.path(d=path_data))
        
        dwg.add(contour_group)
        dwg.save()
        
        print(f"✓ Extended Running_Element SVG saved: {output_path}")
    
    def mirror_profile(
        self,
        vectors: Dict[str, Any],
        center_x: int
    ) -> Dict[str, Any]:
        """
        Mirror a profile around a vertical axis (rotation center).
        
        Args:
            vectors: Vectorized element dictionary
            center_x: X coordinate of rotation center
            
        Returns:
            Vectorized element with mirrored paths added
        """
        mirrored_paths = []
        
        for path_data in vectors['paths']:
            # Parse path and mirror coordinates
            mirrored_path = self._mirror_svg_path(path_data, center_x)
            mirrored_paths.append(mirrored_path)
        
        # Add mirrored paths to original
        vectors['paths'].extend(mirrored_paths)
        vectors['mirrored'] = True
        vectors['mirror_axis'] = center_x
        
        return vectors
    
    def _mirror_svg_path(self, path_data: str, center_x: int) -> str:
        """
        Mirror an SVG path string around a vertical axis.
        
        Args:
            path_data: SVG path string
            center_x: X coordinate of mirror axis
            
        Returns:
            Mirrored SVG path string
        """
        # Simple mirroring by parsing and transforming coordinates
        # This is a simplified version - for production, use proper SVG path parsing
        
        import re
        
        def mirror_coord(match):
            # Extract x coordinate and mirror it
            x = float(match.group(1))
            mirrored_x = 2 * center_x - x
            return f"{mirrored_x:.2f}"
        
        # Mirror x coordinates in the path
        # Pattern matches numbers followed by comma (x coordinates in "x,y" pairs)
        mirrored = re.sub(r'(\d+\.?\d*),', mirror_coord, path_data)
        
        return mirrored
    
    def export_svg(
        self,
        elements: List[Dict[str, Any]],
        output_path: str,
        width: int,
        height: int,
        include_background: bool = False,
        background_image: Optional[str] = None
    ):
        """
        Export vectorized elements to SVG with organized layers.
        
        Args:
            elements: List of vectorized elements
            output_path: Path to save SVG
            width: SVG width in pixels
            height: SVG height in pixels
            include_background: Whether to include background image
            background_image: Path to background image
        """
        if not elements:
            raise ValueError("No elements to export")
        
        # Create SVG with BOTH size and viewBox for proper scaling
        dwg = svgwrite.Drawing(
            output_path, 
            size=(f'{width}px', f'{height}px'),
            viewBox=f'0 0 {width} {height}',  # IMPORTANT: preserves aspect ratio
            profile='full'
        )
        
        print(f"\n{'='*60}")
        print(f"Creating SVG: {width}x{height}px")
        print(f"ViewBox: 0 0 {width} {height}")
        print(f"{'='*60}")
        
        # Add background if requested
        if include_background and background_image:
            import base64
            
            with open(background_image, 'rb') as img_file:
                img_data = base64.b64encode(img_file.read()).decode('utf-8')
                img_format = 'jpeg' if background_image.lower().endswith(('.jpg', '.jpeg')) else 'png'
                
                dwg.add(dwg.image(
                    href=f'data:image/{img_format};base64,{img_data}',
                    insert=(0, 0),
                    size=(f'{width}px', f'{height}px'),
                    opacity=0.3
                ))
        
        # Group elements by category
        categories = {}
        for element in elements:
            cat = element['category']
            if cat not in categories:
                categories[cat] = []
            categories[cat].append(element)
        
        # Create groups for each category
        for category_name, category_elements in categories.items():
            style = self.CATEGORIES.get(category_name, self.CATEGORIES['Detail'])
            
            # Create group
            group = dwg.g(
                id=f'category_{category_name}',
                stroke=style['color'],
                stroke_width=style['stroke_width'],
                fill=style['fill']
            )
            
            # Add elements to group
            for element in category_elements:
                for i, path_data in enumerate(element['paths']):
                    # Debug: print first path to check format and coordinates
                    if i == 0:  # Only first path of each element
                        print(f"  Path for {element['name']}: {path_data[:150]}...")
                    
                    group.add(dwg.path(
                        d=path_data,
                        id=f"{sanitize_svg_id(element['name'])}_{i}"
                    ))
            
            dwg.add(group)
            print(f"  ✓ Added category '{category_name}': {len(category_elements)} elements")
        
        # Add metadata as comment
        # SVG doesn't require metadata, we can just save the file
        
        # Save
        dwg.save()
        print(f"SVG exported to {output_path}")
    
    def get_max_path_x(self, vectorized_elements: List[Dict[str, Any]]) -> float:
        """
        Scan the 'd' path data of all vectorized elements (e.g. mirrored profile,
        diameter line) and return the largest X coordinate found.

        Used to grow the SVG canvas to the right when a mirrored profile
        extends past the original image width instead of getting clipped.

        Mirrors the same source-of-truth export_unified_svg() uses: when an
        element has a readable 'svg_file', that intermediate file is what
        actually ends up in the final SVG. element['paths'] is used only as
        a fallback, and its coordinates are comma-free (_fix_path_spacing
        replaces every ',' with a space), so the regex below matches an
        "x,y" or "x y" pair rather than requiring a trailing comma.
        """
        pattern = re.compile(r'(-?\d+\.?\d*)[,\s](-?\d+\.?\d*)')
        max_x = 0.0

        def scan(path_data):
            nonlocal max_x
            for match in pattern.finditer(path_data or ''):
                try:
                    x = float(match.group(1))
                    if x > max_x:
                        max_x = x
                except ValueError:
                    continue

        ns = {'svg': 'http://www.w3.org/2000/svg'}
        for element in vectorized_elements:
            svg_file = element.get('svg_file')
            paths_from_file = None

            if svg_file and os.path.exists(svg_file):
                try:
                    svg_root = ET.parse(svg_file).getroot()
                    paths_found = svg_root.findall('.//svg:path', ns) or svg_root.findall('.//path')
                    paths_from_file = [p.get('d', '') for p in paths_found]
                except Exception:
                    paths_from_file = None

            if paths_from_file is not None:
                for path_data in paths_from_file:
                    scan(path_data)
            else:
                for path_data in element.get('paths', []):
                    if isinstance(path_data, dict):
                        path_data = path_data.get('d', '')
                    scan(path_data)

        return max_x

    def export_unified_svg(
        self,
        vectorized_elements: List[Dict[str, Any]],
        raster_elements: List[Dict[str, Any]],
        output_path: str,
        width: int,
        height: int,
        include_background: bool = False,
        background_image: Optional[str] = None,
        canvas_width: Optional[int] = None,
        canvas_height: Optional[int] = None
    ):
        """
        Export a unified SVG with layers containing both vectorized and raster elements.
        Each category becomes a layer that can be toggled in Illustrator.

        Args:
            vectorized_elements: List of vectorized elements (with paths)
            raster_elements: List of raster elements (with PNG file paths)
            output_path: Path to save SVG
            width: Original image width in pixels (used to size/place the
                background image and raster masks, which must not be stretched)
            height: Original image height in pixels
            include_background: Whether to include background image
            background_image: Path to background image
            canvas_width: Width of the SVG canvas/viewBox. Defaults to `width`.
                Pass a larger value (e.g. to fit a mirrored profile) to widen
                the canvas to the right without resizing the background.
            canvas_height: Height of the SVG canvas/viewBox. Defaults to `height`.
        """
        import base64

        if canvas_width is None or canvas_width < width:
            canvas_width = width
        if canvas_height is None or canvas_height < height:
            canvas_height = height

        # Check if we have any elements to export
        if not vectorized_elements and not raster_elements:
            print("Warning: No elements to export to unified SVG")
            # Create empty SVG anyway
            dwg = svgwrite.Drawing(
                output_path,
                size=(f'{canvas_width}px', f'{canvas_height}px'),
                viewBox=f'0 0 {canvas_width} {canvas_height}',
                profile='full'
            )
            dwg.save()
            return

        # Create SVG with BOTH size and viewBox for proper scaling
        dwg = svgwrite.Drawing(
            output_path,
            size=(f'{canvas_width}px', f'{canvas_height}px'),
            viewBox=f'0 0 {canvas_width} {canvas_height}',
            profile='full'
        )

        print(f"\n{'='*60}")
        print(f"Creating UNIFIED SVG: canvas {canvas_width}x{canvas_height}px (background {width}x{height}px)")
        print(f"Vectorized elements received: {len(vectorized_elements)}")
        for i, elem in enumerate(vectorized_elements):
            print(f"  [{i}] Category: {elem.get('category', 'N/A')}, Name: {elem.get('name', 'N/A')}")
        print(f"Raster elements: {len(raster_elements)}")
        print(f"{'='*60}")
        
        # Add background layer if requested
        if include_background and background_image:
            with open(background_image, 'rb') as img_file:
                img_data = base64.b64encode(img_file.read()).decode('utf-8')
                img_format = 'jpeg' if background_image.lower().endswith(('.jpg', '.jpeg')) else 'png'
                
                bg_group = dwg.g(id='layer_background')
                bg_group.add(dwg.image(
                    href=f'data:image/{img_format};base64,{img_data}',
                    insert=(0, 0),
                    size=(f'{width}px', f'{height}px'),
                    opacity=0.3
                ))
                dwg.add(bg_group)
                print(f"  ✓ Added background layer")
        
        # Combine all elements and group by category
        all_elements = {}
        
        # Add vectorized elements
        for element in vectorized_elements:
            cat = element['category']
            if cat not in all_elements:
                all_elements[cat] = {'vectorized': [], 'raster': []}
            all_elements[cat]['vectorized'].append(element)
        
        # Add raster elements
        for element in raster_elements:
            cat = element['segment']['category']
            if cat not in all_elements:
                all_elements[cat] = {'vectorized': [], 'raster': []}
            all_elements[cat]['raster'].append(element)
        
        # Create a layer (group) for each category
        for category_name, elements_dict in all_elements.items():
            style = self.CATEGORIES.get(category_name, self.CATEGORIES.get('Detail', {}))
            
            # Create category layer/group (without Inkscape-specific attributes for compatibility)
            layer_group = dwg.g(
                id=f'layer_{category_name}'
                # Note: Removed inkscape:label and inkscape:groupmode for compatibility
                # These can be added manually in Illustrator/Inkscape if needed
            )
            
            # Add vectorized elements to this layer
            for element in elements_dict['vectorized']:
                # Instead of using extracted paths (which can be corrupted),
                # import the SVG file content directly if available
                if 'svg_file' in element and os.path.exists(element['svg_file']):
                    print(f"  → Importing SVG from file: {element['svg_file']}")
                    
                    try:
                        # Read and parse the SVG file
                        svg_tree = ET.parse(element['svg_file'])
                        svg_root = svg_tree.getroot()
                        
                        # Extract all path elements from the source SVG
                        ns = {'svg': 'http://www.w3.org/2000/svg'}
                        paths_found = svg_root.findall('.//svg:path', ns)
                        
                        # If no paths with namespace, try without
                        if not paths_found:
                            paths_found = svg_root.findall('.//path')
                        
                        # Create element group with optional stroke-dasharray
                        group_attrs = {
                            'id': f"element_{sanitize_svg_id(element['name'])}",
                            'stroke': style.get('color', '#000000'),
                            'stroke_width': style.get('stroke_width', 1.0),
                            'fill': style.get('fill', 'none')
                        }
                        
                        # Add stroke-dasharray if present in style
                        if 'stroke_dasharray' in style:
                            group_attrs['stroke_dasharray'] = style['stroke_dasharray']
                        
                        element_group = dwg.g(**group_attrs)
                        
                        # Add all paths from source SVG (preserving original path data)
                        for i, path_elem in enumerate(paths_found):
                            original_path_data = path_elem.get('d', '')
                            if original_path_data:
                                element_group.add(dwg.path(
                                    d=original_path_data,
                                    id=f"{sanitize_svg_id(element['name'])}_path_{i}"
                                ))
                        
                        layer_group.add(element_group)
                        print(f"  ✓ Added vectorized from SVG: {element['name']} ({len(paths_found)} paths)")
                        
                    except Exception as e:
                        print(f"  ✗ Error importing SVG file: {e}")
                        # Fallback to extracted paths if file import fails
                        self._add_vectorized_element_from_paths(dwg, layer_group, element, style)
                else:
                    # Fallback: use extracted paths (old method)
                    self._add_vectorized_element_from_paths(dwg, layer_group, element, style)
            
            # Add raster elements to this layer (embedded as base64 PNG)
            for element in elements_dict['raster']:
                png_path = element['path']
                segment = element['segment']
                
                # Read PNG and convert to base64
                with open(png_path, 'rb') as png_file:
                    png_data = base64.b64encode(png_file.read()).decode('utf-8')
                
                # Add image to layer
                layer_group.add(dwg.image(
                    href=f'data:image/png;base64,{png_data}',
                    insert=(0, 0),
                    size=(f'{width}px', f'{height}px'),
                    id=f"raster_{sanitize_svg_id(segment['name'])}"
                ))
                print(f"  ✓ Added raster: {segment['name']} (embedded PNG)")
            
            dwg.add(layer_group)
            print(f"  ✓ Created layer '{category_name}': {len(elements_dict['vectorized'])} vector + {len(elements_dict['raster'])} raster")
        
        # Save
        dwg.save()
        print(f"Unified SVG exported to {output_path}")
        print(f"{'='*60}\n")
    
    def _add_vectorized_element_from_paths(self, dwg, layer_group, element, style):
        """Helper method to add vectorized element using extracted paths (fallback)."""
        # Create element group with optional stroke-dasharray
        group_attrs = {
            'id': f"element_{sanitize_svg_id(element['name'])}",
            'stroke': style.get('color', '#000000'),
            'stroke_width': style.get('stroke_width', 1.0),
            'fill': style.get('fill', 'none')
        }
        
        # Add stroke-dasharray if present in style
        if 'stroke_dasharray' in style:
            group_attrs['stroke_dasharray'] = style['stroke_dasharray']
        
        element_group = dwg.g(**group_attrs)
        
        for i, path_data in enumerate(element['paths']):
            # Handle both string paths and dict paths (with 'd' key)
            if isinstance(path_data, dict):
                d_attr = path_data.get('d', '')
            else:
                d_attr = path_data
            
            if d_attr:
                element_group.add(dwg.path(
                    d=d_attr,
                    id=f"{sanitize_svg_id(element['name'])}_path_{i}"
                ))
        
        layer_group.add(element_group)
        print(f"  ✓ Added vectorized from paths: {element['name']} ({len(element['paths'])} paths)")


# Example usage
if __name__ == '__main__':
    handler = VectorizationHandler()
    print("VectorizationHandler initialized successfully!")
    print(f"Available categories: {list(handler.CATEGORIES.keys())}")
