# PyPotteryTrace

<div align="center">

<img src="interactive_app/static/LogoTrace.png" width="250"/>

[![Python](https://img.shields.io/badge/python-3.12-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/License-Apache_2.0-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/lrncrd/PyPotteryTrace)
[![Status](https://img.shields.io/badge/Stage-Alpha-orange)](https://github.com/lrncrd/PyPotteryTrace)
[![AI](https://img.shields.io/badge/AI-SAM2-purple)](https://github.com/facebookresearch/segment-anything-2)

Interactive AI-powered tool for archaeological pottery drawing vectorization

</div>

---

## Introduction

As part of the [**PyPottery**](https://github.com/lrncrd/PyPottery) toolkit, **PyPotteryTrace** is a web-based interactive tool that converts archaeological pottery drawings into clean, structured SVG vectors. Using Meta's SAM2 (Segment Anything Model 2) for AI-powered segmentation, it lets archaeologists segment pottery elements precisely, assign archaeological categories, and generate publication-ready vector graphics with automatic mirroring and intelligent profile connections.

Unlike generic vectorization tools, it understands archaeological pottery conventions: profile mirroring around a rotation axis (with construction lines), connection of running elements to the profile, and category-based organization of SVG layers.

## ✨ Features

- **AI-Powered Segmentation (SAM2)**: click to add or remove areas, with instant visual feedback and independent elements
- **Archaeological Category System**: Profile, Running_Element, Prospectus, Application, Handle, Decoration, Detail, each with its own vectorization rules
- **Smart Mirroring & Connection**: automatic profile mirroring around a user-defined rotation center, with construction lines (Symmetry_Line, Diameter)
- **Vectorization Engine**: contour extraction, Douglas-Peucker simplification and optional Bézier smoothing
- **Project Management**: save and reload the complete session, with an organized workspace per project
- **Export**: category-grouped SVG layers, COCO annotations for machine learning, and individual PNG masks

## 🚀 Quick Start

### Option 1 — PyPottery Suite Launcher (recommended)

The easiest way to get started, no Python installation required.

<p align="center">
  <a href="https://github.com/lrncrd/PyPottery/releases/latest">
    <img src="https://img.shields.io/badge/Download-PyPottery%20Launcher-667eea?style=for-the-badge&logoColor=white" alt="Download Launcher">
  </a>
</p>

1. Grab the installer for your OS from [Releases](https://github.com/lrncrd/PyPottery/releases/latest)
2. Run it (Windows) or drag-to-Applications (macOS) — no Python install required
3. Launch PyPotteryTrace from the suite launcher; updates are handled automatically

### Option 2 — Manual installation (from source)

For developers, or anyone who wants to run the app on its own:

```bash
# Clone repository
git clone https://github.com/lrncrd/PyPotteryTrace.git
cd PyPotteryTrace

# Install dependencies (includes PyTorch and SAM2)
pip install -r requirements.txt

# Run the app
python app.py
# Then open http://127.0.0.1:5004 in your browser
```

SAM2 model weights (tiny ~156MB, small ~184MB default, base_plus ~323MB, large ~898MB) are downloaded from the interface on first use. For CUDA-specific PyTorch builds and other platform notes, see the [Getting Started guide](https://lrncrd.github.io/PyPottery/pypotterytrace/index.html). Installer scripts are also provided: `PyPotteryTrace_WIN.bat` and `PyPotteryTrace_UNIX.sh`.

## 📋 System Requirements

- **Python**: 3.12 (tested)
- **Operating System**: Windows/macOS/Linux
- **GPU** (recommended): NVIDIA GPU with CUDA for SAM2; the CPU works but is slower (Apple Silicon runs on the CPU)
- **Git**: only if you install SAM2 from source

## 🎯 Usage

1. **Upload** a pottery drawing (JPG, PNG, TIFF, BMP)
2. **Segment** elements: click inside to add an area (Positive) or exclude one (Negative), then confirm with **Add Segment**
3. **Assign a category** to each element (Profile, Running_Element, Decoration, ...)
4. **Set the rotation center** on the vertical axis of the vessel (needed for Profile and Running_Element mirroring)
5. **Vectorize** all elements, tuning simplification and smoothing if needed
6. **Download** the organized SVG, and save the project to resume later

For the full walkthrough, see the **[Usage Guide](https://lrncrd.github.io/PyPottery/pypotterytrace/usage.html)**. For categories, mirroring logic, the vectorization pipeline and parameters, see the **[Technical Reference](https://lrncrd.github.io/PyPottery/pypotterytrace/technical_reference.html)**.

## 📊 What's New

See the **[Version History](https://lrncrd.github.io/PyPottery/pypotterytrace/version_history.html)** for the full changelog.

## 🤝 Contributing

Contributions are welcome: fork the repository, create a feature branch, keep functions small and documented (PEP 8), test with real pottery drawings, and open a pull request describing the change. Areas that need help include path simplification and smoothing, accessibility, documentation and tutorials, tests, and performance on large images.

## 👥 Contributors

<a href="https://github.com/lrncrd/PyPotteryTrace/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=lrncrd/PyPotteryTrace" />
</a>

## ☕ Support This Project

If you find PyPotteryTrace useful for your research, consider supporting its development:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/lrncrd)

Your support helps maintain and improve this open-source tool for the archaeological community!

---

Developed with ❤️ by [Lorenzo Cardarelli](https://github.com/lrncrd)
