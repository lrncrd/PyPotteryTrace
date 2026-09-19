#!/usr/bin/env python3
"""
PyPotteryTrace Interactive - Launch Script
Quick launcher for the interactive segmentation application.
"""

import sys
import subprocess
import webbrowser
import threading
import time
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

def check_dependencies():
    """Check if required dependencies are installed."""
    print("Checking dependencies...")
    
    try:
        import flask
        print("✓ Flask installed")
    except ImportError:
        print("✗ Flask not installed")
        return False
    
    try:
        import cv2
        print("✓ OpenCV installed")
    except ImportError:
        print("✗ OpenCV not installed")
        return False
    
    try:
        import numpy
        print("✓ NumPy installed")
    except ImportError:
        print("✗ NumPy not installed")
        return False
    
    try:
        import torch
        print("✓ PyTorch installed")
        if torch.cuda.is_available():
            print(f"  ✓ CUDA available (GPU: {torch.cuda.get_device_name(0)})")
        else:
            print("  ⚠ CUDA not available (running on CPU)")
    except ImportError:
        print("✗ PyTorch not installed")
        return False
    
    try:
        from sam2.build_sam import build_sam2
        print("✓ SAM2 installed")
    except ImportError:
        print("✗ SAM2 not installed")
        print("\nTo install SAM2, run:")
        print("  pip install git+https://github.com/facebookresearch/segment-anything-2.git")
        return False
    
    return True

def open_browser(port):
    """Open browser after a short delay to ensure server is ready."""
    time.sleep(2)  # Wait 2 seconds for server to start
    print("\n🌐 Opening browser...")
    webbrowser.open(f'http://localhost:{port}')

def main():
    """Main launcher function."""
    print("=" * 60)
    print("PyPotteryTrace Interactive - Launch Script")
    print("=" * 60)
    print()
    
    # Check if we're in the right directory
    interactive_dir = Path(__file__).parent / "interactive_app"
    if not interactive_dir.exists():
        print("Error: interactive_app directory not found!")
        print(f"Expected: {interactive_dir}")
        sys.exit(1)
    
    # Check dependencies
    if not check_dependencies():
        print("\n" + "=" * 60)
        print("Missing dependencies!")
        print("=" * 60)
        print("\nTo install all dependencies, run:")
        print("  pip install -r requirements_interactive.txt")
        print("  pip install git+https://github.com/facebookresearch/segment-anything-2.git")
        sys.exit(1)
    
    # Change to interactive_app directory and run
    import os
    import sys
    os.chdir(interactive_dir)

    port = int(os.environ.get('PORT', os.environ.get('PYPOTTERY_PORT', 5004)))

    print("\n" + "=" * 60)
    print("All dependencies satisfied!")
    print("=" * 60)
    print("\nStarting PyPotteryTrace Interactive...")
    print("\nThe application will be available at:")
    print(f"  http://localhost:{port}")
    print("\nPress Ctrl+C to stop the server")
    print("=" * 60)
    print()

    # Add interactive_app to Python path so imports work
    sys.path.insert(0, str(interactive_dir))

    # Start browser in a separate thread
    browser_thread = threading.Thread(target=open_browser, args=(port,), daemon=True)
    browser_thread.start()

    # Import and run the Flask app
    try:
        from main import app
        app.run(debug=False, host='0.0.0.0', port=port, use_reloader=False)
    except KeyboardInterrupt:
        print("\n\nServer stopped by user")
    except Exception as e:
        print(f"\n\nError running application: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
