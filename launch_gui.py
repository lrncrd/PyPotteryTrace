#!/usr/bin/env python3
"""
Archaeological Vectorizer - Quick Launcher
Simple launcher script for the GUI application.
"""

import sys
import os
from pathlib import Path

def check_requirements():
    """Check if all required packages are installed."""
    required_packages = [
        'customtkinter',
        'PIL',  # Pillow
        'cv2',  # opencv-python
        'skimage',  # scikit-image
        'sknw',
        'svgwrite',
        'rdp',
        'matplotlib',
        'numpy'
    ]
    
    missing_packages = []
    
    for package in required_packages:
        try:
            __import__(package)
        except ImportError:
            missing_packages.append(package)
    
    if missing_packages:
        print("❌ Missing required packages:")
        for pkg in missing_packages:
            print(f"   - {pkg}")
        print("\n📦 Install missing packages with:")
        print("pip install customtkinter Pillow opencv-python scikit-image sknw svgwrite rdp matplotlib numpy")
        return False
    
    return True

def main():
    """Main launcher function."""
    print("🏺 Archaeological Drawing Vectorizer v2.0")
    print("=" * 50)
    
    # Check if we're in the right directory
    if not Path("archaeological_vectorizer.py").exists():
        print("❌ Error: archaeological_vectorizer.py not found!")
        print("Please run this script from the directory containing the vectorizer files.")
        sys.exit(1)
    
    # Check requirements
    print("🔍 Checking requirements...")
    if not check_requirements():
        sys.exit(1)
    
    print("✅ All requirements satisfied!")
    print("🚀 Starting GUI application...")
    
    # Import and run the GUI
    try:
        from archaeological_vectorizer_gui import ArchaeologicalVectorizerGUI
        app = ArchaeologicalVectorizerGUI()
        app.run()
    except ImportError as e:
        print(f"❌ Import error: {e}")
        print("Please make sure all files are in the same directory.")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error starting application: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()