#!/usr/bin/env python3
"""
PyPotteryTrace Interactive - Launch Script
Quick launcher for the interactive segmentation application.
"""

# --- Crash diagnostics: identical block in every PyPottery app (keep in sync) ---
# Native crashes (torch/OpenCV segfaults) leave no Python traceback, and the
# default excepthooks carry no timestamp or thread name. Output goes to stderr,
# which the PyPottery Launcher already captures in logs/apps/<app>.log.
def _install_crash_diagnostics():
    import faulthandler
    import sys
    import threading
    import time
    import traceback

    try:
        faulthandler.enable()
    except Exception:
        pass  # stderr can be None/unusable on windowless builds

    def _report(kind, exc_type, exc_value, exc_tb, thread_name="MainThread"):
        try:
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            text = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
            sys.stderr.write(f"{stamp} CRITICAL [{thread_name}] {kind}\n{text}")
            sys.stderr.flush()
        except Exception:
            pass

    def _thread_hook(args):
        if args.exc_type is SystemExit:
            return
        _report("Unhandled exception in thread", args.exc_type, args.exc_value,
                args.exc_traceback, getattr(args.thread, "name", "?"))

    sys.excepthook = lambda t, v, tb: _report("Unhandled exception", t, v, tb)
    threading.excepthook = _thread_hook


_install_crash_diagnostics()

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
        print("  pip install -r requirements.txt")
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
        app.run(debug=False, host='127.0.0.1', port=port, use_reloader=False)
    except KeyboardInterrupt:
        print("\n\nServer stopped by user")
    except Exception as e:
        print(f"\n\nError running application: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
