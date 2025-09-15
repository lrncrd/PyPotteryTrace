#!/usr/bin/env python3
"""
PyPotteryTrace - Archaeological Drawing Vectorizer
A professional, modern interface for archaeological pottery drawing vectorization.

Features:
- Modern dark/light theme with customtkinter
- Professional top menu bar with logo
- Single and batch processing modes
- Real-time parameter adjustment with presets
- Progress tracking with comprehensive reporting
- SVG export with optional background images

Author: Lorenzo Cardarelli
"""

VERSION = "0.1"

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import customtkinter as ctk
from PIL import Image, ImageTk
import threading
import os
import sys
from pathlib import Path
import webbrowser

# Import our archaeological vectorizer
from archaeological_vectorizer import vectorize_archaeological_drawing

class ArchaeologicalVectorizerGUI:
    def __init__(self):
        # Set appearance mode and color theme
        ctk.set_appearance_mode("light")  # "dark" or "light"
        ctk.set_default_color_theme("blue")  # "blue", "green", "dark-blue"
        
                # Create main window
        self.root = ctk.CTk()
        self.root.title(f"PyPotteryTrace v{VERSION} - Archaeological Drawing Vectorizer")
        self.root.geometry("1200x800")
        self.root.minsize(1000, 700)
        
        # Set window icon
        try:
            icon_path = Path(__file__).parent / "imgs" / "logo.png"
            if icon_path.exists():
                icon = tk.PhotoImage(file=str(icon_path))
                self.root.iconphoto(True, icon)
        except Exception:
            pass  # Fallback to default icon if loading fails
        
        # Configure grid weight
        self.root.grid_columnconfigure(0, weight=1)
        self.root.grid_rowconfigure(1, weight=1)  # Main content in row 1
        
        # Variables
        self.input_file = tk.StringVar()
        self.output_svg = tk.StringVar()
        self.output_jpg = tk.StringVar()
        self.input_folder = tk.StringVar()
        self.output_folder = tk.StringVar()
        self.processing = False
        self.batch_mode = tk.BooleanVar(value=False)
        
        # Parameters variables
        self.binary_threshold = tk.IntVar(value=15)
        self.epsilon = tk.DoubleVar(value=1.5)
        self.smoothing_factor = tk.DoubleVar(value=0.3)
        self.min_dotted_area = tk.IntVar(value=5)
        self.max_dotted_area = tk.IntVar(value=200)
        self.dotted_circularity = tk.DoubleVar(value=0.6)
        self.dark_threshold = tk.IntVar(value=100)
        self.min_decoration_area = tk.IntVar(value=1000)
        self.show_debug_plots = tk.BooleanVar(value=False)  # Changed to False
        self.save_debug_images = tk.BooleanVar(value=True)
        self.include_background_image = tk.BooleanVar(value=False)
        
        # Create top bar and interface
        self.create_top_bar()
        self.create_interface()
    
    def create_top_bar(self):
        """Create the top menu bar with logo, theme toggle, and info button."""
        # Top bar frame
        self.top_bar = ctk.CTkFrame(self.root, height=60, corner_radius=0)
        self.top_bar.grid(row=0, column=0, sticky="ew", padx=0, pady=0)
        self.top_bar.grid_columnconfigure(1, weight=1)  # Center area expands
        
        # Left side - Logo and title
        self.left_frame = ctk.CTkFrame(self.top_bar, fg_color="transparent")
        self.left_frame.grid(row=0, column=0, sticky="w", padx=10, pady=10)
        
        # Logo
        try:
            logo_path = Path(__file__).parent / "imgs" / "logo.png"
            if logo_path.exists():
                logo_image = Image.open(logo_path).resize((40, 40), Image.Resampling.LANCZOS)
                self.logo_photo = ctk.CTkImage(light_image=logo_image, dark_image=logo_image, size=(40, 40))
                logo_label = ctk.CTkLabel(self.left_frame, image=self.logo_photo, text="")
                logo_label.grid(row=0, column=0, padx=(0, 10))
        except Exception:
            pass  # No logo if file not found
        
        # Title
        title_label = ctk.CTkLabel(
            self.left_frame, 
            text="PyPotteryTrace", 
            font=ctk.CTkFont(size=24, weight="bold")
        )
        title_label.grid(row=0, column=1)
        
        # Right side - Controls
        self.right_frame = ctk.CTkFrame(self.top_bar, fg_color="transparent")
        self.right_frame.grid(row=0, column=2, sticky="e", padx=10, pady=10)
        
        # Theme toggle button
        self.theme_button = ctk.CTkButton(
            self.right_frame,
            text="🌙 Dark",
            width=80,
            height=30,
            command=self.toggle_theme
        )
        self.theme_button.grid(row=0, column=0, padx=5)
        
        # Info button
        self.info_button = ctk.CTkButton(
            self.right_frame,
            text="ℹ️ Info",
            width=80,
            height=30,
            command=self.show_info
        )
        self.info_button.grid(row=0, column=1, padx=5)
    
    def toggle_theme(self):
        """Toggle between light and dark theme."""
        current_mode = ctk.get_appearance_mode()
        if current_mode == "Light":
            ctk.set_appearance_mode("dark")
            self.theme_button.configure(text="☀️ Light")
        else:
            ctk.set_appearance_mode("light")
            self.theme_button.configure(text="🌙 Dark")
    
    def show_info(self):
        """Show information dialog about PyPotteryTrace."""
        info_window = ctk.CTkToplevel(self.root)
        info_window.title("About PyPotteryTrace")
        info_window.geometry("500x500")
        info_window.resizable(True, True)
        
        # Make it modal
        info_window.transient(self.root)
        info_window.grab_set()
        
        # Configure grid
        info_window.grid_rowconfigure(0, weight=1)
        info_window.grid_columnconfigure(0, weight=1)
        
        # Create scrollable frame for content
        scrollable_frame = ctk.CTkScrollableFrame(info_window)
        scrollable_frame.grid(row=0, column=0, sticky="nsew", padx=20, pady=20)
        scrollable_frame.grid_columnconfigure(0, weight=1)
        
        # Logo in dialog
        try:
            logo_path = Path(__file__).parent / "imgs" / "logo.png"
            if logo_path.exists():
                logo_image = Image.open(logo_path).resize((80, 80), Image.Resampling.LANCZOS)
                logo_photo = ctk.CTkImage(light_image=logo_image, dark_image=logo_image, size=(80, 80))
                logo_label = ctk.CTkLabel(scrollable_frame, image=logo_photo, text="")
                logo_label.grid(row=0, column=0, pady=20)
        except Exception:
            pass
        
        # Title
        title_label = ctk.CTkLabel(
            scrollable_frame, 
            text=f"PyPotteryTrace v{VERSION}", 
            font=ctk.CTkFont(size=28, weight="bold")
        )
        title_label.grid(row=1, column=0, pady=10)
        
        # Subtitle
        subtitle_label = ctk.CTkLabel(
            scrollable_frame,
            text="Archaeological Drawing Vectorizer",
            font=ctk.CTkFont(size=16)
        )
        subtitle_label.grid(row=2, column=0, pady=5)
        
        # Description
        description_text = """
A Python-based software for vectorizing archaeological pottery drawings.
Converts raster images to clean SVG vector graphics with 
recognition of decorative patterns, outlines, and structural elements.

You can find the project on GitHub:
https://github.com/lrncrd/PyPotteryTrace
        """
        
        description_label = ctk.CTkLabel(
            scrollable_frame,
            text=description_text.strip(),
            font=ctk.CTkFont(size=12),
            justify="center"
        )
        description_label.grid(row=3, column=0, pady=20, padx=20, sticky="w")
        
        # Version info
        version_label = ctk.CTkLabel(
            scrollable_frame,
            text="PyPotteryTrace v0.1 © 2025\nLorenzo Cardarelli",
            font=ctk.CTkFont(size=11)
        )
        version_label.grid(row=4, column=0, pady=10)
        
        # Close button frame (fixed at bottom)
        button_frame = ctk.CTkFrame(info_window)
        button_frame.grid(row=1, column=0, sticky="ew", padx=20, pady=(0, 20))
        button_frame.grid_columnconfigure(0, weight=1)
        
        close_button = ctk.CTkButton(
            button_frame,
            text="Close",
            command=info_window.destroy,
            width=100
        )
        close_button.grid(row=0, column=0, pady=10)
        
        # Center the window
        info_window.update_idletasks()
        x = (info_window.winfo_screenwidth() // 2) - (500 // 2)
        y = (info_window.winfo_screenheight() // 2) - (500 // 2)
        info_window.geometry(f"500x500+{x}+{y}")
        
    def create_interface(self):
        """Create the modern interface layout."""
        
        # Main container with padding
        main_container = ctk.CTkFrame(self.root)
        main_container.grid(row=1, column=0, sticky="nsew", padx=20, pady=20)
        main_container.grid_columnconfigure(0, weight=1)  # Left panel more space
        main_container.grid_columnconfigure(1, weight=1)  # Right panel 
        main_container.grid_rowconfigure(0, weight=1)
        
        # Left panel for controls (wider)
        left_panel = ctk.CTkFrame(main_container, width=450)
        left_panel.grid(row=0, column=0, sticky="nsew", padx=(0, 5), pady=0)
        left_panel.grid_columnconfigure(0, weight=1)
        left_panel.grid_propagate(False)  # Maintain fixed width
        
        # Right panel for preview and results
        right_panel = ctk.CTkFrame(main_container)
        right_panel.grid(row=0, column=1, sticky="nsew", padx=(5, 0), pady=0)
        right_panel.grid_columnconfigure(0, weight=1)
        right_panel.grid_rowconfigure(2, weight=1)
        
        self.create_left_panel(left_panel)
        self.create_right_panel(right_panel)
        
    def create_left_panel(self, parent):
        """Create the left control panel with scrollable area."""
        
        # Create scrollable frame for the left panel content
        scrollable_left = ctk.CTkScrollableFrame(parent)
        scrollable_left.grid(row=0, column=0, sticky="nsew", padx=5, pady=5)
        scrollable_left.grid_columnconfigure(0, weight=1)
        parent.grid_rowconfigure(0, weight=1)
        
       
        # File selection section
        file_frame = ctk.CTkFrame(scrollable_left)
        file_frame.grid(row=1, column=0, sticky="ew", padx=20, pady=(0, 20))
        file_frame.grid_columnconfigure(0, weight=1)
        
        ctk.CTkLabel(file_frame, text="📁 File Selection", font=ctk.CTkFont(size=16, weight="bold")).grid(
            row=0, column=0, columnspan=2, pady=(15, 10), padx=15, sticky="w"
        )
        
        # Batch mode toggle
        batch_check = ctk.CTkCheckBox(file_frame, text="🗂️ Batch Process (Folder)", variable=self.batch_mode, command=self.toggle_batch_mode)
        batch_check.grid(row=1, column=0, columnspan=2, padx=15, pady=(0, 10), sticky="w")
        
        # Input file/folder (dynamic based on batch mode)
        self.input_label = ctk.CTkLabel(file_frame, text="Input Image:")
        self.input_label.grid(row=2, column=0, padx=15, pady=5, sticky="w")
        
        input_frame = ctk.CTkFrame(file_frame)
        input_frame.grid(row=3, column=0, columnspan=2, sticky="ew", padx=15, pady=5)
        input_frame.grid_columnconfigure(0, weight=1)
        
        self.input_entry = ctk.CTkEntry(input_frame, textvariable=self.input_file, placeholder_text="Select input image...")
        self.input_entry.grid(row=0, column=0, sticky="ew", padx=(0, 5))
        
        self.input_btn = ctk.CTkButton(input_frame, text="Browse", width=100, height=32, command=self.browse_input_file)
        self.input_btn.grid(row=0, column=1, sticky="ew")
        
        # Output SVG/Folder (dynamic based on batch mode)  
        self.output_label = ctk.CTkLabel(file_frame, text="Output SVG:")
        self.output_label.grid(row=4, column=0, padx=15, pady=(15, 5), sticky="w")
        
        svg_frame = ctk.CTkFrame(file_frame)
        svg_frame.grid(row=5, column=0, columnspan=2, sticky="ew", padx=15, pady=5)
        svg_frame.grid_columnconfigure(0, weight=1)
        
        self.svg_entry = ctk.CTkEntry(svg_frame, textvariable=self.output_svg, placeholder_text="Output SVG path...")
        self.svg_entry.grid(row=0, column=0, sticky="ew", padx=(0, 5))
        
        self.svg_btn = ctk.CTkButton(svg_frame, text="Browse", width=100, height=32, command=self.browse_output_svg)
        self.svg_btn.grid(row=0, column=1, sticky="ew")
        
        # Quick options
        quick_frame = ctk.CTkFrame(file_frame)
        quick_frame.grid(row=6, column=0, columnspan=2, sticky="ew", padx=15, pady=(15, 15))
        
        bg_check = ctk.CTkCheckBox(quick_frame, text="Include background image", variable=self.include_background_image)
        bg_check.grid(row=0, column=0, padx=10, pady=10, sticky="w")
        
        debug_check = ctk.CTkCheckBox(quick_frame, text="Save debug images", variable=self.save_debug_images)
        debug_check.grid(row=1, column=0, padx=10, pady=(0, 5), sticky="w")
        
        # Parameters section with tabs
        self.create_parameters_section(scrollable_left)
        
        # Process button
        self.process_btn = ctk.CTkButton(
            scrollable_left, 
            text="🚀 Start Vectorization", 
            font=ctk.CTkFont(size=16, weight="bold"),
            height=50,
            command=self.start_processing
        )
        self.process_btn.grid(row=3, column=0, sticky="ew", padx=20, pady=20)
        
    def create_parameters_section(self, parent):
        """Create the parameters section with tabs."""
        
        # Parameters frame
        params_frame = ctk.CTkFrame(parent)
        params_frame.grid(row=2, column=0, sticky="nsew", padx=20, pady=(0, 20))
        params_frame.grid_columnconfigure(0, weight=1)
        parent.grid_rowconfigure(2, weight=1)
        
        ctk.CTkLabel(params_frame, text="⚙️ Parameters", font=ctk.CTkFont(size=16, weight="bold")).grid(
            row=0, column=0, pady=(15, 10), padx=15, sticky="w"
        )
        
        # Tabview for parameters
        tabview = ctk.CTkTabview(params_frame)
        tabview.grid(row=1, column=0, sticky="nsew", padx=15, pady=(0, 15))
        params_frame.grid_rowconfigure(1, weight=1)
        
        # Basic tab
        tabview.add("Basic")
        basic_tab = tabview.tab("Basic")
        self.create_basic_params(basic_tab)
        
        # Advanced tab
        tabview.add("Advanced")
        advanced_tab = tabview.tab("Advanced")
        self.create_advanced_params(advanced_tab)
        
        # Presets
        tabview.add("Presets")
        presets_tab = tabview.tab("Presets")
        self.create_presets(presets_tab)
        
    def create_basic_params(self, parent):
        """Create basic parameters tab."""
        
        # Binary threshold
        ctk.CTkLabel(parent, text="Shadow Sensitivity:").grid(row=0, column=0, padx=10, pady=(10, 5), sticky="w")
        binary_frame = ctk.CTkFrame(parent)
        binary_frame.grid(row=1, column=0, sticky="ew", padx=10, pady=(0, 10))
        binary_frame.grid_columnconfigure(0, weight=1)
        
        binary_slider = ctk.CTkSlider(binary_frame, from_=5, to=50, variable=self.binary_threshold)
        binary_slider.grid(row=0, column=0, sticky="ew", padx=(10, 5), pady=10)
        
        binary_label = ctk.CTkLabel(binary_frame, textvariable=self.binary_threshold, width=40)
        binary_label.grid(row=0, column=1, padx=(5, 10), pady=10)
        
        # Smoothing
        ctk.CTkLabel(parent, text="Line Smoothing:").grid(row=2, column=0, padx=10, pady=(10, 5), sticky="w")
        smooth_frame = ctk.CTkFrame(parent)
        smooth_frame.grid(row=3, column=0, sticky="ew", padx=10, pady=(0, 10))
        smooth_frame.grid_columnconfigure(0, weight=1)
        
        smooth_slider = ctk.CTkSlider(smooth_frame, from_=0.0, to=1.0, variable=self.smoothing_factor)
        smooth_slider.grid(row=0, column=0, sticky="ew", padx=(10, 5), pady=10)
        
        smooth_label = ctk.CTkLabel(smooth_frame, text="")
        smooth_label.grid(row=0, column=1, padx=(5, 10), pady=10)
        
        def update_smooth_label(*args):
            smooth_label.configure(text=f"{self.smoothing_factor.get():.2f}")
        self.smoothing_factor.trace('w', update_smooth_label)
        update_smooth_label()
        
        # Simplification
        ctk.CTkLabel(parent, text="Path Simplification:").grid(row=4, column=0, padx=10, pady=(10, 5), sticky="w")
        epsilon_frame = ctk.CTkFrame(parent)
        epsilon_frame.grid(row=5, column=0, sticky="ew", padx=10, pady=(0, 10))
        epsilon_frame.grid_columnconfigure(0, weight=1)
        
        epsilon_slider = ctk.CTkSlider(epsilon_frame, from_=0.5, to=10.0, variable=self.epsilon)
        epsilon_slider.grid(row=0, column=0, sticky="ew", padx=(10, 5), pady=10)
        
        epsilon_label = ctk.CTkLabel(epsilon_frame, text="")
        epsilon_label.grid(row=0, column=1, padx=(5, 10), pady=10)
        
        def update_epsilon_label(*args):
            epsilon_label.configure(text=f"{self.epsilon.get():.1f}")
        self.epsilon.trace('w', update_epsilon_label)
        update_epsilon_label()
        
    def create_advanced_params(self, parent):
        """Create advanced parameters tab."""
        
        row = 0
        
        # Dotted points parameters
        ctk.CTkLabel(parent, text="🔸 Dotted Points Detection", font=ctk.CTkFont(weight="bold")).grid(
            row=row, column=0, columnspan=2, padx=10, pady=(10, 5), sticky="w"
        )
        row += 1
        
        # Min dotted area
        ctk.CTkLabel(parent, text="Min Area:").grid(row=row, column=0, padx=10, pady=5, sticky="w")
        ctk.CTkEntry(parent, textvariable=self.min_dotted_area, width=80).grid(row=row, column=1, padx=10, pady=5)
        row += 1
        
        # Max dotted area
        ctk.CTkLabel(parent, text="Max Area:").grid(row=row, column=0, padx=10, pady=5, sticky="w")
        ctk.CTkEntry(parent, textvariable=self.max_dotted_area, width=80).grid(row=row, column=1, padx=10, pady=5)
        row += 1
        
        # Circularity
        ctk.CTkLabel(parent, text="Circularity:").grid(row=row, column=0, padx=10, pady=5, sticky="w")
        circ_frame = ctk.CTkFrame(parent)
        circ_frame.grid(row=row, column=1, padx=10, pady=5, sticky="ew")
        
        circ_slider = ctk.CTkSlider(circ_frame, from_=0.1, to=1.0, variable=self.dotted_circularity, width=100)
        circ_slider.grid(row=0, column=0, padx=5, pady=5)
        
        circ_label = ctk.CTkLabel(circ_frame, text="")
        circ_label.grid(row=0, column=1, padx=5, pady=5)
        
        def update_circ_label(*args):
            circ_label.configure(text=f"{self.dotted_circularity.get():.2f}")
        self.dotted_circularity.trace('w', update_circ_label)
        update_circ_label()
        
        row += 1
        
        # Decorations parameters
        ctk.CTkLabel(parent, text="🎨 Painted Decorations", font=ctk.CTkFont(weight="bold")).grid(
            row=row, column=0, columnspan=2, padx=10, pady=(20, 5), sticky="w"
        )
        row += 1
        
        # Dark threshold
        ctk.CTkLabel(parent, text="Dark Threshold:").grid(row=row, column=0, padx=10, pady=5, sticky="w")
        ctk.CTkEntry(parent, textvariable=self.dark_threshold, width=80).grid(row=row, column=1, padx=10, pady=5)
        row += 1
        
        # Min decoration area
        ctk.CTkLabel(parent, text="Min Area:").grid(row=row, column=0, padx=10, pady=5, sticky="w")
        ctk.CTkEntry(parent, textvariable=self.min_decoration_area, width=80).grid(row=row, column=1, padx=10, pady=5)
        
    def create_presets(self, parent):
        """Create presets tab."""
        
        parent.grid_columnconfigure(0, weight=1)
        
        ctk.CTkLabel(parent, text="Quick Parameter Presets", font=ctk.CTkFont(size=14, weight="bold")).grid(
            row=0, column=0, pady=(10, 20), padx=10, sticky="w"
        )
        
        presets = [
            ("🎯 Default", "Balanced settings for most drawings", self.preset_default),
            ("🔍 High Detail", "Capture fine details and small elements", self.preset_high_detail),
            ("🌊 Smooth Curves", "Emphasize smooth, flowing lines", self.preset_smooth),
            ("⚡ Quick Process", "Fast processing with basic quality", self.preset_quick),
            ("🎨 Decorations Focus", "Optimize for painted decorations", self.preset_decorations),
            ("📝 Line Drawings", "Best for simple line drawings", self.preset_lines)
        ]
        
        for i, (name, desc, command) in enumerate(presets):
            preset_frame = ctk.CTkFrame(parent)
            preset_frame.grid(row=i+1, column=0, sticky="ew", padx=10, pady=5)
            preset_frame.grid_columnconfigure(1, weight=1)
            
            btn = ctk.CTkButton(preset_frame, text=name, width=140, height=35, command=command)
            btn.grid(row=0, column=0, padx=10, pady=10, sticky="w")
            
            ctk.CTkLabel(preset_frame, text=desc, font=ctk.CTkFont(size=11)).grid(
                row=0, column=1, padx=10, pady=10, sticky="w"
            )
            
    def create_right_panel(self, parent):
        """Create the right panel for preview and results."""
        
        parent.grid_columnconfigure(0, weight=1)
        parent.grid_rowconfigure(2, weight=1)  # Make results text area expandable
        
        # Title
        ctk.CTkLabel(parent, text="📊 Processing & Results", font=ctk.CTkFont(size=16, weight="bold")).grid(
            row=0, column=0, pady=(20, 10), padx=20, sticky="w"
        )
        
        # Progress frame
        self.progress_frame = ctk.CTkFrame(parent)
        self.progress_frame.grid(row=1, column=0, sticky="ew", padx=20, pady=(0, 10))
        self.progress_frame.grid_columnconfigure(0, weight=1)
        
        self.progress_label = ctk.CTkLabel(self.progress_frame, text="Ready to process...")
        self.progress_label.grid(row=0, column=0, padx=15, pady=10, sticky="w")
        
        self.progress_bar = ctk.CTkProgressBar(self.progress_frame)
        self.progress_bar.grid(row=1, column=0, sticky="ew", padx=15, pady=(0, 15))
        self.progress_bar.set(0)
        
        # Results text area (expandable)
        self.results_text = ctk.CTkTextbox(parent, height=200)
        self.results_text.grid(row=2, column=0, sticky="nsew", padx=20, pady=(0, 10))
        
        # Image preview area (compact)
        self.preview_frame = ctk.CTkFrame(parent)
        self.preview_frame.grid(row=3, column=0, sticky="ew", padx=20, pady=(0, 10))
        self.preview_frame.grid_columnconfigure(0, weight=1)
        
        ctk.CTkLabel(self.preview_frame, text="📷 Image Preview", font=ctk.CTkFont(size=12, weight="bold")).grid(
            row=0, column=0, pady=(10, 5), padx=15, sticky="w"
        )
        
        self.preview_label = ctk.CTkLabel(
            self.preview_frame, 
            text="No image selected",
            width=200,
            height=120,
            fg_color=("gray90", "gray20")
        )
        self.preview_label.grid(row=1, column=0, padx=15, pady=(0, 10))
        
        # Results buttons frame
        results_btn_frame = ctk.CTkFrame(parent)
        results_btn_frame.grid(row=4, column=0, sticky="ew", padx=20, pady=(0, 20))
        results_btn_frame.grid_columnconfigure(0, weight=1)
        results_btn_frame.grid_columnconfigure(1, weight=1)
        
        self.open_svg_btn = ctk.CTkButton(
            results_btn_frame, 
            text="📄 Open SVG", 
            width=120,
            height=35,
            command=self.open_svg_file,
            state="disabled"
        )
        self.open_svg_btn.grid(row=0, column=0, padx=10, pady=10, sticky="ew")
        
        self.open_folder_btn = ctk.CTkButton(
            results_btn_frame, 
            text="📁 Open Folder", 
            width=120,
            height=35,
            command=self.open_output_folder,
            state="disabled"
        )
        self.open_folder_btn.grid(row=0, column=1, padx=10, pady=10, sticky="ew")
        
    def toggle_theme(self):
        """Toggle between light and dark theme."""
        current = ctk.get_appearance_mode()
        new_mode = "dark" if current == "Light" else "light"
        ctk.set_appearance_mode(new_mode)
        
        # Update button text
        if new_mode == "dark":
            self.theme_btn.configure(text="☀️ Light Theme")
        else:
            self.theme_btn.configure(text="🌙 Dark Theme")
    
    def toggle_batch_mode(self):
        """Toggle between single file and batch processing mode."""
        if self.batch_mode.get():
            # Batch mode - process folder
            self.input_label.configure(text="Input Folder:")
            self.output_label.configure(text="Output Folder:")
            self.input_btn.configure(command=self.browse_input_folder)
            self.svg_btn.configure(command=self.browse_output_folder)
            self.process_btn.configure(text="🚀 Start Batch Processing")
        else:
            # Single file mode
            self.input_label.configure(text="Input Image:")
            self.output_label.configure(text="Output SVG:")
            self.input_btn.configure(command=self.browse_input_file)
            self.svg_btn.configure(command=self.browse_output_svg)
            self.process_btn.configure(text="🚀 Start Vectorization")
    
    def update_image_preview(self, image_path):
        """Update the image preview with the selected image."""
        try:
            # Load and resize image for preview
            img = Image.open(image_path)
            
            # Calculate size maintaining aspect ratio
            max_size = (280, 180)
            img.thumbnail(max_size, Image.Resampling.LANCZOS)
            
            # Convert to PhotoImage
            photo = ImageTk.PhotoImage(img)
            
            # Update label
            self.preview_label.configure(
                image=photo,
                text="",
                width=max_size[0],
                height=max_size[1]
            )
            # Keep a reference to prevent garbage collection
            self.preview_label.image = photo
            
            # Update info
            original_size = Image.open(image_path).size
            info_text = f"📐 {original_size[0]} × {original_size[1]} pixels\n📁 {Path(image_path).name}"
            
            # Add info label if it doesn't exist
            if not hasattr(self, 'preview_info'):
                self.preview_info = ctk.CTkLabel(
                    self.preview_frame,
                    text=info_text,
                    font=ctk.CTkFont(size=11)
                )
                self.preview_info.grid(row=2, column=0, padx=15, pady=(0, 10))
            else:
                self.preview_info.configure(text=info_text)
                
        except Exception as e:
            # Show error in preview
            self.preview_label.configure(
                image="",
                text=f"❌ Error loading image:\n{str(e)[:50]}...",
                width=280,
                height=180
            )
            if hasattr(self, 'preview_info'):
                self.preview_info.configure(text="No valid image")
    
    # File dialog methods
    def browse_input_file(self):
        """Browse for input image file."""
        filetypes = [
            ("Image files", "*.jpg *.jpeg *.png *.bmp *.tiff"),
            ("JPEG files", "*.jpg *.jpeg"),
            ("PNG files", "*.png"),
            ("All files", "*.*")
        ]
        
        filename = filedialog.askopenfilename(
            title="Select Archaeological Drawing",
            filetypes=filetypes
        )
        
        if filename:
            self.input_file.set(filename)
            # Auto-generate output paths
            base_path = Path(filename).parent
            base_name = Path(filename).stem
            
            self.output_svg.set(str(base_path / f"{base_name}_vectorized.svg"))
            self.output_jpg.set(str(base_path / f"{base_name}_comparison.jpg"))
            
            # Update image preview
            self.update_image_preview(filename)
    
    def browse_input_folder(self):
        """Browse for input folder containing images."""
        folder = filedialog.askdirectory(
            title="Select Input Folder with Archaeological Drawings"
        )
        
        if folder:
            self.input_folder.set(folder)
            self.input_file.set(folder)  # Use the same variable for display
            
            # Auto-generate output folder
            folder_path = Path(folder)
            self.output_folder.set(str(folder_path.parent / f"{folder_path.name}_vectorized"))
            self.output_svg.set(self.output_folder.get())  # Use same variable for display
    
    def browse_output_folder(self):
        """Browse for output folder."""
        folder = filedialog.askdirectory(
            title="Select Output Folder"
        )
        
        if folder:
            self.output_folder.set(folder)
            self.output_svg.set(folder)  # Use same variable for display
            
    def browse_output_svg(self):
        """Browse for output SVG file."""
        filename = filedialog.asksaveasfilename(
            title="Save SVG as...",
            defaultextension=".svg",
            filetypes=[("SVG files", "*.svg"), ("All files", "*.*")]
        )
        
        if filename:
            self.output_svg.set(filename)
            # Update JPG path too
            base_path = Path(filename).parent
            base_name = Path(filename).stem
            self.output_jpg.set(str(base_path / f"{base_name}_comparison.jpg"))
    
    # Preset methods
    def preset_default(self):
        """Default balanced settings."""
        self.binary_threshold.set(15)
        self.epsilon.set(1.5)
        self.smoothing_factor.set(0.3)
        self.min_dotted_area.set(5)
        self.max_dotted_area.set(200)
        self.dotted_circularity.set(0.6)
        self.dark_threshold.set(100)
        self.min_decoration_area.set(1000)
        
    def preset_high_detail(self):
        """High detail settings."""
        self.binary_threshold.set(10)
        self.epsilon.set(0.8)
        self.smoothing_factor.set(0.1)
        self.min_dotted_area.set(3)
        self.max_dotted_area.set(150)
        self.dotted_circularity.set(0.5)
        self.dark_threshold.set(120)
        self.min_decoration_area.set(500)
        
    def preset_smooth(self):
        """Smooth curves settings."""
        self.binary_threshold.set(20)
        self.epsilon.set(2.0)
        self.smoothing_factor.set(0.6)
        self.min_dotted_area.set(8)
        self.max_dotted_area.set(250)
        self.dotted_circularity.set(0.7)
        self.dark_threshold.set(90)
        self.min_decoration_area.set(1200)
        
    def preset_quick(self):
        """Quick processing settings."""
        self.binary_threshold.set(25)
        self.epsilon.set(3.0)
        self.smoothing_factor.set(0.2)
        self.min_dotted_area.set(10)
        self.max_dotted_area.set(300)
        self.dotted_circularity.set(0.6)
        self.dark_threshold.set(80)
        self.min_decoration_area.set(1500)
        
    def preset_decorations(self):
        """Decorations-focused settings."""
        self.binary_threshold.set(12)
        self.epsilon.set(1.0)
        self.smoothing_factor.set(0.4)
        self.min_dotted_area.set(5)
        self.max_dotted_area.set(180)
        self.dotted_circularity.set(0.6)
        self.dark_threshold.set(130)
        self.min_decoration_area.set(600)
        
    def preset_lines(self):
        """Line drawings settings."""
        self.binary_threshold.set(18)
        self.epsilon.set(1.8)
        self.smoothing_factor.set(0.3)
        self.min_dotted_area.set(8)
        self.max_dotted_area.set(250)
        self.dotted_circularity.set(0.7)
        self.dark_threshold.set(100)
        self.min_decoration_area.set(2000)
    
    # Processing methods
    def start_processing(self):
        """Start the vectorization process in a separate thread."""
        if self.processing:
            messagebox.showwarning("Processing", "Already processing! Please wait...")
            return
        
        if self.batch_mode.get():
            # Batch mode validation
            if not self.input_folder.get():
                messagebox.showerror("Error", "Please select an input folder.")
                return
            if not self.output_folder.get():
                messagebox.showerror("Error", "Please specify an output folder.")
                return
        else:
            # Single file mode validation
            if not self.input_file.get():
                messagebox.showerror("Error", "Please select an input image file.")
                return
            if not self.output_svg.get():
                messagebox.showerror("Error", "Please specify an output SVG path.")
                return
            
        # Start processing in separate thread
        self.processing = True
        processing_text = "Batch Processing..." if self.batch_mode.get() else "Processing..."
        self.process_btn.configure(state="disabled", text=processing_text)
        self.progress_bar.set(0)
        self.progress_label.configure(text="Starting vectorization...")
        self.results_text.delete("1.0", tk.END)
        
        # Disable result buttons
        self.open_svg_btn.configure(state="disabled")
        self.open_folder_btn.configure(state="disabled")
        
        if self.batch_mode.get():
            thread = threading.Thread(target=self.process_batch, daemon=True)
        else:
            thread = threading.Thread(target=self.process_single_image, daemon=True)
        thread.start()
        
    def process_single_image(self):
        """Process a single image in a separate thread."""
        try:
            # Update progress
            self.root.after(0, lambda: self.progress_bar.set(0.1))
            self.root.after(0, lambda: self.progress_label.configure(text="Loading image..."))
            
            # Get parameters
            params = {
                'image_path': self.input_file.get(),
                'output_svg_path': self.output_svg.get(),
                'output_jpg_path': self.output_jpg.get(),
                'binary_threshold': self.binary_threshold.get(),
                'epsilon': self.epsilon.get(),
                'smoothing_factor': self.smoothing_factor.get(),
                'min_dotted_area': self.min_dotted_area.get(),
                'max_dotted_area': self.max_dotted_area.get(),
                'dotted_circularity': self.dotted_circularity.get(),
                'dark_threshold': self.dark_threshold.get(),
                'min_decoration_area': self.min_decoration_area.get(),
                'show_debug_plots': False,  # Always False in GUI (plots are saved, not shown)
                'save_debug_images': self.save_debug_images.get(),
                'include_background_image': self.include_background_image.get()
            }
            
            # Update progress
            self.root.after(0, lambda: self.progress_bar.set(0.3))
            self.root.after(0, lambda: self.progress_label.configure(text="Processing image..."))
            
            # Call the vectorization function
            result_stats = vectorize_archaeological_drawing(**params)
            
            # Save processing report
            report_path = Path(self.output_svg.get()).parent / f"{Path(self.output_svg.get()).stem}_report.txt"
            self.save_processing_report(report_path, params, result_stats, Path(self.input_file.get()).name)
            
            # Update progress
            self.root.after(0, lambda: self.progress_bar.set(1.0))
            self.root.after(0, lambda: self.progress_label.configure(text="Vectorization completed!"))
            
            # Display results
            results_text = f"""✅ VECTORIZATION COMPLETED SUCCESSFULLY!

📊 Processing Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Lines detected: {result_stats['total_lines']}
🔸 Dotted points (graph): {result_stats['graph_dotted_points']}
🔸 Dotted points (separated): {result_stats['separated_dotted_points']}
🎨 Decorations (graph): {result_stats['graph_decorations']}
🎨 Decorations (separated): {result_stats['separated_decorations']}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📁 Output Files:
• SVG: {self.output_svg.get()}
• JPG Comparison: {self.output_jpg.get()}
• Processing Report: {report_path}
{f'• Background: Included at 30% opacity' if self.include_background_image.get() else '• Background: Clean vectors only'}
{f'• Debug Images: skeleton_debug.png, diagnostic_plots.png' if self.save_debug_images.get() else ''}

🎯 Parameters Used:
• Shadow Sensitivity: {self.binary_threshold.get()}
• Line Smoothing: {self.smoothing_factor.get():.2f}
• Path Simplification: {self.epsilon.get():.1f}
• Min Decoration Area: {self.min_decoration_area.get()}px

Processing completed successfully!
Ready for new processing!
"""
            
            self.root.after(0, lambda: self.results_text.insert("1.0", results_text))
            
            # Enable result buttons
            self.root.after(0, lambda: self.open_svg_btn.configure(state="normal"))
            self.root.after(0, lambda: self.open_folder_btn.configure(state="normal"))
            
        except Exception as e:
            error_msg = f"❌ ERROR DURING PROCESSING:\n\n{str(e)}\n\nPlease check your input file and parameters."
            self.root.after(0, lambda: self.results_text.insert("1.0", error_msg))
            self.root.after(0, lambda: self.progress_label.configure(text="Processing failed!"))
            
        finally:
            # Re-enable process button
            self.processing = False
            self.root.after(0, lambda: self.process_btn.configure(state="normal", text="🚀 Start Vectorization"))
    
    def process_batch(self):
        """Process multiple images in a folder."""
        try:
            input_folder = Path(self.input_folder.get())
            output_folder = Path(self.output_folder.get())
            
            # Create output folder if it doesn't exist
            output_folder.mkdir(parents=True, exist_ok=True)
            
            # Find all image files
            image_extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif'}
            image_files = []
            for ext in image_extensions:
                image_files.extend(input_folder.glob(f'*{ext}'))
                image_files.extend(input_folder.glob(f'*{ext.upper()}'))
            
            if not image_files:
                error_msg = f"❌ No image files found in {input_folder}\nSupported formats: {', '.join(image_extensions)}"
                self.root.after(0, lambda: self.results_text.insert("1.0", error_msg))
                return
            
            total_files = len(image_files)
            self.root.after(0, lambda: self.progress_label.configure(text=f"Found {total_files} images to process..."))
            
            # Get parameters once for all images
            params_base = {
                'binary_threshold': self.binary_threshold.get(),
                'epsilon': self.epsilon.get(),
                'smoothing_factor': self.smoothing_factor.get(),
                'min_dotted_area': self.min_dotted_area.get(),
                'max_dotted_area': self.max_dotted_area.get(),
                'dotted_circularity': self.dotted_circularity.get(),
                'dark_threshold': self.dark_threshold.get(),
                'min_decoration_area': self.min_decoration_area.get(),
                'show_debug_plots': False,
                'save_debug_images': self.save_debug_images.get(),
                'include_background_image': self.include_background_image.get()
            }
            
            # Process each image
            processed_count = 0
            failed_count = 0
            results_summary = []
            
            for i, image_file in enumerate(image_files):
                try:
                    # Update progress
                    progress = (i + 1) / total_files
                    self.root.after(0, lambda p=progress: self.progress_bar.set(p))
                    self.root.after(0, lambda f=image_file.name, i=i+1, t=total_files: 
                                  self.progress_label.configure(text=f"Processing {i}/{t}: {f}"))
                    
                    # Set up paths for this image
                    base_name = image_file.stem
                    params = params_base.copy()
                    params.update({
                        'image_path': str(image_file),
                        'output_svg_path': str(output_folder / f"{base_name}.svg"),
                        'output_jpg_path': str(output_folder / f"{base_name}_comparison.jpg")
                    })
                    
                    # Process the image
                    result_stats = vectorize_archaeological_drawing(**params)
                    
                    # Save processing report for this image
                    self.save_processing_report(output_folder / f"{base_name}_report.txt", params, result_stats, image_file.name)
                    
                    processed_count += 1
                    results_summary.append(f"✅ {image_file.name}: {result_stats['total_lines']} lines, {result_stats['separated_decorations']} decorations")
                    
                except Exception as e:
                    failed_count += 1
                    results_summary.append(f"❌ {image_file.name}: {str(e)}")
                    continue
            
            # Create overall summary report
            self.save_batch_summary(output_folder / "batch_summary.txt", params_base, processed_count, failed_count, results_summary)
            
            # Display results
            results_text = f"""✅ BATCH PROCESSING COMPLETED!

📊 Batch Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Total images found: {total_files}
✅ Successfully processed: {processed_count}
❌ Failed: {failed_count}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📁 Output Folder: {output_folder}
📄 Files Generated:
• {processed_count * 2} SVG + JPG files
• {processed_count} individual reports
• 1 batch summary report
{f'• Debug images (skeleton_debug.png, diagnostic_plots.png) for each image' if self.save_debug_images.get() else ''}

🔍 Individual Results:
{chr(10).join(results_summary[:10])}  # Show first 10 results
{f'... and {len(results_summary) - 10} more (see batch_summary.txt)' if len(results_summary) > 10 else ''}

Batch processing completed successfully!
"""
            
            self.root.after(0, lambda: self.results_text.insert("1.0", results_text))
            self.root.after(0, lambda: self.progress_label.configure(text="Batch processing completed!"))
            
            # Enable result buttons
            self.root.after(0, lambda: self.open_folder_btn.configure(state="normal"))
            
        except Exception as e:
            error_msg = f"❌ BATCH PROCESSING ERROR:\n\n{str(e)}\n\nPlease check your input folder and parameters."
            self.root.after(0, lambda: self.results_text.insert("1.0", error_msg))
            self.root.after(0, lambda: self.progress_label.configure(text="Batch processing failed!"))
            
        finally:
            # Re-enable process button
            self.processing = False
            self.root.after(0, lambda: self.process_btn.configure(state="normal", text="🚀 Start Batch Processing"))
    
    def save_processing_report(self, report_path: Path, params: dict, result_stats: dict, image_name: str):
        """Save detailed processing report for a single image."""
        from datetime import datetime
        
        report_content = f"""Archaeological Drawing Vectorizer - Processing Report
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

=== IMAGE INFORMATION ===
Image Name: {image_name}
Input Path: {params['image_path']}
Output SVG: {params['output_svg_path']}
Output JPG: {params['output_jpg_path']}

=== PROCESSING PARAMETERS ===
Shadow Sensitivity (binary_threshold): {params['binary_threshold']}
Path Simplification (epsilon): {params['epsilon']}
Line Smoothing (smoothing_factor): {params['smoothing_factor']:.2f}
Min Dotted Area: {params['min_dotted_area']}
Max Dotted Area: {params['max_dotted_area']}
Dotted Circularity: {params['dotted_circularity']:.2f}
Dark Threshold: {params['dark_threshold']}
Min Decoration Area: {params['min_decoration_area']}
Include Background Image: {params['include_background_image']}
Save Debug Images: {params['save_debug_images']}

=== PROCESSING RESULTS ===
Lines Detected: {result_stats['total_lines']}
Graph Dotted Points: {result_stats['graph_dotted_points']}
Separated Dotted Points: {result_stats['separated_dotted_points']}
Graph Decorations: {result_stats['graph_decorations']}
Separated Decorations: {result_stats['separated_decorations']}
Total Graph Elements: {result_stats['total_graph_elements']}
Remaining Line Pixels: {result_stats['remaining_line_pixels']}
Skeleton Pixels: {result_stats['skeleton_pixels']}

=== TECHNICAL DETAILS ===
Processing Mode: {'GUI Batch Processing' if hasattr(self, 'batch_mode') and self.batch_mode.get() else 'GUI Single Processing'}
Vectorization Method: PyPotteryTrace v2.0
Threading: Background processing thread

=== OUTPUT FILES ===
SVG File: {Path(params['output_svg_path']).name}
JPG Comparison: {Path(params['output_jpg_path']).name}
{"Debug Images: skeleton_debug.png, diagnostic_plots.png" if params['save_debug_images'] else "Debug Images: Disabled"}

Report generated successfully.
"""
        
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write(report_content)
    
    def save_batch_summary(self, summary_path: Path, params: dict, processed: int, failed: int, results: list):
        """Save batch processing summary report."""
        from datetime import datetime
        
        summary_content = f"""Archaeological Drawing Vectorizer - Batch Processing Summary
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

=== BATCH PROCESSING OVERVIEW ===
Total Images Found: {processed + failed}
Successfully Processed: {processed}
Failed: {failed}
Success Rate: {(processed / (processed + failed) * 100):.1f}%

=== COMMON PARAMETERS USED ===
Shadow Sensitivity: {params['binary_threshold']}
Path Simplification: {params['epsilon']}
Line Smoothing: {params['smoothing_factor']:.2f}
Min Dotted Area: {params['min_dotted_area']}
Max Dotted Area: {params['max_dotted_area']}
Dotted Circularity: {params['dotted_circularity']:.2f}
Dark Threshold: {params['dark_threshold']}
Min Decoration Area: {params['min_decoration_area']}
Include Background Image: {params['include_background_image']}
Save Debug Images: {params['save_debug_images']}

=== INDIVIDUAL RESULTS ===
{chr(10).join(results)}

=== FILES GENERATED ===
• {processed} SVG files
• {processed} JPG comparison files  
• {processed} individual report files
• 1 batch summary file (this file)
{"• Debug images for each processed image" if params['save_debug_images'] else ""}

=== NOTES ===
- Each processed image has its own detailed report file
- SVG files contain vectorized archaeological drawings
- JPG files show visual comparison between original and vectorized
- Debug images (if enabled) show processing steps for quality control
- All files are saved in the output folder specified

Batch processing completed successfully.
"""
        
        with open(summary_path, 'w', encoding='utf-8') as f:
            f.write(summary_content)
    
    # Result handling methods
    def open_svg_file(self):
        """Open the generated SVG file."""
        if os.path.exists(self.output_svg.get()):
            try:
                if sys.platform.startswith('darwin'):  # macOS
                    os.system(f'open "{self.output_svg.get()}"')
                elif sys.platform.startswith('win'):   # Windows
                    os.startfile(self.output_svg.get())
                else:  # Linux
                    os.system(f'xdg-open "{self.output_svg.get()}"')
            except Exception as e:
                messagebox.showerror("Error", f"Could not open SVG file:\n{e}")
        else:
            messagebox.showwarning("Warning", "SVG file not found!")
            
    def open_output_folder(self):
        """Open the output folder."""
        folder_path = Path(self.output_svg.get()).parent
        if folder_path.exists():
            try:
                if sys.platform.startswith('darwin'):  # macOS
                    os.system(f'open "{folder_path}"')
                elif sys.platform.startswith('win'):   # Windows
                    os.startfile(folder_path)
                else:  # Linux
                    os.system(f'xdg-open "{folder_path}"')
            except Exception as e:
                messagebox.showerror("Error", f"Could not open folder:\n{e}")
        else:
            messagebox.showwarning("Warning", "Output folder not found!")
    
    def run(self):
        """Start the GUI application."""
        self.root.mainloop()


def main():
    """Main entry point for the GUI application."""
    try:
        app = ArchaeologicalVectorizerGUI()
        app.run()
    except ImportError as e:
        if "customtkinter" in str(e):
            print("Error: customtkinter not installed.")
            print("Please install it with: pip install customtkinter")
        else:
            print(f"Import error: {e}")
    except Exception as e:
        print(f"Error starting GUI: {e}")


if __name__ == "__main__":
    main()