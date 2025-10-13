#!/usr/bin/env python3
"""
PyPotteryTrace Interactive - Flask Application
Interactive segmentation-based vectorization with SAM2

Features:
- Interactive canvas for image loading and annotation
- SAM2 integration for precise segmentation (point/box prompts)
- Category assignment (Profile, Prospectus, Decoration, etc.)
- Rotation center definition with automatic mirroring
- Element-wise vectorization with existing engine
- SVG export with organized layers by category

Author: Lorenzo Cardarelli
Version: 0.1 Interactive
"""

from flask import Flask, render_template, request, jsonify, send_file, session
from flask_cors import CORS
from werkzeug.utils import secure_filename
import os
import json
import base64
from pathlib import Path
import uuid
from datetime import datetime

# Import SAM2 and processing modules
from sam2_handler import SAM2Handler
from vectorization_handler import VectorizationHandler

app = Flask(__name__)
app.config['SECRET_KEY'] = os.urandom(24)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max file size
app.config['ALLOWED_EXTENSIONS'] = {'png', 'jpg', 'jpeg', 'tiff', 'bmp'}

CORS(app)

# Global state for SAM2 handler
sam2_handler = SAM2Handler(model_size='small')  # Initialize immediately
vectorization_handler = VectorizationHandler()

# Store session data (in production, use Redis or database)
sessions_data = {}


def allowed_file(filename):
    """Check if file extension is allowed."""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in app.config['ALLOWED_EXTENSIONS']


@app.route('/')
def index():
    """Main application page."""
    return render_template('index.html')


@app.route('/api/load_model', methods=['POST'])
def load_model():
    """Load or change SAM2 model."""
    global sam2_handler
    
    data = request.json
    model_size = data.get('model_size', 'small')
    save_training_data = data.get('save_training_data', False)
    
    if model_size not in ['tiny', 'small', 'base', 'large']:
        return jsonify({'error': 'Invalid model size'}), 400
    
    try:
        # Reinitialize SAM2 handler with new model
        sam2_handler = SAM2Handler(model_size=model_size)
        
        # Store training data flag in app config (for future implementation)
        app.config['SAVE_TRAINING_DATA'] = save_training_data
        
        return jsonify({
            'success': True,
            'model_size': model_size,
            'save_training_data': save_training_data
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/generate_svg_preview', methods=['POST'])
def generate_svg_preview():
    """Generate SVG preview without downloading."""
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    session = sessions_data[session_id]
    
    # Debug: print what segments we're working with
    print(f"\n{'='*80}")
    print(f"GENERATE_SVG_PREVIEW - Starting export")
    print(f"Session has {len(session['segments'])} segments:")
    for i, seg in enumerate(session['segments']):
        print(f"  {i+1}. ID={seg['id']}, Name={seg['name']}, Category={seg['category']}")
    print(f"{'='*80}\n")
    
    try:
        import cv2
        import numpy as np
        
        epsilon = data.get('epsilon', 1.5)
        smoothing = data.get('smoothing_factor', 0.3)
        include_background = data.get('include_background', False)
        
        # Create directory for PNG masks (will NOT be deleted for debugging)
        masks_dir = Path(app.config['UPLOAD_FOLDER']) / session_id / 'vectorize_debug_masks'
        masks_dir.mkdir(exist_ok=True)
        
        # Create directory for intermediate SVGs (will NOT be deleted for debugging)
        svg_debug_dir = Path(app.config['UPLOAD_FOLDER']) / session_id / 'vectorize_debug_svgs'
        svg_debug_dir.mkdir(exist_ok=True)
        
        print(f"\n{'='*80}")
        print(f"GENERATING SVG PREVIEW - DEBUG MODE")
        print(f"{'='*80}")
        print(f"Session ID: {session_id}")
        print(f"Segments to vectorize: {len(session['segments'])}")
        print(f"Epsilon: {epsilon}, Smoothing: {smoothing}")
        print(f"Include background: {include_background}")
        print(f"PNG masks dir: {masks_dir}")
        print(f"SVG debug dir: {svg_debug_dir}")
        
        # Load original image
        img = cv2.imread(session['image_path'])
        
        # Step 1: Save all masks as full-size PNGs
        print(f"\n{'='*80}")
        print(f"STEP 1: Saving masks to PNG (like export_masks_debug)")
        print(f"{'='*80}\n")
        
        mask_files = []
        for i, segment in enumerate(session['segments']):
            try:
                print(f"Preparing mask {i+1}/{len(session['segments'])}: {segment['name']}")
                
                # Convert mask to numpy array
                mask = np.array(segment['mask'], dtype=np.uint8)
                
                # Improve mask quality
                mask_improved = vectorization_handler.improve_mask(
                    mask,
                    dilate_size=10,
                    close_size=10
                )
                
                # Check if mask has pixels
                coords = np.argwhere(mask_improved > 0)
                if len(coords) == 0:
                    print(f"  ⚠ WARNING: Mask has no pixels after improvement, skipping")
                    continue
                
                # Determine output format based on segment preference
                should_vectorize = segment.get('should_vectorize', True)
                
                if should_vectorize:
                    # For vectorization: create image with WHITE background (for better contour detection)
                    full_img = img.copy()
                    mask_3ch = np.stack([mask_improved] * 3, axis=-1)
                    full_img = np.where(mask_3ch > 0, full_img, 255)
                    
                    # Save to PNG file
                    safe_name = segment['name'].replace(' ', '_').replace('/', '_')
                    png_filename = f"{i+1:02d}_{segment['category']}_{safe_name}.png"
                    png_path = masks_dir / png_filename
                    
                    cv2.imwrite(str(png_path), full_img)
                    print(f"  ✓ Saved for vectorization: {png_filename} ({full_img.shape[1]}x{full_img.shape[0]}px)")
                else:
                    # For PNG export: create image with TRANSPARENT background
                    full_img_rgba = cv2.cvtColor(img.copy(), cv2.COLOR_BGR2BGRA)
                    full_img_rgba[:, :, 3] = mask_improved  # Alpha channel from mask
                    
                    # Save to PNG file with transparency
                    safe_name = segment['name'].replace(' ', '_').replace('/', '_')
                    png_filename = f"{i+1:02d}_{segment['category']}_{safe_name}_transparent.png"
                    png_path = masks_dir / png_filename
                    
                    cv2.imwrite(str(png_path), full_img_rgba)
                    print(f"  ✓ Saved with transparency: {png_filename} ({full_img_rgba.shape[1]}x{full_img_rgba.shape[0]}px)")
                
                mask_files.append({
                    'path': str(png_path),
                    'segment': segment,
                    'index': i
                })
                
            except Exception as e:
                print(f"  ✗ ERROR preparing mask {i+1}: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        if not mask_files:
            return jsonify({'error': 'No valid masks to vectorize'}), 400
        
        # Get image dimensions (needed for creating additional SVG layers)
        width, height = img.shape[1], img.shape[0]
        print(f"Image dimensions: {width}x{height}")
        
        # Step 2: Process each saved PNG (vectorize or keep as PNG)
        print(f"\n{'='*80}")
        print(f"STEP 2: Processing {len(mask_files)} saved PNGs")
        print(f"{'='*80}\n")
        
        vectorized_elements = []
        png_elements = []
        categories_found = set()
        
        # Track the topmost profile (smallest y_top) to add diameter line only to that one
        topmost_profile_y = None
        topmost_profile_info = None
        all_profile_infos = []  # Store all profiles to process diameter line later
        
        for mask_info in mask_files:
            try:
                segment = mask_info['segment']
                png_path = mask_info['path']
                
                should_vectorize = segment.get('should_vectorize', True)
                
                if should_vectorize:
                    print(f"\nVectorizing: {segment['name']} from {Path(png_path).name}")
                    
                    # Vectorize using the saved PNG file directly
                    element_vectors = vectorization_handler.vectorize_from_png(
                        png_path=png_path,
                        category=segment['category'],
                        name=segment['name'],
                        epsilon=epsilon,
                        smoothing_factor=smoothing,
                        debug_svg_dir=str(svg_debug_dir)  # Save intermediate SVG for debugging
                    )
                    
                    # Add reference to the SVG file path for unified export
                    safe_name = segment['name'].replace(' ', '_').replace('/', '_')
                    element_vectors['svg_file'] = str(svg_debug_dir / f"{segment['category']}_{safe_name}.svg")
                    
                    # NEW: Generate additional layers if Profile with rotation center
                    if segment['category'] == 'Profile' and session.get('rotation_center'):
                        center_x = session['rotation_center']['x']
                        print(f"\n{'='*60}")
                        print(f"  ✓ Rotation center detected at x={center_x}")
                        print(f"  → Checking for profile_data in element_vectors...")
                        print(f"  → element_vectors keys: {list(element_vectors.keys())}")
                        if 'stats' in element_vectors:
                            print(f"  → stats keys: {list(element_vectors['stats'].keys())}")
                        print(f"{'='*60}\n")
                        
                        # Check if we have profile_data from extract_profile_mode
                        if 'stats' in element_vectors and 'profile_data' in element_vectors.get('stats', {}):
                            profile_data = element_vectors['stats']['profile_data']
                            outer_contour = profile_data.get('outer_contour')
                            
                            print(f"  ✓ Found profile_data!")
                            print(f"  → outer_contour type: {type(outer_contour)}")
                            print(f"  → outer_contour length: {len(outer_contour) if outer_contour is not None else 'None'}")
                            
                            if outer_contour is not None and len(outer_contour) > 0:
                                y_top = int(np.min(outer_contour[:, 0]))
                                y_bottom = int(np.max(outer_contour[:, 0]))
                                
                                # Store this profile's info for later diameter line decision
                                profile_info = {
                                    'segment': segment,
                                    'safe_name': safe_name,
                                    'outer_contour': outer_contour,
                                    'y_top': y_top,
                                    'y_bottom': y_bottom,
                                    'center_x': center_x,
                                    'width': width,
                                    'height': height
                                }
                                all_profile_infos.append(profile_info)
                                
                                # Track the topmost profile (smallest y_top)
                                if topmost_profile_y is None or y_top < topmost_profile_y:
                                    topmost_profile_y = y_top
                                    topmost_profile_info = profile_info
                                
                                print(f"  → Creating additional profile layers...")
                                
                                # 1. Create mirrored profile SVG (using outer contour)
                                mirrored_svg_path = svg_debug_dir / f"Profile_{safe_name}_Mirrored.svg"
                                vectorization_handler.create_mirrored_profile_svg(
                                    profile_path=outer_contour,
                                    center_x=center_x,
                                    output_path=str(mirrored_svg_path),
                                    width=width,
                                    height=height,
                                    epsilon=epsilon,
                                    smoothing_factor=smoothing
                                )
                                
                                # Add mirrored profile as separate vectorized element
                                vectorized_elements.append({
                                    'name': f"{segment['name']} (Mirrored)",
                                    'category': 'Profile_Mirrored',
                                    'paths': vectorization_handler._extract_paths_from_svg(str(mirrored_svg_path)),
                                    'style': {'color': '#000000', 'stroke_width': 1.5, 'fill': 'none'},
                                    'svg_file': str(mirrored_svg_path)
                                })
                                
                                # 2. Create symmetry line SVG (vertical axis of rotation)
                                symmetry_svg_path = svg_debug_dir / f"Symmetry_Line_{safe_name}.svg"
                                vectorization_handler.create_symmetry_line_svg(
                                    center_x=center_x,
                                    y_top=y_top,
                                    y_bottom=y_bottom,
                                    output_path=str(symmetry_svg_path),
                                    width=width,
                                    height=height
                                )
                                
                                # Add symmetry line as separate vectorized element
                                vectorized_elements.append({
                                    'name': 'Symmetry Line',
                                    'category': 'Symmetry_Line',
                                    'paths': vectorization_handler._extract_paths_from_svg(str(symmetry_svg_path)),
                                    'style': {'color': '#999999', 'stroke_width': 0.5, 'fill': 'none'},
                                    'svg_file': str(symmetry_svg_path)
                                })
                                
                                # NOTE: Diameter line will be created AFTER processing all profiles
                                # to ensure it's only added to the topmost one
                                print(f"  ✓ Created mirrored profile and symmetry line layers (diameter pending)")
                            else:
                                print(f"  ✗ outer_contour is None or empty, skipping additional layers")
                        else:
                            print(f"  ✗ profile_data not found in element_vectors, skipping additional layers")
                            print(f"     This usually means extract_profile_mode was not activated")
                    
                    vectorized_elements.append(element_vectors)
                    categories_found.add(segment['category'])
                    print(f"  ✓ Vectorized: {len(element_vectors.get('paths', []))} paths\n")
                else:
                    print(f"\nKeeping as PNG: {segment['name']} from {Path(png_path).name}")
                    
                    # PNG is already saved with transparency, just add to list
                    png_elements.append({
                        'path': png_path,
                        'segment': segment,
                        'original_path': png_path
                    })
                    
                    categories_found.add(segment['category'])
                    print(f"  ✓ PNG already has transparency: {Path(png_path).name}\n")
                
            except Exception as e:
                print(f"  ✗ ERROR processing {segment['name']}: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        # After processing all profiles, create diameter line ONLY for the topmost one
        if topmost_profile_info is not None:
            print(f"\n{'='*60}")
            print(f"  Creating diameter line for topmost profile...")
            print(f"  Total profiles processed: {len(all_profile_infos)}")
            print(f"  Topmost profile y_top: {topmost_profile_y}")
            print(f"{'='*60}\n")
            
            info = topmost_profile_info
            outer_contour = info['outer_contour']
            y_top = info['y_top']
            center_x = info['center_x']
            width = info['width']
            height = info['height']
            safe_name = info['safe_name']
            
            # Use the SAME logic as extract_left_side_of_profile:
            # Find all points on the top horizontal line
            tolerance = 2
            top_line_points = outer_contour[np.abs(outer_contour[:, 0] - y_top) <= tolerance]
            
            if len(top_line_points) > 0:
                # Find the leftmost point on the top line (the external edge)
                top_left_point = top_line_points[np.argmin(top_line_points[:, 1])]
                
                center_y = int(top_left_point[0])  # Y coordinate at the top (y_top)
                x_left = int(top_left_point[1])    # Leftmost X coordinate at y_top
                x_right = int(2 * center_x - x_left)  # Mirror to get right side
            else:
                # Fallback: use y_top directly
                center_y = int(y_top)
                x_left = int(np.min(outer_contour[:, 1]))
                x_right = int(2 * center_x - x_left)
            
            diameter_svg_path = svg_debug_dir / f"Diameter_Line_{safe_name}.svg"
            vectorization_handler.create_diameter_line_svg(
                center_x=center_x,
                center_y=center_y,
                x_left=x_left,
                x_right=x_right,
                output_path=str(diameter_svg_path),
                width=width,
                height=height
            )
            
            # Add diameter line as separate vectorized element
            vectorized_elements.append({
                'name': 'Diameter Line',
                'category': 'Diameter',
                'paths': vectorization_handler._extract_paths_from_svg(str(diameter_svg_path)),
                'style': {'color': '#666666', 'stroke_width': 0.8, 'fill': 'none'},
                'svg_file': str(diameter_svg_path)
            })
            
            print(f"  ✓ Created diameter line for topmost profile: {safe_name}")
        
        # Check if we have any output to generate
        if not vectorized_elements and not png_elements:
            return jsonify({'error': 'No segments were successfully processed'}), 400
        
        # Step 3: Generate final output (SVG + PNG files)
        print(f"\n{'='*80}")
        print(f"STEP 3: Creating final output")
        print(f"{'='*80}")
        
        print(f"Vectorized elements: {len(vectorized_elements)}")
        print(f"PNG elements: {len(png_elements)}")
        print(f"Categories: {categories_found}")
        
        # Create output directory
        output_dir = Path(app.config['UPLOAD_FOLDER']) / session_id / 'output'
        output_dir.mkdir(exist_ok=True)
        
        output_files = []
        
        # Get original filename (without extension) for output naming
        original_filename = session.get('filename', 'output')
        base_name = Path(original_filename).stem  # Remove extension
        
        # 1. Create UNIFIED SVG with layers (vectorized + raster elements combined)
        unified_svg_path = output_dir / f'{base_name}_vectorized.svg'
        
        print(f"\n{'='*60}")
        print(f"ATTEMPTING TO CREATE UNIFIED SVG")
        print(f"Vectorized elements: {len(vectorized_elements)}")
        for i, elem in enumerate(vectorized_elements):
            print(f"  [{i}] {elem.get('category', 'N/A')}: {elem.get('name', 'N/A')}")
        print(f"PNG elements: {len(png_elements)}")
        print(f"Output path: {unified_svg_path}")
        print(f"{'='*60}")
        
        try:
            vectorization_handler.export_unified_svg(
                vectorized_elements=vectorized_elements,
                raster_elements=png_elements,
                output_path=str(unified_svg_path),
                width=width,
                height=height,
                include_background=include_background,
                background_image=session['image_path'] if include_background else None
            )
            
            # Verify the file was created
            if unified_svg_path.exists():
                file_size = unified_svg_path.stat().st_size
                print(f"✓ Unified SVG created successfully: {file_size} bytes")
                
                output_files.append({
                    'type': 'svg',
                    'path': str(unified_svg_path),
                    'url': f'/api/download/{session_id}/output/{unified_svg_path.name}',
                    'name': unified_svg_path.name,
                    'description': 'Unified SVG with layers (open in Illustrator)'
                })
            else:
                print(f"⚠ ERROR: Unified SVG file was not created!")
        except Exception as e:
            print(f"⚠ ERROR creating unified SVG: {e}")
            import traceback
            traceback.print_exc()
        
        # 2. Copy individual SVG files from debug directory (they are already correct!)
        # These are useful for separate editing
        if vectorized_elements:
            for element in vectorized_elements:
                # Find the corresponding SVG file in debug directory
                safe_name = element['name'].replace(' ', '_').replace('/', '_')
                debug_svg_path = svg_debug_dir / f"{element['category']}_{safe_name}.svg"
                
                if debug_svg_path.exists():
                    # Copy to output directory with clean name
                    output_svg_path = output_dir / f"{element['category']}_{safe_name}.svg"
                    
                    import shutil
                    shutil.copy2(debug_svg_path, output_svg_path)
                    
                    output_files.append({
                        'type': 'svg',
                        'path': str(output_svg_path),
                        'url': f'/api/download/{session_id}/output/{output_svg_path.name}',
                        'name': output_svg_path.name,
                        'description': 'Individual SVG element'
                    })
                    print(f"✓ Individual SVG copied: {output_svg_path.name}")
                else:
                    print(f"⚠ Warning: SVG not found for {element['name']}")
        
        # Copy PNG files to output directory
        for png_element in png_elements:
            segment = png_element['segment']
            transparent_png_path = Path(png_element['path'])
            
            # Copy to output directory with clean name
            safe_name = segment['name'].replace(' ', '_').replace('/', '_')
            output_png_path = output_dir / f"{segment['category']}_{safe_name}.png"
            
            import shutil
            shutil.copy2(transparent_png_path, output_png_path)
            
            output_files.append({
                'type': 'png',
                'path': str(output_png_path),
                'url': f'/api/download/{session_id}/output/{output_png_path.name}',
                'name': output_png_path.name,
                'segment': segment
            })
            print(f"✓ PNG copied: {output_png_path}")
        
        # Create a ZIP file containing all outputs (named after original file)
        import zipfile
        zip_path = Path(app.config['UPLOAD_FOLDER']) / session_id / f'{base_name}_export.zip'
        
        print(f"\n{'='*60}")
        print(f"CREATING ZIP FILE")
        print(f"Total output files to add: {len(output_files)}")
        print(f"{'='*60}")
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            for i, output_file in enumerate(output_files):
                file_path = Path(output_file['path'])
                print(f"  {i+1}. Checking: {file_path.name}")
                if file_path.exists():
                    file_size = file_path.stat().st_size
                    zip_file.write(file_path, file_path.name)
                    print(f"     ✓ Added to ZIP ({file_size} bytes)")
                else:
                    print(f"     ✗ FILE NOT FOUND!")
        
        print(f"✓ ZIP created: {zip_path}")
        print(f"{'='*60}\n")
        
        # NO CLEANUP - Keep debug files!
        print(f"\n{'='*80}")
        print(f"DEBUG FILES PRESERVED:")
        print(f"  → PNG masks: {masks_dir}")
        print(f"  → Intermediate SVGs: {svg_debug_dir}")
        print(f"  → Output files: {output_dir}")
        print(f"  → Combined ZIP: {zip_path}")
        print(f"{'='*80}\n")
        
        return jsonify({
            'success': True,
            'output_files': output_files,
            'zip_url': f'/api/download/{session_id}/{zip_path.name}',
            'categories': list(categories_found),
            'debug': {
                'masks_dir': str(masks_dir),
                'svgs_dir': str(svg_debug_dir),
                'output_dir': str(output_dir)
            }
        })
        
    except Exception as e:
        import traceback
        print(f"\n❌ ERROR generating SVG:")
        traceback.print_exc()
        return jsonify({'error': f'Failed to generate preview: {str(e)}'}), 500


@app.route('/api/upload', methods=['POST'])
def upload_image():
    """Upload and initialize image for segmentation."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if not allowed_file(file.filename):
        return jsonify({'error': 'File type not allowed'}), 400
    
    # Create session ID
    session_id = str(uuid.uuid4())
    
    # Save uploaded file
    filename = secure_filename(file.filename)
    upload_path = Path(app.config['UPLOAD_FOLDER']) / session_id
    upload_path.mkdir(parents=True, exist_ok=True)
    
    file_path = upload_path / filename
    file.save(file_path)
    
    # Initialize SAM2 for this image
    try:
        image_embedding = sam2_handler.set_image(str(file_path))
        
        # Store session data
        sessions_data[session_id] = {
            'image_path': str(file_path),
            'filename': filename,
            'segments': [],  # List of segmented elements with their categories
            'rotation_center': None,
            'created_at': datetime.now().isoformat()
        }
        
        return jsonify({
            'success': True,
            'session_id': session_id,
            'filename': filename,
            'image_url': f'/api/image/{session_id}'
        })
        
    except Exception as e:
        return jsonify({'error': f'Failed to process image: {str(e)}'}), 500


@app.route('/api/image/<session_id>')
def get_image(session_id):
    """Get the uploaded image."""
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    image_path = sessions_data[session_id]['image_path']
    return send_file(image_path, mimetype='image/jpeg')


@app.route('/api/segment', methods=['POST'])
def segment():
    """Perform SAM2 segmentation with point or box prompt."""
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    prompt_type = data.get('prompt_type')  # 'point' or 'box'
    
    try:
        if prompt_type == 'point':
            # Point prompt: {x, y, label} where label is 1 (positive) or 0 (negative)
            points = data.get('points', [])
            labels = data.get('labels', [])
            
            mask = sam2_handler.segment_with_points(
                points=points,
                labels=labels
            )
            
        elif prompt_type == 'box':
            # Box prompt: {x1, y1, x2, y2}
            box = data.get('box')
            
            mask = sam2_handler.segment_with_box(
                box=box
            )
        else:
            return jsonify({'error': 'Invalid prompt type'}), 400
        
        # Convert mask to polygon for frontend display (NO improvement here!)
        contours = vectorization_handler.mask_to_contours(mask)
        
        return jsonify({
            'success': True,
            'mask': mask.tolist(),  # For backend processing (original SAM2 mask)
            'contours': contours,  # For frontend display (original mask)
            'mask_id': len(sessions_data[session_id]['segments'])
        })
        
    except Exception as e:
        return jsonify({'error': f'Segmentation failed: {str(e)}'}), 500


@app.route('/api/add_segment', methods=['POST'])
def add_segment():
    """Add a segmented element with its category."""
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    # Get segment data
    mask = data.get('mask')
    category = data.get('category')  # 'Profile', 'Prospectus', 'Decoration', etc.
    name = data.get('name', f'Element {len(sessions_data[session_id]["segments"]) + 1}')
    should_vectorize = data.get('should_vectorize', True)  # Default to True for backward compatibility
    
    # Store segment
    segment = {
        'id': str(uuid.uuid4()),
        'mask': mask,
        'category': category,
        'name': name,
        'should_vectorize': should_vectorize,
        'created_at': datetime.now().isoformat()
    }
    
    sessions_data[session_id]['segments'].append(segment)
    
    return jsonify({
        'success': True,
        'segment_id': segment['id'],
        'total_segments': len(sessions_data[session_id]['segments'])
    })


@app.route('/api/set_rotation_center', methods=['POST'])
def set_rotation_center():
    """Set the rotation center for profile mirroring."""
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    x = data.get('x')
    y = data.get('y')
    
    sessions_data[session_id]['rotation_center'] = {'x': x, 'y': y}
    
    return jsonify({
        'success': True,
        'rotation_center': {'x': x, 'y': y}
    })


@app.route('/api/clear_rotation_center', methods=['POST'])
def clear_rotation_center():
    """Clear the rotation center."""
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    sessions_data[session_id]['rotation_center'] = None
    
    return jsonify({
        'success': True
    })


@app.route('/api/segments/<session_id>')
def get_segments(session_id):
    """Get all segments for a session."""
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    segments = sessions_data[session_id]['segments']
    
    # Return without mask data (too large for JSON)
    segments_info = [{
        'id': seg['id'],
        'category': seg['category'],
        'name': seg['name'],
        'created_at': seg['created_at']
    } for seg in segments]
    
    return jsonify({
        'success': True,
        'segments': segments_info,
        'rotation_center': sessions_data[session_id].get('rotation_center')
    })


@app.route('/api/delete_segment', methods=['POST'])
def delete_segment():
    """Delete a segment."""
    data = request.json
    session_id = data.get('session_id')
    segment_id = data.get('segment_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    # Debug: print before deletion
    print(f"\n=== DELETE SEGMENT (Backend) ===")
    print(f"Segment ID to delete: {segment_id}")
    print(f"Segments before deletion: {len(sessions_data[session_id]['segments'])}")
    for seg in sessions_data[session_id]['segments']:
        print(f"  - {seg['id']}: {seg['name']} ({seg['category']})")
    
    # Remove segment
    segments = sessions_data[session_id]['segments']
    sessions_data[session_id]['segments'] = [
        seg for seg in segments if seg['id'] != segment_id
    ]
    
    # Debug: print after deletion
    print(f"Segments after deletion: {len(sessions_data[session_id]['segments'])}")
    for seg in sessions_data[session_id]['segments']:
        print(f"  - {seg['id']}: {seg['name']} ({seg['category']})")
    print(f"=================================\n")
    
    return jsonify({
        'success': True,
        'total_segments': len(sessions_data[session_id]['segments'])
    })


@app.route('/api/vectorize', methods=['POST'])
def vectorize():
    """Vectorize all segments and generate SVG."""
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    session = sessions_data[session_id]
    
    try:
        import cv2
        import numpy as np
        
        # Get vectorization parameters
        epsilon = data.get('epsilon', 1.5)
        smoothing = data.get('smoothing_factor', 0.3)
        
        # Create directory for PNG masks (will NOT be deleted for debugging)
        masks_dir = Path(app.config['UPLOAD_FOLDER']) / session_id / 'vectorize_debug_masks'
        masks_dir.mkdir(exist_ok=True)
        
        # Create directory for intermediate SVGs (will NOT be deleted for debugging)
        svg_debug_dir = Path(app.config['UPLOAD_FOLDER']) / session_id / 'vectorize_debug_svgs'
        svg_debug_dir.mkdir(exist_ok=True)
        
        print(f"\n{'='*80}")
        print(f"VECTORIZATION DEBUG MODE")
        print(f"PNG masks will be saved in: {masks_dir}")
        print(f"Intermediate SVGs will be saved in: {svg_debug_dir}")
        print(f"Files will NOT be deleted after vectorization")
        print(f"{'='*80}\n")
        
        print(f"\n{'='*80}")
        print(f"STEP 1: Saving masks to PNG (like export_masks_debug)")
        print(f"{'='*80}\n")
        
        # Load original image
        img = cv2.imread(session['image_path'])
        
        # Step 1: Save all masks as full-size PNGs (same process as export_masks_debug)
        mask_files = []
        for i, segment in enumerate(session['segments']):
            try:
                print(f"Preparing mask {i+1}/{len(session['segments'])}: {segment['name']}")
                
                # Convert mask to numpy array
                mask = np.array(segment['mask'], dtype=np.uint8)
                
                # Improve mask quality
                mask_improved = vectorization_handler.improve_mask(
                    mask,
                    dilate_size=10,
                    close_size=10
                )
                
                # Check if mask has pixels
                coords = np.argwhere(mask_improved > 0)
                if len(coords) == 0:
                    print(f"  ⚠ WARNING: Mask has no pixels after improvement, skipping")
                    continue
                
                # Create FULL-SIZE masked image (same dimensions as original)
                full_img = img.copy()
                
                # Create 3-channel mask
                mask_3ch = np.stack([mask_improved] * 3, axis=-1)
                
                # Apply mask: keep masked region, set rest to white
                full_img = np.where(mask_3ch > 0, full_img, 255)
                
                # Save to PNG file
                safe_name = segment['name'].replace(' ', '_').replace('/', '_')
                png_filename = f"{i+1:02d}_{segment['category']}_{safe_name}.png"
                png_path = masks_dir / png_filename
                
                cv2.imwrite(str(png_path), full_img)
                print(f"  ✓ Saved: {png_filename} ({full_img.shape[1]}x{full_img.shape[0]}px)")
                
                mask_files.append({
                    'path': str(png_path),
                    'segment': segment,
                    'index': i
                })
                
            except Exception as e:
                print(f"  ✗ ERROR preparing mask {i+1}: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        if not mask_files:
            return jsonify({'error': 'No valid masks to vectorize'}), 400
        
        # Step 2: Vectorize each saved PNG
        vectorized_elements = []
        
        print(f"\n{'='*80}")
        print(f"STEP 2: Vectorizing {len(mask_files)} saved PNGs")
        print(f"{'='*80}\n")
        
        for mask_info in mask_files:
            try:
                segment = mask_info['segment']
                png_path = mask_info['path']
                
                print(f"Vectorizing: {segment['name']} from {Path(png_path).name}")
                
                # Vectorize using the saved PNG file directly
                element_vectors = vectorization_handler.vectorize_from_png(
                    png_path=png_path,
                    category=segment['category'],
                    name=segment['name'],
                    epsilon=epsilon,
                    smoothing_factor=smoothing,
                    debug_svg_dir=str(svg_debug_dir)  # Save intermediate SVG for debugging
                )
                
                # Mirror if it's a Profile and rotation center is defined
                if segment['category'] == 'Profile' and session.get('rotation_center'):
                    element_vectors = vectorization_handler.mirror_profile(
                        vectors=element_vectors,
                        center_x=session['rotation_center']['x']
                    )
                
                vectorized_elements.append(element_vectors)
                print(f"  ✓ Vectorized: {len(element_vectors.get('paths', []))} paths\n")
                
            except Exception as e:
                print(f"  ✗ ERROR vectorizing {segment['name']}: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        if not vectorized_elements:
            return jsonify({'error': 'No segments were successfully vectorized'}), 400
        
        # Step 3: Generate final combined SVG with organized layers
        print(f"\n{'='*80}")
        print(f"STEP 3: Generating final combined SVG")
        print(f"{'='*80}\n")
        
        svg_path = Path(app.config['UPLOAD_FOLDER']) / session_id / 'output.svg'
        
        # Get image dimensions (img already loaded above)
        width, height = img.shape[1], img.shape[0]
        
        vectorization_handler.export_svg(
            elements=vectorized_elements,
            output_path=str(svg_path),
            width=width,
            height=height,
            include_background=data.get('include_background', False),
            background_image=session['image_path'] if data.get('include_background') else None
        )
        
        print(f"✓ Final SVG saved: {svg_path}\n")
        
        # NO CLEANUP - Keep files for debugging!
        print(f"\n{'='*80}")
        print(f"DEBUG FILES PRESERVED:")
        print(f"  → PNG masks: {masks_dir}")
        print(f"  → Intermediate SVGs: {svg_debug_dir}")
        print(f"  → Final SVG: {svg_path}")
        print(f"{'='*80}\n")
        
        return jsonify({
            'success': True,
            'svg_url': f'/api/download/{session_id}/output.svg',
            'total_vectorized': len(vectorized_elements),
            'debug': {
                'masks_dir': str(masks_dir),
                'svgs_dir': str(svg_debug_dir)
            }
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Vectorization failed: {str(e)}'}), 500


@app.route('/api/export_masks_debug', methods=['POST'])
def export_masks_debug():
    """Export all segment masks as cropped PNG images for debugging."""
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    session = sessions_data[session_id]
    
    if not session['segments']:
        return jsonify({'error': 'No segments to export'}), 400
    
    # Debug: print what segments we're working with
    print(f"\n{'='*80}")
    print(f"EXPORT_MASKS_DEBUG - Starting export")
    print(f"Session has {len(session['segments'])} segments:")
    for i, seg in enumerate(session['segments']):
        print(f"  {i+1}. ID={seg['id']}, Name={seg['name']}, Category={seg['category']}")
    print(f"{'='*80}\n")
    
    try:
        import cv2
        import numpy as np
        import zipfile
        import io
        
        # Load original image
        img = cv2.imread(session['image_path'])
        
        # Create a zip file in memory
        zip_buffer = io.BytesIO()
        
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            for i, segment in enumerate(session['segments']):
                try:
                    print(f"\n=== Processing segment {i+1}: {segment['name']} ===")
                    
                    # Convert mask to numpy array
                    mask = np.array(segment['mask'], dtype=np.uint8)
                    print(f"Original mask shape: {mask.shape}, unique values: {np.unique(mask)}")
                    
                    # IMPROVE MASK with aggressive morphological operations
                    print(f"Improving mask {i+1} for export...")
                    mask_improved = vectorization_handler.improve_mask(
                        mask,
                        dilate_size=10,   # Moderato: 10 pixel di espansione
                        close_size=10     # Riempie buchi di 10x10 pixel
                    )
                    print(f"Improved mask shape: {mask_improved.shape}, unique values: {np.unique(mask_improved)}")
                    
                    # Check if mask has pixels
                    coords = np.argwhere(mask_improved > 0)
                    if len(coords) == 0:
                        print(f"WARNING: Mask {i+1} has no pixels after improvement!")
                        continue
                    
                    print(f"Found {len(coords)} pixels in improved mask")
                    
                    # Create FULL-SIZE masked image with TRANSPARENT background (RGBA)
                    full_img_rgba = cv2.cvtColor(img.copy(), cv2.COLOR_BGR2BGRA)
                    full_img_rgba[:, :, 3] = mask_improved  # Alpha channel from mask
                    
                    print(f"Full-size RGBA image shape: {full_img_rgba.shape} (with transparency)")
                    
                except Exception as e:
                    print(f"ERROR processing segment {i+1}: {e}")
                    import traceback
                    traceback.print_exc()
                    continue
                
                # Save full-size image with transparency to bytes
                _, buffer = cv2.imencode('.png', full_img_rgba)
                
                # Create filename
                safe_name = segment['name'].replace(' ', '_').replace('/', '_')
                filename = f"{i+1:02d}_{segment['category']}_{safe_name}.png"
                
                # Add to zip
                zip_file.writestr(filename, buffer.tobytes())
        
        # Prepare the zip for download
        zip_buffer.seek(0)
        
        # Save zip file
        zip_path = Path(app.config['UPLOAD_FOLDER']) / session_id / 'masks_debug.zip'
        with open(zip_path, 'wb') as f:
            f.write(zip_buffer.getvalue())
        
        return jsonify({
            'success': True,
            'download_url': f'/api/download/{session_id}/masks_debug.zip',
            'total_masks': len(session['segments'])
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Failed to export masks: {str(e)}'}), 500


@app.route('/api/list_svgs/<session_id>')
def list_svgs(session_id):
    """List SVG files for a session."""
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    svg_dir = Path(app.config['UPLOAD_FOLDER']) / session_id / 'vectorize_debug_svgs'
    
    if not svg_dir.exists():
        return jsonify({'success': True, 'svgs': []})
    
    svgs = []
    for svg_file in svg_dir.glob('*.svg'):
        svgs.append({
            'name': svg_file.stem,
            'url': f'/api/download/{session_id}/vectorize_debug_svgs/{svg_file.name}'
        })
    
    return jsonify({'success': True, 'svgs': svgs})


@app.route('/api/download/<session_id>/<path:filename>')
def download_file(session_id, filename):
    """Download generated file."""
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    file_path = Path(app.config['UPLOAD_FOLDER']) / session_id / filename
    
    if not file_path.exists():
        return jsonify({'error': 'File not found'}), 404
    
    return send_file(file_path, as_attachment=True, download_name=file_path.name)


@app.route('/api/session/<session_id>')
def get_session_info(session_id):
    """Get session information."""
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    session = sessions_data[session_id]
    
    return jsonify({
        'success': True,
        'filename': session['filename'],
        'total_segments': len(session['segments']),
        'rotation_center': session.get('rotation_center'),
        'created_at': session['created_at']
    })


@app.route('/api/get_vectorized_components', methods=['POST'])
def get_vectorized_components():
    """
    Extract and return classified components (lines, points, decorations) 
    from Profile segments for filtering and visualization.
    """
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    session = sessions_data[session_id]
    
    # Get only Profile segments (or allow filtering by category)
    target_category = data.get('category', 'Profile')
    
    try:
        all_components = []
        
        for segment in session['segments']:
            # Process only segments of target category
            if segment['category'] != target_category:
                continue
            
            # Vectorize segment and get classified components
            result = vectorization_handler.vectorize_segment(
                image_path=session['image_path'],
                mask=segment['mask'],
                category=segment['category'],
                name=segment['name'],
                epsilon=data.get('epsilon', 1.5),
                smoothing_factor=data.get('smoothing_factor', 0.3),
                return_components=True  # Request classified components instead of SVG paths
            )
            
            # Convert components to JSON-serializable format
            components_json = vectorization_handler.components_to_json(result['components'])
            
            all_components.append({
                'segment_id': segment['id'],
                'segment_name': segment['name'],
                'category': segment['category'],
                'components': components_json,
                'stats': result['stats']
            })
        
        return jsonify({
            'success': True,
            'segments_processed': len(all_components),
            'components': all_components
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Failed to extract components: {str(e)}'}), 500


@app.route('/api/export_filtered_svg', methods=['POST'])
def export_filtered_svg():
    """
    Export filtered components to SVG file.
    """
    data = request.json
    session_id = data.get('session_id')
    
    if session_id not in sessions_data:
        return jsonify({'error': 'Session not found'}), 404
    
    session = sessions_data[session_id]
    
    try:
        # Get filtered components from frontend
        filtered_components = data.get('filtered_components')
        epsilon = data.get('epsilon', 1.5)
        smoothing = data.get('smoothing_factor', 0.3)
        include_background = data.get('include_background', False)
        
        # Get image dimensions
        import cv2
        img = cv2.imread(session['image_path'])
        width, height = img.shape[1], img.shape[0]
        
        # Generate SVG
        svg_path = Path(app.config['UPLOAD_FOLDER']) / session_id / 'filtered_output.svg'
        
        vectorization_handler.filtered_components_to_svg(
            filtered_components=filtered_components,
            output_path=str(svg_path),
            width=width,
            height=height,
            epsilon=epsilon,
            smoothing_factor=smoothing,
            include_background=include_background,
            background_image=session['image_path'] if include_background else None
        )
        
        return jsonify({
            'success': True,
            'svg_url': f'/api/download/{session_id}/filtered_output.svg'
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Failed to export SVG: {str(e)}'}), 500


if __name__ == '__main__':
    # Ensure upload folder exists
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    
    print("=" * 60)
    print("PyPotteryTrace Interactive Server")
    print("=" * 60)
    print("Starting server...")
    print("Open your browser at: http://localhost:5000")
    print("=" * 60)
    
    # Run Flask app
    app.run(debug=False, host='0.0.0.0', port=5000)
