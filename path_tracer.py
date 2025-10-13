"""
Intelligent Path Tracing for Archaeological Drawings

Instead of using sknw which creates many small disconnected segments,
this module implements a smart path tracing algorithm that:
1. Follows the main paths in the skeleton
2. Filters out spurious branches during tracing
3. Creates long, clean curves instead of fragmented segments
"""

import numpy as np
from scipy import ndimage
from typing import List, Tuple, Set
import cv2


def get_neighbors_8(y: int, x: int, shape: Tuple[int, int]) -> List[Tuple[int, int]]:
    """Get 8-connected neighbors of a pixel."""
    neighbors = []
    for dy in [-1, 0, 1]:
        for dx in [-1, 0, 1]:
            if dy == 0 and dx == 0:
                continue
            ny, nx = y + dy, x + dx
            if 0 <= ny < shape[0] and 0 <= nx < shape[1]:
                neighbors.append((ny, nx))
    return neighbors


def count_skeleton_neighbors(skeleton: np.ndarray, y: int, x: int) -> int:
    """Count how many skeleton pixels are neighbors of (y, x)."""
    count = 0
    for ny, nx in get_neighbors_8(y, x, skeleton.shape):
        if skeleton[ny, nx] > 0:
            count += 1
    return count


def find_endpoints_and_junctions(skeleton: np.ndarray) -> Tuple[List[Tuple[int, int]], List[Tuple[int, int]]]:
    """
    Find endpoints (degree 1) and junctions (degree >= 3) in skeleton.
    
    Returns:
        endpoints: List of (y, x) coordinates with 1 neighbor
        junctions: List of (y, x) coordinates with >= 3 neighbors
    """
    endpoints = []
    junctions = []
    
    # Find all skeleton pixels
    skeleton_pixels = np.argwhere(skeleton > 0)
    
    for y, x in skeleton_pixels:
        n_neighbors = count_skeleton_neighbors(skeleton, y, x)
        
        if n_neighbors == 1:
            endpoints.append((y, x))
        elif n_neighbors >= 3:
            junctions.append((y, x))
    
    return endpoints, junctions


def trace_path_from_point(skeleton: np.ndarray, 
                          start: Tuple[int, int], 
                          visited: Set[Tuple[int, int]],
                          original_gray: np.ndarray = None,
                          max_branch_depth: int = 5) -> List[Tuple[int, int]]:
    """
    Trace a path from a starting point, following the skeleton.
    Stops at junctions, endpoints, or visited pixels.
    Prefers paths with darker/more intense lines in original grayscale image.
    
    Args:
        skeleton: Binary skeleton image
        start: Starting point (y, x)
        visited: Set of already visited points
        original_gray: Original GRAYSCALE image (darker = stronger line)
        max_branch_depth: Maximum depth to follow a branch before considering it spurious
        
    Returns:
        List of points forming the path
    """
    if start in visited:
        return []  # Already traced from here
    
    path = [start]
    visited.add(start)
    current = start
    
    while True:
        # Get unvisited skeleton neighbors
        neighbors = []
        for ny, nx in get_neighbors_8(current[0], current[1], skeleton.shape):
            if skeleton[ny, nx] > 0 and (ny, nx) not in visited:
                neighbors.append((ny, nx))
        
        if len(neighbors) == 0:
            # Dead end - path complete
            break
        
        if len(neighbors) == 1:
            # Simple continuation - follow it
            current = neighbors[0]
            path.append(current)
            visited.add(current)
        else:
            # Junction - choose best neighbor based on direction continuity AND line intensity
            if len(path) < 2:
                # No direction yet - choose based on line intensity if available
                if original_gray is not None:
                    best_neighbor = None
                    best_intensity = -1
                    
                    for ny, nx in neighbors:
                        # Check line intensity: LOWER values = DARKER = STRONGER line
                        # Sample along a small region around this pixel
                        y_start, y_end = max(0, ny-2), min(original_gray.shape[0], ny+3)
                        x_start, x_end = max(0, nx-2), min(original_gray.shape[1], nx+3)
                        window = original_gray[y_start:y_end, x_start:x_end]
                        # Invert: darker pixels have LOWER values, we want HIGHER score for dark
                        intensity = 255 - np.mean(window)  # Higher = darker line
                        
                        if intensity > best_intensity:
                            best_intensity = intensity
                            best_neighbor = (ny, nx)
                    
                    current = best_neighbor if best_neighbor else neighbors[0]
                else:
                    current = neighbors[0]
            else:
                # Choose neighbor that continues in same direction AND follows darker lines
                prev_dir = (path[-1][0] - path[-2][0], path[-1][1] - path[-2][1])
                
                best_neighbor = None
                best_score = -10000
                
                for ny, nx in neighbors:
                    new_dir = (ny - current[0], nx - current[1])
                    
                    # 1. Direction continuity (dot product)
                    direction_score = prev_dir[0] * new_dir[0] + prev_dir[1] * new_dir[1]
                    direction_score *= 30  # Reduced weight - let intensity dominate
                    
                    # 2. Line intensity score - look VERY FAR ahead in this direction
                    intensity_score = 0
                    if original_gray is not None:
                        # Look ahead up to 100 pixels to see line quality!
                        samples = []
                        for step in range(1, 501):  # AUMENTATO da 6 a 101!
                            look_y = ny + new_dir[0] * step
                            look_x = nx + new_dir[1] * step
                            if 0 <= look_y < original_gray.shape[0] and 0 <= look_x < original_gray.shape[1]:
                                # Darker = stronger line, invert to get higher score for dark
                                pixel_intensity = 255 - original_gray[look_y, look_x]
                                # Weight closer pixels more (exponential decay)
                                weight = 1.0 / (1.0 + step * 0.01)  # Decay slowly
                                samples.append(pixel_intensity * weight)
                        
                        if samples:
                            # MASSIVE weight on intensity - this DOMINATES the decision!
                            intensity_score = np.sum(samples) * 2  # Sum instead of mean for longer paths
                    
                    # 3. Branch penalty - avoid highly branched areas
                    n_future_neighbors = count_skeleton_neighbors(skeleton, ny, nx)
                    branch_penalty = 0
                    if n_future_neighbors >= 4:
                        branch_penalty = -2000  # EVEN HEAVIER penalty for branched areas
                    elif n_future_neighbors >= 3:
                        branch_penalty = -500  # Heavier penalty for junctions
                    
                    # Combined score
                    total_score = direction_score + intensity_score + branch_penalty
                    
                    if total_score > best_score:
                        best_score = total_score
                        best_neighbor = (ny, nx)
                
                if best_neighbor is None:
                    break
                
                current = best_neighbor
            
            path.append(current)
            visited.add(current)
            
            # Check if we've hit a junction
            n_neighbors_at_current = count_skeleton_neighbors(skeleton, current[0], current[1])
            if n_neighbors_at_current >= 3:
                # Stop at junction
                break
    
    return path


def extract_main_paths(skeleton: np.ndarray, 
                      original_gray: np.ndarray = None,
                      min_path_length: int = 20,
                      max_branch_depth: int = 5) -> List[np.ndarray]:
    """
    Extract main paths from skeleton using intelligent tracing.
    
    This is the main algorithm that replaces sknw.
    
    Args:
        skeleton: Binary skeleton image (uint8)
        original_gray: Original GRAYSCALE image (darker pixels = stronger lines)
        min_path_length: Minimum length for a valid path
        max_branch_depth: Maximum depth for branch exploration
        
    Returns:
        List of paths, each path is np.array of shape (N, 2) with (y, x) coordinates
    """
    print(f"Extracting main paths from skeleton...")
    
    # Convert to binary
    skeleton_binary = skeleton > 0
    
    # Find endpoints and junctions
    endpoints, junctions = find_endpoints_and_junctions(skeleton_binary)
    
    print(f"  Found {len(endpoints)} endpoints and {len(junctions)} junctions")
    
    # Track visited pixels globally
    visited = set()
    paths = []
    
    # Priority 1: Trace from endpoints (these give the cleanest paths)
    print(f"  Tracing from endpoints...")
    for endpoint in endpoints:
        if endpoint not in visited:
            path = trace_path_from_point(skeleton_binary, endpoint, visited, original_gray, max_branch_depth)
            if len(path) >= min_path_length:
                paths.append(np.array(path))
    
    print(f"  Found {len(paths)} paths from endpoints")
    
    # Priority 2: Trace from junctions to connect remaining segments
    print(f"  Tracing from junctions...")
    initial_path_count = len(paths)
    for junction in junctions:
        # Try tracing in each direction from junction
        for neighbor in get_neighbors_8(junction[0], junction[1], skeleton_binary.shape):
            if skeleton_binary[neighbor[0], neighbor[1]] and neighbor not in visited:
                path = trace_path_from_point(skeleton_binary, neighbor, visited, original_gray, max_branch_depth)
                if len(path) >= min_path_length:
                    # Add junction point at the beginning
                    full_path = [junction] + path
                    paths.append(np.array(full_path))
    
    print(f"  Found {len(paths) - initial_path_count} additional paths from junctions")
    
    # Priority 3: Sweep remaining unvisited pixels (rare, but catches any missed segments)
    print(f"  Sweeping for remaining segments...")
    skeleton_pixels = np.argwhere(skeleton_binary)
    initial_path_count = len(paths)
    
    for y, x in skeleton_pixels:
        if (y, x) not in visited:
            path = trace_path_from_point(skeleton_binary, (y, x), visited, original_gray, max_branch_depth)
            if len(path) >= min_path_length:
                paths.append(np.array(path))
    
    print(f"  Found {len(paths) - initial_path_count} additional segments")
    print(f"  Total paths extracted: {len(paths)}")
    
    # Remove duplicate paths (same path traced in both directions)
    print(f"  Removing duplicate paths...")
    unique_paths = remove_duplicate_paths(paths)
    print(f"  After duplicate removal: {len(unique_paths)} unique paths")
    
    # Filter out very short paths (likely spurious branches)
    filtered_paths = [p for p in unique_paths if len(p) >= min_path_length]
    print(f"  After filtering (min_length={min_path_length}): {len(filtered_paths)} paths")
    
    return filtered_paths


def remove_duplicate_paths(paths: List[np.ndarray], tolerance: float = 3.0) -> List[np.ndarray]:
    """
    Remove duplicate paths (paths that are the same but traced in opposite directions).
    
    Args:
        paths: List of paths to deduplicate
        tolerance: Maximum distance between path endpoints to consider them duplicates
        
    Returns:
        List of unique paths
    """
    if len(paths) == 0:
        return paths
    
    unique = []
    
    for i, path1 in enumerate(paths):
        is_duplicate = False
        
        # Check against already added unique paths
        for path2 in unique:
            # Check if path1 is the reverse of path2
            # Compare endpoints: path1.start ≈ path2.end AND path1.end ≈ path2.start
            if len(path1) > 0 and len(path2) > 0:
                # Distance between start of path1 and end of path2
                dist_start_end = np.linalg.norm(path1[0] - path2[-1])
                # Distance between end of path1 and start of path2
                dist_end_start = np.linalg.norm(path1[-1] - path2[0])
                
                # Also check if they're the exact same path
                dist_start_start = np.linalg.norm(path1[0] - path2[0])
                dist_end_end = np.linalg.norm(path1[-1] - path2[-1])
                
                # Reverse duplicate: starts/ends swapped
                if dist_start_end < tolerance and dist_end_start < tolerance:
                    is_duplicate = True
                    break
                
                # Exact duplicate: same start and end
                if dist_start_start < tolerance and dist_end_end < tolerance and len(path1) == len(path2):
                    is_duplicate = True
                    break
        
        if not is_duplicate:
            unique.append(path1)
    
    return unique


def smooth_path(path: np.ndarray, window_size: int = 5) -> np.ndarray:
    """
    Smooth a path using moving average.
    
    Args:
        path: Array of shape (N, 2) with (y, x) coordinates
        window_size: Size of smoothing window
        
    Returns:
        Smoothed path of same shape
    """
    if len(path) < window_size:
        return path
    
    smoothed = path.copy().astype(float)
    
    for i in range(len(path)):
        start = max(0, i - window_size // 2)
        end = min(len(path), i + window_size // 2 + 1)
        smoothed[i] = np.mean(path[start:end], axis=0)
    
    return smoothed.astype(int)


def visualize_paths(original: np.ndarray, paths: List[np.ndarray], output_path: str):
    """
    Visualize extracted paths on original image.
    
    Args:
        original: Original grayscale image
        paths: List of paths to visualize
        output_path: Where to save the visualization
    """
    debug_img = cv2.cvtColor(original, cv2.COLOR_GRAY2BGR)
    
    # Draw each path in a different color (cycling through colors)
    colors = [
        (255, 0, 0),    # Blue
        (0, 255, 0),    # Green
        (0, 0, 255),    # Red
        (255, 255, 0),  # Cyan
        (255, 0, 255),  # Magenta
        (0, 255, 255),  # Yellow
    ]
    
    for idx, path in enumerate(paths):
        color = colors[idx % len(colors)]
        
        # Draw path
        for i in range(len(path) - 1):
            y1, x1 = path[i]
            y2, x2 = path[i + 1]
            cv2.line(debug_img, (x1, y1), (x2, y2), color, 2)
        
        # Mark endpoints
        if len(path) > 0:
            y, x = path[0]
            cv2.circle(debug_img, (x, y), 5, (0, 255, 0), -1)  # Green start
            y, x = path[-1]
            cv2.circle(debug_img, (x, y), 5, (0, 0, 255), -1)  # Red end
    
    cv2.imwrite(output_path, debug_img)
    print(f"Saved path visualization to {output_path}")
