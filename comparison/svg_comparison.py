#!/usr/bin/env python3
"""
SVG Comparison Script for PyPotteryTrace Evaluation
Compares manual traced SVGs with automatically traced SVGs.

Metrics implemented:
- Hausdorff Distance: Maximum distance from any point in one curve to the closest point in the other
- Fréchet Distance: "Dog-walking" distance that respects the ordering of points
- Mean Point Distance: Average distance between corresponding points
- Endpoint Preservation Error: How well the endpoints are preserved
"""

import os
import re
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path
from xml.etree import ElementTree as ET
from dataclasses import dataclass
from typing import List, Tuple, Optional
import json
from datetime import datetime

# Try to use svgpathtools for robust parsing, fall back to manual parser
try:
    from svgpathtools import svg2paths, parse_path
    HAS_SVGPATHTOOLS = True
except ImportError:
    HAS_SVGPATHTOOLS = False
    print("Note: svgpathtools not installed. Using built-in parser.")


@dataclass
class ComparisonResult:
    """Stores comparison results for a single SVG pair."""
    filename: str
    hausdorff_distance: float
    frechet_distance: float
    mean_point_distance: float
    endpoint_error_start: float
    endpoint_error_end: float
    manual_points_count: int
    trace_points_count: int


def sample_path_svgpathtools(svg_path: str, num_samples: int = 200) -> np.ndarray:
    """
    Use svgpathtools to robustly parse and sample an SVG path.
    This handles all SVG path commands correctly including relative coordinates.
    """
    try:
        paths, attributes = svg2paths(svg_path)
        
        if not paths:
            return np.array([[0, 0]])
        
        all_points = []
        
        for path in paths:
            if len(path) == 0:
                continue
                
            # Get total length for even sampling
            total_length = path.length()
            if total_length == 0:
                continue
                
            # Sample points along the path
            for i in range(num_samples):
                t = i / (num_samples - 1) if num_samples > 1 else 0
                try:
                    point = path.point(t)
                    all_points.append((point.real, point.imag))
                except:
                    continue
        
        if not all_points:
            return np.array([[0, 0]])
            
        return np.array(all_points)
        
    except Exception as e:
        print(f"Error parsing {svg_path} with svgpathtools: {e}")
        return np.array([[0, 0]])


def parse_svg_path_manual(path_data: str) -> np.ndarray:
    """
    Parse SVG path data manually.
    Handles M, L, C, S, Q, T, Z commands and their lowercase (relative) versions.
    """
    points = []
    current_x, current_y = 0.0, 0.0
    start_x, start_y = 0.0, 0.0
    last_control_x, last_control_y = 0.0, 0.0
    last_command = None
    
    # Tokenize the path data
    # Add spaces around commands for easier splitting
    path_data = re.sub(r'([MmLlHhVvCcSsQqTtAaZz])', r' \1 ', path_data)
    # Handle negative numbers (they can appear without separator)
    path_data = re.sub(r'(?<=\d)-', ' -', path_data)
    # Replace commas with spaces
    path_data = re.sub(r',', ' ', path_data)
    
    tokens = path_data.split()
    i = 0
    current_command = None
    
    def get_numbers(count):
        nonlocal i
        nums = []
        while len(nums) < count and i < len(tokens):
            try:
                nums.append(float(tokens[i]))
                i += 1
            except ValueError:
                break
        return nums
    
    while i < len(tokens):
        token = tokens[i]
        
        if token in 'MmLlHhVvCcSsQqTtAaZz':
            current_command = token
            i += 1
            continue
        
        if current_command is None:
            i += 1
            continue
        
        try:
            if current_command == 'M':
                nums = get_numbers(2)
                if len(nums) == 2:
                    current_x, current_y = nums
                    start_x, start_y = current_x, current_y
                    points.append((current_x, current_y))
                    current_command = 'L'  # Implicit line-to after moveto
                    
            elif current_command == 'm':
                nums = get_numbers(2)
                if len(nums) == 2:
                    current_x += nums[0]
                    current_y += nums[1]
                    start_x, start_y = current_x, current_y
                    points.append((current_x, current_y))
                    current_command = 'l'
                    
            elif current_command == 'L':
                nums = get_numbers(2)
                if len(nums) == 2:
                    current_x, current_y = nums
                    points.append((current_x, current_y))
                    
            elif current_command == 'l':
                nums = get_numbers(2)
                if len(nums) == 2:
                    current_x += nums[0]
                    current_y += nums[1]
                    points.append((current_x, current_y))
                    
            elif current_command == 'H':
                nums = get_numbers(1)
                if len(nums) == 1:
                    current_x = nums[0]
                    points.append((current_x, current_y))
                    
            elif current_command == 'h':
                nums = get_numbers(1)
                if len(nums) == 1:
                    current_x += nums[0]
                    points.append((current_x, current_y))
                    
            elif current_command == 'V':
                nums = get_numbers(1)
                if len(nums) == 1:
                    current_y = nums[0]
                    points.append((current_x, current_y))
                    
            elif current_command == 'v':
                nums = get_numbers(1)
                if len(nums) == 1:
                    current_y += nums[0]
                    points.append((current_x, current_y))
                    
            elif current_command == 'C':
                nums = get_numbers(6)
                if len(nums) == 6:
                    x1, y1, x2, y2, end_x, end_y = nums
                    # Sample the cubic bezier
                    for t in np.linspace(0, 1, 15)[1:]:
                        bx = (1-t)**3 * current_x + 3*(1-t)**2*t * x1 + 3*(1-t)*t**2 * x2 + t**3 * end_x
                        by = (1-t)**3 * current_y + 3*(1-t)**2*t * y1 + 3*(1-t)*t**2 * y2 + t**3 * end_y
                        points.append((bx, by))
                    last_control_x, last_control_y = x2, y2
                    current_x, current_y = end_x, end_y
                    
            elif current_command == 'c':
                nums = get_numbers(6)
                if len(nums) == 6:
                    x1 = current_x + nums[0]
                    y1 = current_y + nums[1]
                    x2 = current_x + nums[2]
                    y2 = current_y + nums[3]
                    end_x = current_x + nums[4]
                    end_y = current_y + nums[5]
                    for t in np.linspace(0, 1, 15)[1:]:
                        bx = (1-t)**3 * current_x + 3*(1-t)**2*t * x1 + 3*(1-t)*t**2 * x2 + t**3 * end_x
                        by = (1-t)**3 * current_y + 3*(1-t)**2*t * y1 + 3*(1-t)*t**2 * y2 + t**3 * end_y
                        points.append((bx, by))
                    last_control_x, last_control_y = x2, y2
                    current_x, current_y = end_x, end_y
                    
            elif current_command == 'S':
                nums = get_numbers(4)
                if len(nums) == 4:
                    # Reflect last control point
                    x1 = 2 * current_x - last_control_x
                    y1 = 2 * current_y - last_control_y
                    x2, y2, end_x, end_y = nums
                    for t in np.linspace(0, 1, 15)[1:]:
                        bx = (1-t)**3 * current_x + 3*(1-t)**2*t * x1 + 3*(1-t)*t**2 * x2 + t**3 * end_x
                        by = (1-t)**3 * current_y + 3*(1-t)**2*t * y1 + 3*(1-t)*t**2 * y2 + t**3 * end_y
                        points.append((bx, by))
                    last_control_x, last_control_y = x2, y2
                    current_x, current_y = end_x, end_y
                    
            elif current_command == 's':
                nums = get_numbers(4)
                if len(nums) == 4:
                    # Reflect last control point (relative)
                    x1 = 2 * current_x - last_control_x
                    y1 = 2 * current_y - last_control_y
                    x2 = current_x + nums[0]
                    y2 = current_y + nums[1]
                    end_x = current_x + nums[2]
                    end_y = current_y + nums[3]
                    for t in np.linspace(0, 1, 15)[1:]:
                        bx = (1-t)**3 * current_x + 3*(1-t)**2*t * x1 + 3*(1-t)*t**2 * x2 + t**3 * end_x
                        by = (1-t)**3 * current_y + 3*(1-t)**2*t * y1 + 3*(1-t)*t**2 * y2 + t**3 * end_y
                        points.append((bx, by))
                    last_control_x, last_control_y = x2, y2
                    current_x, current_y = end_x, end_y
                    
            elif current_command == 'Q':
                nums = get_numbers(4)
                if len(nums) == 4:
                    x1, y1, end_x, end_y = nums
                    for t in np.linspace(0, 1, 15)[1:]:
                        bx = (1-t)**2 * current_x + 2*(1-t)*t * x1 + t**2 * end_x
                        by = (1-t)**2 * current_y + 2*(1-t)*t * y1 + t**2 * end_y
                        points.append((bx, by))
                    last_control_x, last_control_y = x1, y1
                    current_x, current_y = end_x, end_y
                    
            elif current_command == 'q':
                nums = get_numbers(4)
                if len(nums) == 4:
                    x1 = current_x + nums[0]
                    y1 = current_y + nums[1]
                    end_x = current_x + nums[2]
                    end_y = current_y + nums[3]
                    for t in np.linspace(0, 1, 15)[1:]:
                        bx = (1-t)**2 * current_x + 2*(1-t)*t * x1 + t**2 * end_x
                        by = (1-t)**2 * current_y + 2*(1-t)*t * y1 + t**2 * end_y
                        points.append((bx, by))
                    last_control_x, last_control_y = x1, y1
                    current_x, current_y = end_x, end_y
                    
            elif current_command in 'Zz':
                current_x, current_y = start_x, start_y
                # Don't add closing point to avoid closing the path visually
                last_command = current_command
                current_command = None
                
            else:
                i += 1
                
            last_command = current_command
                
        except Exception as e:
            i += 1
            continue
    
    return np.array(points) if points else np.array([[0, 0]])


def apply_transform(points: np.ndarray, transform_str: str) -> np.ndarray:
    """Apply SVG transform string to points."""
    if not transform_str or len(points) == 0:
        return points
    
    result = points.copy()
    
    # Parse transform(s)
    transforms = re.findall(r'(\w+)\(([^)]+)\)', transform_str)
    
    for transform_type, values in transforms:
        nums = [float(x) for x in re.findall(r'[-+]?\d*\.?\d+', values)]
        
        if transform_type == 'translate':
            tx = nums[0] if len(nums) > 0 else 0
            ty = nums[1] if len(nums) > 1 else 0
            result = result + np.array([tx, ty])
            
        elif transform_type == 'scale':
            sx = nums[0] if len(nums) > 0 else 1
            sy = nums[1] if len(nums) > 1 else sx
            result = result * np.array([sx, sy])
            
        elif transform_type == 'rotate':
            angle = np.radians(nums[0]) if len(nums) > 0 else 0
            cx = nums[1] if len(nums) > 1 else 0
            cy = nums[2] if len(nums) > 2 else 0
            # Translate to origin, rotate, translate back
            result = result - np.array([cx, cy])
            cos_a, sin_a = np.cos(angle), np.sin(angle)
            rotation = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
            result = result @ rotation.T
            result = result + np.array([cx, cy])
            
        elif transform_type == 'matrix':
            if len(nums) >= 6:
                a, b, c, d, e, f = nums[:6]
                # Apply affine transform: [a c e; b d f; 0 0 1]
                new_result = np.zeros_like(result)
                new_result[:, 0] = a * result[:, 0] + c * result[:, 1] + e
                new_result[:, 1] = b * result[:, 0] + d * result[:, 1] + f
                result = new_result
    
    return result


def extract_points_from_svg(svg_path: str, use_svgpathtools: bool = True) -> np.ndarray:
    """Extract all path points from an SVG file."""
    
    # Try svgpathtools first (more reliable)
    if HAS_SVGPATHTOOLS and use_svgpathtools:
        points = sample_path_svgpathtools(svg_path)
        if len(points) > 1:
            return points
    
    # Fall back to manual parsing
    try:
        tree = ET.parse(svg_path)
        root = tree.getroot()
        
        all_points = []
        
        # Find all path elements (handle namespaced and non-namespaced)
        def find_paths(element, parent_transform=""):
            # Get this element's transform
            elem_transform = element.get('transform', '')
            combined_transform = f"{parent_transform} {elem_transform}".strip()
            
            for child in element:
                tag = child.tag.split('}')[-1]  # Remove namespace
                
                if tag == 'path':
                    d = child.get('d')
                    if d:
                        points = parse_svg_path_manual(d)
                        
                        # Apply transforms
                        path_transform = child.get('transform', '')
                        full_transform = f"{combined_transform} {path_transform}".strip()
                        if full_transform:
                            points = apply_transform(points, full_transform)
                        
                        all_points.extend(points.tolist())
                else:
                    find_paths(child, combined_transform)
        
        find_paths(root)
        
        if not all_points:
            return np.array([[0, 0]])
            
        return np.array(all_points)
        
    except Exception as e:
        print(f"Error parsing {svg_path}: {e}")
        return np.array([[0, 0]])


def normalize_points(points: np.ndarray) -> np.ndarray:
    """Normalize points to [0, 1] range based on bounding box."""
    if len(points) < 2:
        return points
        
    min_vals = points.min(axis=0)
    max_vals = points.max(axis=0)
    
    range_vals = max_vals - min_vals
    range_vals[range_vals == 0] = 1
    
    return (points - min_vals) / range_vals


def resample_points(points: np.ndarray, n_points: int = 100) -> np.ndarray:
    """Resample a path to have exactly n_points evenly spaced points."""
    if len(points) < 2:
        return np.zeros((n_points, 2))
        
    # Calculate cumulative arc length
    diffs = np.diff(points, axis=0)
    segment_lengths = np.sqrt((diffs ** 2).sum(axis=1))
    cumulative = np.zeros(len(points))
    cumulative[1:] = np.cumsum(segment_lengths)
    
    total_length = cumulative[-1]
    if total_length == 0:
        return np.tile(points[0], (n_points, 1))
    
    # Normalize to [0, 1]
    cumulative /= total_length
    
    # Interpolate
    target_t = np.linspace(0, 1, n_points)
    new_x = np.interp(target_t, cumulative, points[:, 0])
    new_y = np.interp(target_t, cumulative, points[:, 1])
    
    return np.column_stack([new_x, new_y])


def hausdorff_distance(points1: np.ndarray, points2: np.ndarray) -> float:
    """Calculate the Hausdorff distance between two point sets."""
    def directed_hausdorff(a, b):
        if len(a) == 0 or len(b) == 0:
            return 0
        min_distances = []
        for p in a:
            distances = np.linalg.norm(b - p, axis=1)
            min_distances.append(np.min(distances))
        return np.max(min_distances)
    
    return max(directed_hausdorff(points1, points2), 
               directed_hausdorff(points2, points1))


def frechet_distance(points1: np.ndarray, points2: np.ndarray) -> float:
    """Calculate the discrete Fréchet distance using dynamic programming."""
    n, m = len(points1), len(points2)
    
    if n == 0 or m == 0:
        return float('inf')
    
    # Build distance matrix
    dist = np.zeros((n, m))
    for i in range(n):
        for j in range(m):
            dist[i, j] = np.linalg.norm(points1[i] - points2[j])
    
    # DP
    ca = np.full((n, m), -1.0)
    
    for i in range(n):
        for j in range(m):
            if i == 0 and j == 0:
                ca[i, j] = dist[0, 0]
            elif i > 0 and j == 0:
                ca[i, j] = max(ca[i-1, 0], dist[i, 0])
            elif i == 0 and j > 0:
                ca[i, j] = max(ca[0, j-1], dist[0, j])
            else:
                ca[i, j] = max(
                    min(ca[i-1, j], ca[i-1, j-1], ca[i, j-1]),
                    dist[i, j]
                )
    
    return ca[n-1, m-1]


def mean_point_distance(points1: np.ndarray, points2: np.ndarray) -> float:
    """Calculate the mean distance between corresponding resampled points."""
    if len(points1) != len(points2):
        n = min(len(points1), len(points2))
        points1 = resample_points(points1, n)
        points2 = resample_points(points2, n)
    
    distances = np.linalg.norm(points1 - points2, axis=1)
    return np.mean(distances)


def endpoint_preservation_error(points1: np.ndarray, points2: np.ndarray) -> Tuple[float, float]:
    """Calculate error in preserving start and end points."""
    start_error = np.linalg.norm(points1[0] - points2[0])
    end_error = np.linalg.norm(points1[-1] - points2[-1])
    return start_error, end_error


def compare_svg_pair(manual_path: str, trace_path: str, n_resample: int = 100) -> ComparisonResult:
    """Compare a pair of SVG files and return all metrics."""
    filename = os.path.basename(manual_path)
    
    # Extract points
    manual_points = extract_points_from_svg(manual_path)
    trace_points = extract_points_from_svg(trace_path)
    
    manual_count = len(manual_points)
    trace_count = len(trace_points)
    
    # Normalize to same scale
    manual_norm = normalize_points(manual_points)
    trace_norm = normalize_points(trace_points)
    
    # Resample for fair comparison
    manual_resampled = resample_points(manual_norm, n_resample)
    trace_resampled = resample_points(trace_norm, n_resample)
    
    # Calculate metrics
    hausdorff = hausdorff_distance(manual_resampled, trace_resampled)
    frechet = frechet_distance(manual_resampled, trace_resampled)
    mean_dist = mean_point_distance(manual_resampled, trace_resampled)
    start_err, end_err = endpoint_preservation_error(manual_resampled, trace_resampled)
    
    return ComparisonResult(
        filename=filename,
        hausdorff_distance=hausdorff,
        frechet_distance=frechet,
        mean_point_distance=mean_dist,
        endpoint_error_start=start_err,
        endpoint_error_end=end_err,
        manual_points_count=manual_count,
        trace_points_count=trace_count
    )


def create_visual_comparison(manual_path: str, trace_path: str, 
                             output_path: str, result: ComparisonResult):
    """Create a visual comparison plot of two SVG paths."""
    manual_points = extract_points_from_svg(manual_path)
    trace_points = extract_points_from_svg(trace_path)
    
    manual_norm = normalize_points(manual_points)
    trace_norm = normalize_points(trace_points)
    
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    
    # Plot 1: Manual trace
    axes[0].plot(manual_norm[:, 0], manual_norm[:, 1], 'b-', linewidth=2)
    axes[0].scatter([manual_norm[0, 0]], [manual_norm[0, 1]], c='green', s=100, zorder=5, label='Start')
    axes[0].scatter([manual_norm[-1, 0]], [manual_norm[-1, 1]], c='red', s=100, zorder=5, label='End')
    axes[0].set_title('Manual Trace', fontsize=12, fontweight='bold')
    axes[0].set_aspect('equal')
    axes[0].invert_yaxis()
    axes[0].legend(loc='lower right')
    axes[0].grid(True, alpha=0.3)
    
    # Plot 2: Automatic trace
    axes[1].plot(trace_norm[:, 0], trace_norm[:, 1], 'r-', linewidth=2)
    axes[1].scatter([trace_norm[0, 0]], [trace_norm[0, 1]], c='green', s=100, zorder=5, label='Start')
    axes[1].scatter([trace_norm[-1, 0]], [trace_norm[-1, 1]], c='red', s=100, zorder=5, label='End')
    axes[1].set_title('Automatic Trace\n(PyPotteryTrace)', fontsize=12, fontweight='bold')
    axes[1].set_aspect('equal')
    axes[1].invert_yaxis()
    axes[1].legend(loc='lower right')
    axes[1].grid(True, alpha=0.3)
    
    # Plot 3: Overlay
    axes[2].plot(manual_norm[:, 0], manual_norm[:, 1], 'b-', linewidth=2, alpha=0.8, label='Manual')
    axes[2].plot(trace_norm[:, 0], trace_norm[:, 1], 'r--', linewidth=2, alpha=0.8, label='Automatic')
    axes[2].set_title('Overlay Comparison', fontsize=12, fontweight='bold')
    axes[2].set_aspect('equal')
    axes[2].invert_yaxis()
    axes[2].legend(loc='lower right')
    axes[2].grid(True, alpha=0.3)
    
    # Add metrics
    plt.suptitle(f'Comparison: {result.filename}', fontsize=14, fontweight='bold')
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()


def create_summary_plot(results: List[ComparisonResult], output_path: str):
    """Create a summary bar chart comparing all metrics."""
    filenames = [r.filename.replace('.svg', '') for r in results]
    
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    colors = plt.cm.viridis(np.linspace(0.2, 0.8, len(results)))
    
    # Hausdorff Distance
    hausdorff_vals = [r.hausdorff_distance for r in results]
    axes[0, 0].bar(filenames, hausdorff_vals, color=colors)
    axes[0, 0].set_title('Hausdorff Distance', fontsize=12, fontweight='bold')
    axes[0, 0].set_ylabel('Distance (normalized)')
    axes[0, 0].tick_params(axis='x', rotation=45)
    axes[0, 0].axhline(y=np.mean(hausdorff_vals), color='red', linestyle='--', 
                       label=f'Mean: {np.mean(hausdorff_vals):.4f}')
    axes[0, 0].legend()
    
    # Fréchet Distance
    frechet_vals = [r.frechet_distance for r in results]
    axes[0, 1].bar(filenames, frechet_vals, color=colors)
    axes[0, 1].set_title('Fréchet Distance', fontsize=12, fontweight='bold')
    axes[0, 1].set_ylabel('Distance (normalized)')
    axes[0, 1].tick_params(axis='x', rotation=45)
    axes[0, 1].axhline(y=np.mean(frechet_vals), color='red', linestyle='--',
                       label=f'Mean: {np.mean(frechet_vals):.4f}')
    axes[0, 1].legend()
    
    # Mean Point Distance
    mean_vals = [r.mean_point_distance for r in results]
    axes[1, 0].bar(filenames, mean_vals, color=colors)
    axes[1, 0].set_title('Mean Point Distance', fontsize=12, fontweight='bold')
    axes[1, 0].set_ylabel('Distance (normalized)')
    axes[1, 0].tick_params(axis='x', rotation=45)
    axes[1, 0].axhline(y=np.mean(mean_vals), color='red', linestyle='--',
                       label=f'Mean: {np.mean(mean_vals):.4f}')
    axes[1, 0].legend()
    
    # Endpoint Error
    x = np.arange(len(filenames))
    width = 0.35
    axes[1, 1].bar(x - width/2, [r.endpoint_error_start for r in results], width, 
                   label='Start Point', color='steelblue')
    axes[1, 1].bar(x + width/2, [r.endpoint_error_end for r in results], width, 
                   label='End Point', color='coral')
    axes[1, 1].set_title('Endpoint Preservation Error', fontsize=12, fontweight='bold')
    axes[1, 1].set_ylabel('Error (normalized)')
    axes[1, 1].set_xticks(x)
    axes[1, 1].set_xticklabels(filenames, rotation=45)
    axes[1, 1].legend()
    
    plt.suptitle('SVG Comparison Metrics Summary', fontsize=14, fontweight='bold')
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()


def generate_report(results: List[ComparisonResult], output_path: str):
    """Generate a markdown report."""
    report = []
    report.append("# SVG Comparison Report")
    report.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    report.append("")
    report.append("## Summary Statistics")
    report.append("")
    
    hausdorff_vals = [r.hausdorff_distance for r in results]
    frechet_vals = [r.frechet_distance for r in results]
    mean_vals = [r.mean_point_distance for r in results]
    start_vals = [r.endpoint_error_start for r in results]
    end_vals = [r.endpoint_error_end for r in results]
    
    report.append("| Metric | Mean | Std Dev | Min | Max |")
    report.append("|--------|------|---------|-----|-----|")
    report.append(f"| Hausdorff Distance | {np.mean(hausdorff_vals):.4f} | {np.std(hausdorff_vals):.4f} | {np.min(hausdorff_vals):.4f} | {np.max(hausdorff_vals):.4f} |")
    report.append(f"| Fréchet Distance | {np.mean(frechet_vals):.4f} | {np.std(frechet_vals):.4f} | {np.min(frechet_vals):.4f} | {np.max(frechet_vals):.4f} |")
    report.append(f"| Mean Point Distance | {np.mean(mean_vals):.4f} | {np.std(mean_vals):.4f} | {np.min(mean_vals):.4f} | {np.max(mean_vals):.4f} |")
    report.append(f"| Endpoint Error (Start) | {np.mean(start_vals):.4f} | {np.std(start_vals):.4f} | {np.min(start_vals):.4f} | {np.max(start_vals):.4f} |")
    report.append(f"| Endpoint Error (End) | {np.mean(end_vals):.4f} | {np.std(end_vals):.4f} | {np.min(end_vals):.4f} | {np.max(end_vals):.4f} |")
    report.append("")
    
    report.append("## Individual Results")
    report.append("")
    report.append("| File | Hausdorff | Fréchet | Mean Dist | Start Err | End Err |")
    report.append("|------|-----------|---------|-----------|-----------|---------|")
    
    for r in results:
        report.append(f"| {r.filename} | {r.hausdorff_distance:.4f} | {r.frechet_distance:.4f} | "
                     f"{r.mean_point_distance:.4f} | {r.endpoint_error_start:.4f} | {r.endpoint_error_end:.4f} |")
    
    report.append("")
    report.append("## Metric Descriptions")
    report.append("")
    report.append("- **Hausdorff Distance**: Maximum distance from any point on one curve to the nearest point on the other. Lower is better.")
    report.append("- **Fréchet Distance**: 'Dog-walking' distance that respects point ordering. Lower is better.")
    report.append("- **Mean Point Distance**: Average distance between corresponding points. Lower is better.")
    report.append("- **Endpoint Error**: How well start/end points are preserved. Lower is better.")
    report.append("")
    report.append("*All distances normalized to [0,1] range.*")
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(report))


def main():
    """Main function."""
    script_dir = Path(__file__).parent
    manual_dir = script_dir / "manual"
    trace_dir = script_dir / "trace"
    output_dir = script_dir / "results"
    
    output_dir.mkdir(exist_ok=True)
    
    print("=" * 60)
    print("SVG Comparison Tool for PyPotteryTrace")
    print("=" * 60)
    print()
    
    if HAS_SVGPATHTOOLS:
        print("✓ Using svgpathtools for robust SVG parsing")
    else:
        print("⚠ Using built-in parser (install svgpathtools for better results)")
    print()
    
    manual_files = sorted(manual_dir.glob("*.svg"))
    results = []
    
    print(f"Found {len(manual_files)} manual SVG files")
    print()
    
    for manual_file in manual_files:
        trace_file = trace_dir / manual_file.name
        
        if not trace_file.exists():
            print(f"⚠ No matching trace file for {manual_file.name}")
            continue
            
        print(f"Processing: {manual_file.name}")
        
        result = compare_svg_pair(str(manual_file), str(trace_file))
        results.append(result)
        
        visual_output = output_dir / f"comparison_{manual_file.stem}.png"
        create_visual_comparison(str(manual_file), str(trace_file), 
                                str(visual_output), result)
        print(f"  ✓ Visual saved: {visual_output.name}")
        print(f"    Hausdorff: {result.hausdorff_distance:.4f}, "
              f"Fréchet: {result.frechet_distance:.4f}, "
              f"Mean: {result.mean_point_distance:.4f}")
        print()
    
    if not results:
        print("No matching SVG pairs found!")
        return
    
    # Summary
    summary_path = output_dir / "summary_metrics.png"
    create_summary_plot(results, str(summary_path))
    print(f"✓ Summary plot: {summary_path}")
    
    report_path = output_dir / "comparison_report.md"
    generate_report(results, str(report_path))
    print(f"✓ Report: {report_path}")
    
    json_path = output_dir / "results.json"
    with open(json_path, 'w') as f:
        json.dump({
            "generated": datetime.now().isoformat(),
            "results": [vars(r) for r in results]
        }, f, indent=2)
    print(f"✓ JSON: {json_path}")
    
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Files compared: {len(results)}")
    print(f"Mean Hausdorff: {np.mean([r.hausdorff_distance for r in results]):.4f}")
    print(f"Mean Fréchet: {np.mean([r.frechet_distance for r in results]):.4f}")
    print(f"Mean Point Dist: {np.mean([r.mean_point_distance for r in results]):.4f}")


if __name__ == "__main__":
    main()
