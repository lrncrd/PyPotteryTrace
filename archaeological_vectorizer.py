#!/usr/bin/env python3
"""
Archaeological Drawing Vectorizer v2.0

A specialized tool for vectorizing archaeological drawings with element classification.
Based on the working vectorize.py system with modular architecture and English translation.

Features:
- Separates dotted points, painted decorations, and lines before processing
- Uses sensitive binarization for shadow detection  
- Applies skeletonization only to clean line data
- Classifies elements into archaeological categories
- Generates smooth Bézier curves for natural line appearance
- Exports both SVG and JPG comparison files

Author: Archaeological Vectorization System
Version: 2.0
"""

import cv2
import numpy as np
from skimage.morphology import skeletonize, closing, disk
from skimage import img_as_ubyte
from skimage.measure import label
import sknw
import svgwrite
from rdp import rdp
import matplotlib.pyplot as plt
import math
from typing import List, Tuple, Dict, Any, Optional


def find_dotted_points(binary_image: np.ndarray, 
                      min_area: int = 5, 
                      max_area: int = 200, 
                      circularity_threshold: float = 0.6) -> List[Tuple[int, int, int]]:
    """
    Find dotted points as small circular isolated areas.
    
    Args:
        binary_image: Binary image as boolean array
        min_area: Minimum area for a valid dotted point
        max_area: Maximum area for a valid dotted point
        circularity_threshold: Minimum circularity (0-1, where 1 is perfect circle)
        
    Returns:
        List of (center_y, center_x, radius) tuples
    """
    # Find connected components
    labeled_image = label(binary_image)
    dotted_points = []
    
    for region_id in range(1, labeled_image.max() + 1):
        region_mask = (labeled_image == region_id)
        area = np.sum(region_mask)
        
        # Filter by size
        if min_area <= area <= max_area:
            # Find contour to calculate circularity
            region_uint8 = region_mask.astype(np.uint8)
            contours, _ = cv2.findContours(region_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            if len(contours) > 0:
                contour = contours[0]
                area_contour = cv2.contourArea(contour)
                perimeter = cv2.arcLength(contour, True)
                
                if perimeter > 0:
                    # Calculate circularity (4π * area / perimeter²)
                    circularity = 4 * np.pi * area_contour / (perimeter * perimeter)
                    
                    # If circular enough, consider it a dotted point
                    if circularity >= circularity_threshold:
                        # Find center and approximate radius
                        moments = cv2.moments(contour)
                        if moments['m00'] != 0:
                            center_x = int(moments['m10'] / moments['m00'])
                            center_y = int(moments['m01'] / moments['m00'])
                            radius = int(np.sqrt(area_contour / np.pi))
                            dotted_points.append((center_y, center_x, radius))
    
    return dotted_points


def smooth_path_to_bezier(path_points: np.ndarray, smoothing_factor: float = 0.3) -> str:
    """
    Convert a path of points to smooth Bézier curves.
    
    Args:
        path_points: Array of points [(y1,x1), (y2,x2), ...]
        smoothing_factor: Smoothing intensity (0.0 = none, 1.0 = maximum)
    
    Returns:
        SVG path string with Bézier curves
    """
    if len(path_points) < 3:
        # Too few points for smoothing, use normal lines
        return create_simple_path(path_points)
    
    # Convert coordinates (y,x) to (x,y) for SVG
    points = [(float(p[1]), float(p[0])) for p in path_points]
    
    if len(points) < 4:
        # Use quadratic curves for 3 points
        return create_quadratic_bezier_path(points, smoothing_factor)
    else:
        # Use cubic curves for 4+ points
        return create_cubic_bezier_path(points, smoothing_factor)


def create_simple_path(path_points: np.ndarray) -> str:
    """Create a simple SVG path with lines."""
    if len(path_points) < 2:
        return ""
    
    points = [(float(p[1]), float(p[0])) for p in path_points]
    path_data = f"M {points[0][0]:.2f},{points[0][1]:.2f}"
    
    for i in range(1, len(points)):
        path_data += f" L {points[i][0]:.2f},{points[i][1]:.2f}"
    
    return path_data


def create_quadratic_bezier_path(points: List[Tuple[float, float]], smoothing_factor: float) -> str:
    """Create quadratic Bézier curves for 3 points."""
    if len(points) != 3:
        return create_simple_path([(p[1], p[0]) for p in points])
    
    p0, p1, p2 = points
    
    # Calculate control point for quadratic curve
    # Control point based on midpoint but "pulled" towards p1
    control_x = p1[0] + (p1[0] - (p0[0] + p2[0]) / 2) * smoothing_factor
    control_y = p1[1] + (p1[1] - (p0[1] + p2[1]) / 2) * smoothing_factor
    
    path_data = f"M {p0[0]:.2f},{p0[1]:.2f}"
    path_data += f" Q {control_x:.2f},{control_y:.2f} {p2[0]:.2f},{p2[1]:.2f}"
    
    return path_data


def create_cubic_bezier_path(points: List[Tuple[float, float]], smoothing_factor: float) -> str:
    """Create cubic Bézier curves for 4+ points."""
    if len(points) < 4:
        return create_simple_path([(p[1], p[0]) for p in points])
    
    path_data = f"M {points[0][0]:.2f},{points[0][1]:.2f}"
    
    for i in range(1, len(points) - 2):
        p0 = points[i-1] if i > 0 else points[0]
        p1 = points[i]
        p2 = points[i+1]
        p3 = points[i+2] if i+2 < len(points) else points[-1]
        
        # Calculate control points for cubic Bézier curves
        # Use Catmull-Rom method to calculate tangents
        tension = smoothing_factor * 0.5
        
        # Tangent at point p1 (direction towards p2, influenced by p0)
        t1_x = (p2[0] - p0[0]) * tension
        t1_y = (p2[1] - p0[1]) * tension
        
        # Tangent at point p2 (direction towards p3, influenced by p1)
        t2_x = (p3[0] - p1[0]) * tension
        t2_y = (p3[1] - p1[1]) * tension
        
        # Control points
        cp1_x = p1[0] + t1_x / 3
        cp1_y = p1[1] + t1_y / 3
        cp2_x = p2[0] - t2_x / 3
        cp2_y = p2[1] - t2_y / 3
        
        if i == 1:
            # First curve
            path_data += f" C {cp1_x:.2f},{cp1_y:.2f} {cp2_x:.2f},{cp2_y:.2f} {p2[0]:.2f},{p2[1]:.2f}"
        else:
            # Subsequent curves - use S for continuity
            path_data += f" S {cp2_x:.2f},{cp2_y:.2f} {p2[0]:.2f},{p2[1]:.2f}"
    
    # Add final point if necessary
    if len(points) > 3:
        path_data += f" L {points[-1][0]:.2f},{points[-1][1]:.2f}"
    
    return path_data


def find_painted_decorations_from_original(original_image: np.ndarray, 
                                         dark_threshold: int = 100,
                                         min_decoration_area: int = 1000) -> List[np.ndarray]:
    """
    Find painted decorations (large black areas) from the original image.
    Returns contours as editable paths instead of filled polygons.
    
    Args:
        original_image: Original grayscale image
        dark_threshold: Threshold for identifying dark areas
        min_decoration_area: Minimum area to be considered a decoration
        
    Returns:
        List of contour arrays for decorations in (y, x) format
    """
    # Use original image to find large black areas
    # Apply threshold to identify very dark areas
    _, dark_areas = cv2.threshold(original_image, dark_threshold, 255, cv2.THRESH_BINARY_INV)
    
    # Remove small noise areas
    kernel_open = np.ones((5, 5), np.uint8)
    dark_areas_cleaned = cv2.morphologyEx(dark_areas, cv2.MORPH_OPEN, kernel_open)
    
    # FILLING: Close small white holes inside decorations
    # Use larger kernel for closing to fill holes
    kernel_close = np.ones((15, 15), np.uint8)  # Larger kernel to close holes
    dark_areas_filled = cv2.morphologyEx(dark_areas_cleaned, cv2.MORPH_CLOSE, kernel_close)
    
    # More aggressive alternative: flood fill from borders to fill internal holes
    # Create copy with borders
    h, w = dark_areas_filled.shape
    mask = np.zeros((h+2, w+2), np.uint8)
    dark_areas_floodfilled = dark_areas_filled.copy()
    
    # Flood fill from point (0,0) to identify background
    cv2.floodFill(dark_areas_floodfilled, mask, (0,0), 255)
    
    # Invert to get only internal areas not reached by flood fill
    dark_areas_filled_final = dark_areas_filled | cv2.bitwise_not(dark_areas_floodfilled)
    
    # Find contours of dark areas (now with filling)
    contours, _ = cv2.findContours(dark_areas_filled_final, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    decoration_contours = []
    areas_found = []
    
    for contour in contours:
        area = cv2.contourArea(contour)
        areas_found.append(area)
        # Lower threshold to capture painted decorations
        if area > min_decoration_area:
            # Convert OpenCV contour to points array (y, x)
            # OpenCV contours are in format [[x, y]]
            contour_points = []
            for point in contour:
                x, y = point[0]
                contour_points.append([y, x])  # Convert to (y, x) format
            
            # Close contour by adding first point at the end
            if len(contour_points) > 2:
                contour_points.append(contour_points[0])
                decoration_contours.append(np.array(contour_points))
    
    if areas_found:
        print(f"Black areas found: min={min(areas_found):.0f}, max={max(areas_found):.0f}, avg={np.mean(areas_found):.0f}")
    print(f"Found {len(decoration_contours)} painted decorations (black areas > {min_decoration_area}px)")
    
    # Decorations filling debug removed - not needed
    
    return decoration_contours


def classify_archaeological_elements(original_image: np.ndarray, 
                                   binary_image: np.ndarray, 
                                   graph) -> Dict[str, List]:
    """
    Classify drawing elements into archaeological categories:
    1. Lines (all long paths)
    2. Points (small isolated elements - dotted patterns)
    3. Polygons (large black areas in original image)
    
    Args:
        original_image: Original grayscale image
        binary_image: Binary image as boolean array
        graph: NetworkX graph from skeletonized image
        
    Returns:
        Dictionary with classified elements
    """
    # We don't extract painted decorations from the graph anymore
    # They are handled separately and more accurately from the original image
    
    # Classify graph elements (only lines and dotted points)
    lines = []
    dotted_points = []
    
    for (s, e) in graph.edges():
        path_pixels = graph[s][e]['pts']
        
        if len(path_pixels) < 2:
            continue
            
        # Calculate path characteristics
        length = calculate_path_length(path_pixels)
        is_very_short = length < 8  # Threshold to distinguish points from lines
        
        if is_very_short:
            # Small elements = dotted pattern
            dotted_points.append((s, e, path_pixels))
        else:
            # Everything else = lines (no more graph decorations)
            lines.append((s, e, path_pixels))
    
    return {
        'lines': lines,
        'dotted_points': dotted_points,
        'painted_decorations': []  # Empty - no graph decorations
    }


def calculate_path_length(path_pixels: np.ndarray) -> float:
    """Calculate the length of a path."""
    if len(path_pixels) < 2:
        return 0
    
    total_length = 0
    for i in range(1, len(path_pixels)):
        dy = path_pixels[i][0] - path_pixels[i-1][0]
        dx = path_pixels[i][1] - path_pixels[i-1][1]
        total_length += math.sqrt(dx*dx + dy*dy)
    
    return total_length


def connect_nearby_endpoints(graph, max_distance: int = 10) -> Any:
    """
    Connect nearby endpoints of the graph to improve path continuity.
    
    Args:
        graph: NetworkX graph
        max_distance: Maximum distance to connect endpoints
        
    Returns:
        Modified graph with additional connections
    """
    # Identify endpoints (nodes with degree 1)
    endpoints = [node for node, degree in graph.degree() if degree == 1]
    
    if len(endpoints) < 2:
        return graph
    
    # Find pairs of nearby endpoints
    connections_made = 0
    for i, node1 in enumerate(endpoints):
        if node1 not in graph.nodes():  # May have been removed in previous iterations
            continue
            
        pos1 = np.array([graph.nodes[node1]['o'][0], graph.nodes[node1]['o'][1]])
        
        for node2 in endpoints[i+1:]:
            if node2 not in graph.nodes():
                continue
                
            pos2 = np.array([graph.nodes[node2]['o'][0], graph.nodes[node2]['o'][1]])
            distance = np.linalg.norm(pos1 - pos2)
            
            if distance <= max_distance and not graph.has_edge(node1, node2):
                # Create straight line between the two points
                num_points = max(2, int(distance))
                x_coords = np.linspace(pos1[1], pos2[1], num_points)
                y_coords = np.linspace(pos1[0], pos2[0], num_points)
                
                connecting_path = np.column_stack([y_coords, x_coords])
                
                # Add edge to graph
                graph.add_edge(node1, node2, pts=connecting_path)
                connections_made += 1
                
                # Remove nodes from endpoints list
                if node1 in endpoints:
                    endpoints.remove(node1)
                if node2 in endpoints:
                    endpoints.remove(node2)
                break
    
    print(f"Connections added: {connections_made}")
    return graph


def vectorize_archaeological_drawing(image_path: str,
                                   output_svg_path: str,
                                   output_jpg_path: Optional[str] = None,
                                   binary_threshold: int = 15,
                                   epsilon: float = 1.5,
                                   smoothing_factor: float = 0.3,
                                   min_dotted_area: int = 5,
                                   max_dotted_area: int = 200,
                                   dotted_circularity: float = 0.6,
                                   dark_threshold: int = 100,
                                   min_decoration_area: int = 1000,
                                   show_debug_plots: bool = True,
                                   save_debug_images: bool = True,
                                   include_background_image: bool = False) -> Dict[str, Any]:
    """
    Main function to vectorize archaeological drawings with element classification.
    Based on the proven vectorize.py workflow.
    
    Args:
        image_path: Path to input image
        output_svg_path: Path for output SVG file
        output_jpg_path: Optional path for output JPG comparison
        binary_threshold: Threshold for binarization (lower = more sensitive)
        epsilon: RDP simplification epsilon (higher = more simplification)
        smoothing_factor: Bézier curve smoothing (0-1)
        min_dotted_area: Minimum area for dotted points
        max_dotted_area: Maximum area for dotted points
        dotted_circularity: Minimum circularity for dotted points
        dark_threshold: Threshold for finding dark decorations
        min_decoration_area: Minimum area for painted decorations
        show_debug_plots: Whether to show matplotlib debug plots
        save_debug_images: Whether to save debug PNG files
        include_background_image: Whether to include original image as background in SVG (diagnostic_plots.png and skeleton_debug.png)
        
    Returns:
        Dictionary with processing statistics and results
    """
    print("Archaeological Drawing Vectorizer v2.0")
    print("=" * 50)
    
    # --- 1. Loading and Enhanced Preprocessing ---
    print(f"Loading image: {image_path}")
    img_original_color = cv2.imread(image_path)
    if img_original_color is None:
        raise ValueError(f"Error: Could not read image from {image_path}")
        
    img_gray = cv2.cvtColor(img_original_color, cv2.COLOR_BGR2GRAY)
    height, width = img_gray.shape
    print(f"Image dimensions: {width} x {height}")
    
    # Apply light blur to reduce noise
    img_blur = cv2.GaussianBlur(img_gray, (3, 3), 0)
    
    # Very sensitive binarization to capture even faint shadows
    print("Using very sensitive binarization for shadows...")
    
    # Invert image (black lines become white)
    img_inverted = cv2.bitwise_not(img_blur)
    
    # Very low threshold to capture even light gray zones
    # Everything that's not completely white (255) becomes part of the drawing
    _, binary_image = cv2.threshold(img_inverted, binary_threshold, 255, cv2.THRESH_BINARY)
    
    print(f"Threshold used: {binary_threshold}")
    print(f"White pixels in binarization: {np.sum(binary_image > 0)}")
    
    # Binarization debug removed - not needed
    
    # Convert to boolean for subsequent processing
    binary_image_bool = binary_image.astype(bool)

    # --- 2. Separation of Dotted Points, Decorations and Lines ---
    print("Separating dotted points, decorations and lines...")
    
    # Identify dotted points as small circular isolated areas
    dotted_points = find_dotted_points(binary_image_bool, min_dotted_area, max_dotted_area, dotted_circularity)
    print(f"Found {len(dotted_points)} dotted points")
    
    # Identify painted decorations from original image
    painted_decorations = find_painted_decorations_from_original(img_gray, dark_threshold, min_decoration_area)
    print(f"Found {len(painted_decorations)} painted decorations")
    
    # Create mask without dotted points and decorations for line skeletonization
    lines_mask = binary_image_bool.copy()
    
    # Remove dotted points from lines mask
    for (center_y, center_x, radius) in dotted_points:
        y_min = max(0, center_y - radius - 2)
        y_max = min(binary_image_bool.shape[0], center_y + radius + 3)
        x_min = max(0, center_x - radius - 2)
        x_max = min(binary_image_bool.shape[1], center_x + radius + 3)
        lines_mask[y_min:y_max, x_min:x_max] = False
    
    # Remove painted decorations from lines mask
    for contour_points in painted_decorations:
        if len(contour_points) > 2:
            # Create mask for this decoration
            decoration_mask = np.zeros_like(lines_mask, dtype=np.uint8)
            # Convert points to OpenCV format for fillPoly
            cv_points = np.array([[int(p[1]), int(p[0])] for p in contour_points], dtype=np.int32)
            cv2.fillPoly(decoration_mask, [cv_points], 1)
            # Remove decoration area from lines mask
            lines_mask = lines_mask & (~decoration_mask.astype(bool))
    
    remaining_pixels = np.sum(lines_mask)
    print(f"Pixels remaining for lines: {remaining_pixels}")

    # --- 3. Skeletonization Only of Lines ---
    print("Performing skeletonization of lines...")
    
    if remaining_pixels > 0:
        # Improve connectivity only for lines
        improved_lines = closing(lines_mask, disk(2))
        
        # Skeletonization only of lines
        skeleton = skeletonize(improved_lines)
        skeleton_img = img_as_ubyte(skeleton)
        
        skeleton_pixels = np.sum(skeleton_img > 0)
        print(f"Skeleton pixels for lines: {skeleton_pixels}")
    else:
        print("No lines to skeletonize")
        skeleton_img = np.zeros_like(binary_image, dtype=np.uint8)
        skeleton_pixels = 0

    # --- 3. Path Extraction ---
    print("Building graph from skeleton...")
    graph = sknw.build_sknw(skeleton_img, multi=False)
    
    initial_nodes = len(graph.nodes())
    initial_edges = len(graph.edges())
    print(f"Initial graph: {initial_nodes} nodes and {initial_edges} edges")
    
    # This will be updated later to show final results
    
    # --- 3.1 Improve Graph Connectivity ---
    print("Improving graph connectivity...")
    graph = connect_nearby_endpoints(graph, max_distance=8)
    
    final_nodes = len(graph.nodes())
    final_edges = len(graph.edges())
    print(f"Final graph: {final_nodes} nodes and {final_edges} edges")
    
    # --- 4. Archaeological Element Classification ---
    print("Classifying archaeological elements...")
    classified_elements = classify_archaeological_elements(img_gray, binary_image_bool, graph)
    
    # Add elements found separately (before skeletonization)
    classified_elements['dotted_points_separate'] = dotted_points
    classified_elements['painted_decorations_separate'] = painted_decorations
    
    # Classification debug removed - not needed
    
    # Create skeleton debug with final results
    if save_debug_images:
        create_skeleton_debug_image(img_gray, classified_elements)
    
    # --- 5. Enhanced SVG Saving ---
    print(f"Saving classified SVG file to {output_svg_path}...")
    save_classified_svg(classified_elements, output_svg_path, width, height, epsilon, smoothing_factor, 
                       image_path if include_background_image else None)
    
    # Generate JPG comparison if requested
    if output_jpg_path:
        print(f"Generating JPG comparison to {output_jpg_path}...")
        generate_jpg_comparison(classified_elements, output_jpg_path, width, height)
    
    # Statistics
    stats = {
        'total_lines': len(classified_elements['lines']),
        'graph_dotted_points': len(classified_elements['dotted_points']),
        'separated_dotted_points': len(classified_elements.get('dotted_points_separate', [])),
        'graph_decorations': len(classified_elements['painted_decorations']),
        'separated_decorations': len(classified_elements.get('painted_decorations_separate', [])),
        'total_graph_elements': initial_edges,
        'remaining_line_pixels': remaining_pixels,
        'skeleton_pixels': skeleton_pixels
    }
    
    print("\n=== ARCHAEOLOGICAL ELEMENT CLASSIFICATION ===")
    print(f"Lines: {stats['total_lines']}")
    print(f"Graph dotted points: {stats['graph_dotted_points']}")
    print(f"Separated dotted points: {stats['separated_dotted_points']}")
    print(f"Graph decorations: {stats['graph_decorations']}")
    print(f"Separated decorations: {stats['separated_decorations']}")
    print(f"Total graph elements: {stats['total_graph_elements']}")
    print("Conversion completed!")
    
    if show_debug_plots:
        show_diagnostic_plots(img_gray, binary_image, skeleton_img, classified_elements)
    
    return stats


def create_skeleton_debug_image(original: np.ndarray, classified_elements: Dict[str, List]):
    """
    Create skeleton debug image showing the final classified results.
    This shows what actually gets saved to SVG.
    
    Args:
        original: Original grayscale image
        classified_elements: Dictionary with classified elements
    """
    # Start with original image as background
    debug_img = cv2.cvtColor(original, cv2.COLOR_GRAY2BGR)
    
    # Draw lines in BLUE (thick for visibility)
    for (s, e, path_pixels) in classified_elements['lines']:
        for i in range(len(path_pixels)-1):
            y1, x1 = int(path_pixels[i][0]), int(path_pixels[i][1])
            y2, x2 = int(path_pixels[i+1][0]), int(path_pixels[i+1][1])
            if (0 <= y1 < debug_img.shape[0] and 0 <= x1 < debug_img.shape[1] and
                0 <= y2 < debug_img.shape[0] and 0 <= x2 < debug_img.shape[1]):
                cv2.line(debug_img, (x1, y1), (x2, y2), (255, 0, 0), 2)  # Blue
    
    # Draw separated dotted points in RED (circles)
    for (center_y, center_x, radius) in classified_elements.get('dotted_points_separate', []):
        if (0 <= center_y < debug_img.shape[0] and 0 <= center_x < debug_img.shape[1]):
            cv2.circle(debug_img, (center_x, center_y), max(3, radius//2), (0, 0, 255), -1)  # Red filled
    
    # Draw separated decorations in GREEN (filled contours)
    for contour_points in classified_elements.get('painted_decorations_separate', []):
        if len(contour_points) > 2:
            # Convert to OpenCV format and fill
            cv_contour = np.array([[int(point[1]), int(point[0])] for point in contour_points], dtype=np.int32)
            cv_contour = cv_contour.reshape(-1, 1, 2)
            cv2.fillPoly(debug_img, [cv_contour], (0, 255, 0))  # Green fill
            
            # Also draw contour outline in darker green
            cv2.polylines(debug_img, [cv_contour], True, (0, 150, 0), 2)
    
    cv2.imwrite('skeleton_debug.png', debug_img)
    print("Saved skeleton_debug.png showing final classified results")





def save_classified_svg(classified_elements: Dict[str, List], 
                       svg_path: str, 
                       width: int, 
                       height: int,
                       epsilon: float = 1.5,
                       smoothing_factor: float = 0.3,
                       background_image_path: Optional[str] = None):
    """Save classified elements to SVG with proper styling and optional background image."""
    dwg = svgwrite.Drawing(svg_path, size=(width, height), profile='tiny')
    
    # Add background image if requested
    if background_image_path:
        import base64
        import os
        
        # Read and encode image as base64
        if os.path.exists(background_image_path):
            with open(background_image_path, 'rb') as img_file:
                img_data = base64.b64encode(img_file.read()).decode('utf-8')
                
                # Determine image format
                img_format = 'jpeg' if background_image_path.lower().endswith(('.jpg', '.jpeg')) else 'png'
                
                # Create background image with reduced opacity for reference
                background_group = dwg.g(id='background', opacity=0.3)
                background_group.add(dwg.image(
                    href=f'data:image/{img_format};base64,{img_data}',
                    insert=(0, 0),
                    size=(width, height)
                ))
                dwg.add(background_group)
                print(f"Added background image: {background_image_path} (opacity: 30%)")
    
    # Lines with smoothing (separate group)
    lines_group = dwg.g(id='lines', stroke='black', stroke_width=1, fill='none')
    for (s, e, path_pixels) in classified_elements['lines']:
        simplified_path = rdp(path_pixels, epsilon=epsilon)
        if len(simplified_path) > 1:
            if smoothing_factor > 0:
                # Use Bézier curves for smooth lines
                path_data = smooth_path_to_bezier(simplified_path, smoothing_factor)
            else:
                # Use simple lines if smoothing = 0
                path_data = f"M {simplified_path[0, 1]:.2f},{simplified_path[0, 0]:.2f}"
                for i in range(1, len(simplified_path)):
                    path_data += f" L {simplified_path[i, 1]:.2f},{simplified_path[i, 0]:.2f}"
            
            if path_data:  # Only if we have valid data
                lines_group.add(dwg.path(d=path_data))
    dwg.add(lines_group)
    
    # Save dotted pattern as points (separate group)
    dots_group = dwg.g(id='dotted_points', fill='red', stroke='none')
    
    # Points from graph (if present)
    for (s, e, path_pixels) in classified_elements['dotted_points']:
        center_idx = len(path_pixels) // 2
        y, x = path_pixels[center_idx][0], path_pixels[center_idx][1]
        dots_group.add(dwg.circle(center=(float(x), float(y)), r=1.5))
    
    # Separated points (found before skeletonization)
    for (center_y, center_x, radius) in classified_elements.get('dotted_points_separate', []):
        dots_group.add(dwg.circle(center=(float(center_x), float(center_y)), r=float(max(1.5, radius/2))))
    
    dwg.add(dots_group)
    
    # Save painted decorations as black filled areas (separate group)
    # Only use separated decorations (extracted directly from original image)
    decorations_group = dwg.g(id='painted_decorations', stroke='black', stroke_width=1, fill='black')
    
    # Separated decorations (extracted from original image - these are the good ones!)
    for contour_points in classified_elements.get('painted_decorations_separate', []):
        if len(contour_points) > 2:
            # Apply very reduced RDP simplification to preserve decoration details
            simplified_contour = rdp(contour_points, epsilon=epsilon * 0.5)  # Reduced epsilon to maintain details
            
            if len(simplified_contour) > 2:
                if smoothing_factor > 0:
                    # Use very light Bézier curves to maintain original shape
                    path_data = smooth_path_to_bezier(simplified_contour, smoothing_factor * 0.2)  # Very reduced smoothing
                else:
                    # Use simple lines if smoothing = 0
                    path_data = f"M {simplified_contour[0, 1]:.2f},{simplified_contour[0, 0]:.2f}"
                    for i in range(1, len(simplified_contour)):
                        path_data += f" L {simplified_contour[i, 1]:.2f},{simplified_contour[i, 0]:.2f}"
                    path_data += " Z"  # Close the path
                
                if path_data:  # Only if we have valid data
                    decorations_group.add(dwg.path(d=path_data))
    
    dwg.add(decorations_group)
    dwg.save()


def generate_jpg_comparison(classified_elements: Dict[str, List], 
                          jpg_path: str, 
                          width: int, 
                          height: int):
    """Generate a JPG comparison image showing the vectorized elements."""
    # Create white background
    img = np.ones((height, width, 3), dtype=np.uint8) * 255
    
    # Draw lines in black
    for (s, e, path_pixels) in classified_elements['lines']:
        if len(path_pixels) > 1:
            for i in range(len(path_pixels) - 1):
                cv2.line(img, 
                        (int(path_pixels[i, 1]), int(path_pixels[i, 0])), 
                        (int(path_pixels[i+1, 1]), int(path_pixels[i+1, 0])), 
                        (0, 0, 0), 1)
    
    # Draw dotted points in red
    for (s, e, path_pixels) in classified_elements['dotted_points']:
        center_idx = len(path_pixels) // 2
        y, x = path_pixels[center_idx][0], path_pixels[center_idx][1]
        cv2.circle(img, (int(x), int(y)), 2, (0, 0, 255), -1)
    
    # Draw separated dotted points in red
    for (center_y, center_x, radius) in classified_elements.get('dotted_points_separate', []):
        cv2.circle(img, (center_x, center_y), max(2, radius//2), (0, 0, 255), -1)
    
    # Draw painted decorations in black (filled)
    for contour_points in classified_elements.get('painted_decorations_separate', []):
        if len(contour_points) > 2:
            cv_contour = np.array([[point[1], point[0]] for point in contour_points], dtype=np.int32)
            cv_contour = cv_contour.reshape(-1, 1, 2)
            cv2.fillPoly(img, [cv_contour], (0, 0, 0))  # Black fill
    
    cv2.imwrite(jpg_path, img)


def show_diagnostic_plots(original: np.ndarray, 
                         binary: np.ndarray, 
                         skeleton: np.ndarray, 
                         classified_elements: Dict[str, List]):
    """
    Show a window with 4 plots to diagnose the process.
    
    Args:
        original: Original grayscale image
        binary: Binary image
        skeleton: Skeletonized image
        classified_elements: Dictionary with classified elements
    """
    # Create figure with 4 sub-plots (2 rows, 2 columns)
    fig, axes = plt.subplots(2, 2, figsize=(15, 12))
    ax = axes.ravel()

    # Plot 1: Original Image
    ax[0].imshow(original, cmap='gray')
    ax[0].set_title('1. Original Image')
    ax[0].axis('off')

    # Plot 2: Binary Image
    ax[1].imshow(binary, cmap='gray')
    ax[1].set_title('2. Binary Image')
    ax[1].axis('off')

    # Plot 3: Skeleton
    ax[2].imshow(skeleton, cmap='gray')
    ax[2].set_title('3. Skeleton (1px)')
    ax[2].axis('off')

    # Plot 4: Archaeological element classification
    ax[3].imshow(original, cmap='gray')
    
    # Count elements
    n_lines = len(classified_elements['lines'])
    n_dotted_graph = len(classified_elements['dotted_points'])
    n_dotted_separate = len(classified_elements.get('dotted_points_separate', []))
    n_painted_graph = len(classified_elements['painted_decorations'])
    n_painted_separate = len(classified_elements.get('painted_decorations_separate', []))
    
    total_dots = n_dotted_graph + n_dotted_separate
    total_decorations = n_painted_graph + n_painted_separate
    ax[3].set_title(f'4. Classification: Lines({n_lines}) Points({total_dots}) Decorations({total_decorations})')
    ax[3].axis('off')
    
    # Visualize lines in BLUE
    for i, (s, e, path_pixels) in enumerate(classified_elements['lines']):
        ax[3].plot(path_pixels[:, 1], path_pixels[:, 0], 'b-', linewidth=1.5, alpha=0.8, label='Lines' if i == 0 else "")
    
    # Visualize dotted pattern in RED (as points)
    for i, (s, e, path_pixels) in enumerate(classified_elements['dotted_points']):
        center_idx = len(path_pixels) // 2
        y, x = path_pixels[center_idx][0], path_pixels[center_idx][1]
        ax[3].plot(x, y, 'ro', markersize=3, alpha=0.8, label='Points' if i == 0 else "")
    
    # Visualize separated dotted points (found before skeletonization) in RED
    for i, (center_y, center_x, radius) in enumerate(classified_elements.get('dotted_points_separate', [])):
        ax[3].plot(center_x, center_y, 'ro', markersize=4, alpha=1.0, label='Separated points' if i == 0 else "")
    
    # Visualize painted decorations in YELLOW (as contours)
    for i, contour_points in enumerate(classified_elements['painted_decorations']):
        if len(contour_points) > 2:
            # Visualize as closed contour
            ax[3].plot(contour_points[:, 1], contour_points[:, 0], 'y-', linewidth=2, alpha=0.8, label='Contours' if i == 0 else "")
    
    # Visualize separated decorations (extracted from original image) in ORANGE
    for i, contour_points in enumerate(classified_elements.get('painted_decorations_separate', [])):
        if len(contour_points) > 2:
            ax[3].plot(contour_points[:, 1], contour_points[:, 0], 'orange', linewidth=2, alpha=0.8, label='Separated decorations' if i == 0 else "")

    plt.tight_layout()
    plt.savefig('diagnostic_plots.png', dpi=150)  # Save with better quality


if __name__ == "__main__":
    # Example usage with customizable parameters
    result_stats = vectorize_archaeological_drawing(
        image_path="prova.jpg",
        output_svg_path="archaeological_vectorized.svg",
        output_jpg_path="archaeological_comparison.jpg",
        binary_threshold=15,           # Sensitivity for shadow detection
        epsilon=5,                     # RDP simplification strength (higher = more simplified)
        smoothing_factor=0.4,          # Bézier curve smoothing
        min_dotted_area=5,             # Min area for dotted points
        max_dotted_area=200,           # Max area for dotted points
        dotted_circularity=0.6,        # Min circularity for dotted points
        dark_threshold=100,            # Threshold for finding dark decorations
        min_decoration_area=1000,      # Min area for painted decorations
        show_debug_plots=True,         # Show matplotlib plots
        save_debug_images=True,        # Save diagnostic_plots.png and skeleton_debug.png
        include_background_image=False # Set to True to include original image as background in SVG
    )
    
    print(f"\nProcessing completed successfully!")
    print(f"Results: {result_stats}")