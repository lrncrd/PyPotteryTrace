#!/usr/bin/env python3
"""
Visualizzazione della Pipeline di Vettorializzazione di PyPotteryTrace

Questo script genera visualizzazioni grafiche di tutti i passaggi matematici
descritti nel documento "Fondamenti matematici della vettorializzazione archeologica".

Passaggi visualizzati:
1. Scheletrizzazione morfologica
2. Tracciamento intelligente guidato dall'intensità
3. Semplificazione RDP (Ramer-Douglas-Peucker)
4. Levigatura con curve di Bézier cubiche (Catmull-Rom)
5. Estrazione del profilo archeologico

Author: PyPotteryTrace Team
Date: November 2025
"""

import numpy as np
import cv2
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch, Polygon as MPLPolygon
from matplotlib.collections import LineCollection
from skimage.morphology import skeletonize, closing, disk
from skimage.util import img_as_ubyte
from rdp import rdp
from scipy import ndimage
from pathlib import Path
import sys

# Add parent directory to path to import existing modules
sys.path.append(str(Path(__file__).parent))

from path_tracer import (
    find_endpoints_and_junctions,
    trace_path_from_point,
    extract_main_paths,
    count_skeleton_neighbors
)


# ============================================================================
# PARAMETRI DI CONFIGURAZIONE - MODIFICA QUI
# ============================================================================

# Immagine di input
INPUT_IMAGE = "Prova_Pulizia_043.jpg"

# Directory di output per le visualizzazioni
OUTPUT_DIR = "visualizations"

# Parametri di elaborazione
THRESHOLD = 200              # Soglia di binarizzazione (0-255)
EPSILON_RDP = 1.5           # Tolleranza RDP in pixel
SMOOTHING_FACTOR = 0.3      # Fattore smoothing Bézier (0-1)
VERTICAL_CONFIDENCE = 15    # Tolleranza verticale per profili (pixel)

# Step da visualizzare (None = tutti, oppure lista es. [1, 2, 3])
STEPS_TO_VISUALIZE = None   # Visualizza tutti gli step

# ============================================================================


class VectorizationVisualizer:
    """Visualizzatore per la pipeline di vettorializzazione."""
    
    def __init__(self, image_path: str, output_dir: str = "visualizations"):
        """
        Inizializza il visualizzatore.
        
        Args:
            image_path: Percorso dell'immagine da processare
            output_dir: Directory dove salvare le visualizzazioni
        """
        self.image_path = image_path
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        
        # Carica immagine
        self.img_color = cv2.imread(image_path)
        if self.img_color is None:
            raise ValueError(f"Impossibile caricare l'immagine: {image_path}")
        
        self.img_gray = cv2.cvtColor(self.img_color, cv2.COLOR_BGR2GRAY)
        self.height, self.width = self.img_gray.shape
        
        print(f"Immagine caricata: {self.width}x{self.height} pixels")
        
    def visualize_1_skeletonization(self, threshold: int = 200):
        """
        Visualizza il processo di scheletrizzazione morfologica.
        
        Mostra:
        - Immagine originale
        - Immagine binaria
        - Chiusura morfologica
        - Scheletro finale
        
        Args:
            threshold: Soglia di binarizzazione
        """
        print("\n=== 1. SCHELETRIZZAZIONE MORFOLOGICA ===")
        
        # Applica blur leggero
        img_blur = cv2.GaussianBlur(self.img_gray, (3, 3), 0)
        
        # Inverti e binarizza
        img_inverted = cv2.bitwise_not(img_blur)
        _, binary = cv2.threshold(img_inverted, threshold, 255, cv2.THRESH_BINARY)
        
        # Chiusura morfologica per migliorare connettività
        improved = closing(binary.astype(bool), disk(5))
        
        # Scheletrizzazione
        skeleton = skeletonize(improved)
        skeleton_img = img_as_ubyte(skeleton)
        
        # Salva per uso successivo
        self.skeleton = skeleton_img
        self.binary = binary
        
        # Crea figura con 4 subplot
        fig, axes = plt.subplots(2, 2, figsize=(14, 12))
        fig.suptitle('1. Scheletrizzazione Morfologica', fontsize=16, fontweight='bold')
        
        # 1. Immagine originale
        axes[0, 0].imshow(self.img_gray, cmap='gray')
        axes[0, 0].set_title('Immagine Originale', fontsize=12)
        axes[0, 0].axis('off')
        
        # 2. Binaria
        axes[0, 1].imshow(binary, cmap='gray')
        axes[0, 1].set_title('Binarizzazione', fontsize=12)
        axes[0, 1].axis('off')
        
        # 3. Chiusura morfologica
        axes[1, 0].imshow(improved, cmap='gray')
        axes[1, 0].set_title('Chiusura Morfologica', fontsize=12)
        axes[1, 0].axis('off')
        
        # 4. Scheletro
        axes[1, 1].imshow(skeleton_img, cmap='gray')
        axes[1, 1].set_title('Scheletro (1 pixel)', fontsize=12)
        axes[1, 1].axis('off')
        
        plt.tight_layout()
        output_path = self.output_dir / "01_skeletonization.png"
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        print(f"✓ Salvato: {output_path}")
        plt.close()
        
    def visualize_2_intelligent_tracing(self, sample_region=None):
        """
        Visualizza il tracciamento intelligente guidato dall'intensità.
        
        Mostra:
        - Skeleton con endpoints e junctions
        - Mappa di intensità dell'immagine originale
        - Esempio di scoring per scelta del pixel successivo
        - Percorsi estratti colorati
        
        Args:
            sample_region: Tupla (x, y, width, height) per zoom su una regione
        """
        print("\n=== 2. TRACCIAMENTO INTELLIGENTE GUIDATO DALL'INTENSITÀ ===")
        
        # Trova endpoints e junctions
        skeleton_binary = self.skeleton > 0
        endpoints, junctions = find_endpoints_and_junctions(skeleton_binary)
        
        print(f"  Endpoints trovati: {len(endpoints)}")
        print(f"  Junctions trovati: {len(junctions)}")
        
        # Estrai percorsi principali
        main_paths = extract_main_paths(
            self.skeleton,
            original_gray=self.img_gray,
            min_path_length=20,
            max_branch_depth=5
        )
        
        print(f"  Percorsi estratti: {len(main_paths)}")
        
        # Salva per uso successivo
        self.main_paths = main_paths
        self.endpoints = endpoints
        self.junctions = junctions
        
        # Crea figura con 4 subplot
        fig = plt.figure(figsize=(16, 12))
        gs = fig.add_gridspec(2, 2, hspace=0.3, wspace=0.3)
        fig.suptitle('2. Tracciamento Intelligente Guidato dall\'Intensità', 
                     fontsize=16, fontweight='bold')
        
        # 1. Skeleton con endpoints e junctions
        ax1 = fig.add_subplot(gs[0, 0])
        ax1.imshow(self.img_gray, cmap='gray', alpha=0.5)
        ax1.imshow(self.skeleton, cmap='Reds', alpha=0.5)
        
        # Disegna endpoints (verde)
        if endpoints:
            ep_y, ep_x = zip(*endpoints)
            ax1.scatter(ep_x, ep_y, c='lime', s=80, marker='o', 
                       edgecolors='darkgreen', linewidths=2, label='Endpoints', zorder=5)
        
        # Disegna junctions (rosso)
        if junctions:
            jp_y, jp_x = zip(*junctions)
            ax1.scatter(jp_x, jp_y, c='red', s=120, marker='s', 
                       edgecolors='darkred', linewidths=2, label='Junctions', zorder=5)
        
        ax1.set_title('Punti Critici dello Scheletro', fontsize=12)
        ax1.legend(loc='upper right', fontsize=10)
        ax1.axis('off')
        
        # 2. Mappa di intensità (inversa per mostrare linee scure)
        ax2 = fig.add_subplot(gs[0, 1])
        intensity_map = 255 - self.img_gray  # Inverti: scuro = alto valore
        im = ax2.imshow(intensity_map, cmap='hot')
        ax2.set_title('Mappa Intensità (linee scure = valori alti)', fontsize=12)
        plt.colorbar(im, ax=ax2, fraction=0.046, pad=0.04)
        ax2.axis('off')
        
        # 3. Score visualization con overlay immagine
        ax3 = fig.add_subplot(gs[1, 0])
        ax3.imshow(self.img_gray, cmap='gray', alpha=0.4)
        ax3.imshow(self.skeleton, cmap='Reds', alpha=0.6)
        
        # Evidenzia una junction e i suoi vicini per mostrare lo scoring
        if junctions and len(junctions) > 0:
            # Prendi la prima junction
            junc = junctions[0]
            neighbors = []
            for ny, nx in [(junc[0]+dy, junc[1]+dx) for dy in [-1,0,1] for dx in [-1,0,1]]:
                if (0 <= ny < skeleton_binary.shape[0] and 
                    0 <= nx < skeleton_binary.shape[1] and 
                    skeleton_binary[ny, nx]):
                    neighbors.append((ny, nx))
            
            # Disegna junction centrale
            ax3.scatter(junc[1], junc[0], c='red', s=200, marker='*', 
                       edgecolors='yellow', linewidths=3, zorder=10, label='Junction')
            
            # Disegna possibili direzioni
            for n in neighbors:
                if n != junc:
                    ax3.arrow(junc[1], junc[0], n[1]-junc[1], n[0]-junc[0],
                            head_width=5, head_length=5, fc='cyan', ec='blue', 
                            alpha=0.7, linewidth=2, zorder=5)
        
        ax3.set_title('Esempio di Scoring Multi-Criterio', fontsize=12)
        ax3.legend(loc='upper right', fontsize=10)
        ax3.axis('off')
        
        # 4. Percorsi estratti colorati
        ax4 = fig.add_subplot(gs[1, 1])
        ax4.imshow(self.img_gray, cmap='gray', alpha=0.3)
        
        # Colora ogni percorso con un colore diverso
        colors = plt.cm.tab20(np.linspace(0, 1, len(main_paths)))
        
        for idx, path in enumerate(main_paths):
            if len(path) > 1:
                path_array = np.array(path)
                ax4.plot(path_array[:, 1], path_array[:, 0], 
                        color=colors[idx], linewidth=2.5, alpha=0.9)
                
                # Evidenzia start (verde) e end (rosso)
                ax4.scatter(path_array[0, 1], path_array[0, 0], 
                           c='lime', s=50, marker='o', edgecolors='black', linewidths=1.5, zorder=5)
                ax4.scatter(path_array[-1, 1], path_array[-1, 0], 
                           c='red', s=50, marker='o', edgecolors='black', linewidths=1.5, zorder=5)
        
        ax4.set_title(f'Percorsi Estratti ({len(main_paths)} paths)', fontsize=12)
        ax4.axis('off')
        
        plt.tight_layout()
        output_path = self.output_dir / "02_intelligent_tracing.png"
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        print(f"✓ Salvato: {output_path}")
        plt.close()
        
    def visualize_3_rdp_simplification(self, path_index: int = 0, epsilon: float = 1.5):
        """
        Visualizza la semplificazione RDP.
        
        Mostra:
        - Percorso originale con tutti i punti
        - Distanze perpendicolari dai punti al segmento
        - Punto con distanza massima
        - Percorso semplificato finale
        
        Args:
            path_index: Indice del percorso da visualizzare
            epsilon: Tolleranza RDP in pixel
        """
        print("\n=== 3. SEMPLIFICAZIONE RDP (RAMER-DOUGLAS-PEUCKER) ===")
        
        if not self.main_paths or path_index >= len(self.main_paths):
            print(f"  ⚠ Percorso {path_index} non disponibile")
            return
        
        # Seleziona un percorso lungo
        path = self.main_paths[path_index]
        if len(path) < 10:
            # Cerca il percorso più lungo
            path = max(self.main_paths, key=len)
            print(f"  Usando il percorso più lungo ({len(path)} punti)")
        
        print(f"  Percorso originale: {len(path)} punti")
        
        # Applica RDP
        simplified = rdp(path, epsilon=epsilon)
        print(f"  Percorso semplificato: {len(simplified)} punti (ε={epsilon}px)")
        print(f"  Riduzione: {100*(1 - len(simplified)/len(path)):.1f}%")
        
        # Crea figura
        fig, axes = plt.subplots(2, 2, figsize=(16, 14))
        fig.suptitle(f'3. Semplificazione RDP (Ramer-Douglas-Peucker, ε={epsilon}px)', 
                     fontsize=16, fontweight='bold')
        
        # 1. Percorso originale
        ax = axes[0, 0]
        ax.plot(path[:, 1], path[:, 0], 'b-', linewidth=1.5, alpha=0.7, label='Percorso originale')
        ax.scatter(path[:, 1], path[:, 0], c='blue', s=15, alpha=0.6)
        ax.scatter(path[0, 1], path[0, 0], c='lime', s=120, marker='o', 
                  edgecolors='black', linewidths=2, label='Start', zorder=5)
        ax.scatter(path[-1, 1], path[-1, 0], c='red', s=120, marker='o', 
                  edgecolors='black', linewidths=2, label='End', zorder=5)
        ax.set_title(f'Percorso Originale ({len(path)} punti)', fontsize=12)
        ax.legend(fontsize=10)
        ax.invert_yaxis()
        ax.set_aspect('equal')
        ax.grid(True, alpha=0.3)
        
        # 2. Visualizzazione distanze perpendicolari (primo step RDP)
        ax = axes[0, 1]
        
        # Calcola distanze perpendicolari dal segmento p0-pn
        p0, pn = path[0], path[-1]
        
        # Vettore del segmento
        segment_vec = pn - p0
        segment_length = np.linalg.norm(segment_vec)
        
        if segment_length > 0:
            segment_unit = segment_vec / segment_length
            
            # Calcola distanze perpendicolari
            distances = []
            for i in range(1, len(path) - 1):
                p = path[i]
                # Vettore da p0 a p
                to_p = p - p0
                # Proiezione su segment
                projection = np.dot(to_p, segment_unit) * segment_unit
                # Distanza perpendicolare
                perp_vec = to_p - projection
                dist = np.linalg.norm(perp_vec)
                distances.append(dist)
            
            # Trova punto con distanza massima
            if distances:
                max_dist_idx = np.argmax(distances) + 1  # +1 perché abbiamo saltato p0
                max_dist = distances[max_dist_idx - 1]
                max_point = path[max_dist_idx]
                
                # Disegna
                ax.plot(path[:, 1], path[:, 0], 'b-', linewidth=1, alpha=0.3)
                ax.plot([p0[1], pn[1]], [p0[0], pn[0]], 'g-', linewidth=4, 
                       label='Segmento base', zorder=4)
                
                # Disegna linee di distanza perpendicolare
                for i in range(1, len(path) - 1):
                    p = path[i]
                    to_p = p - p0
                    projection = np.dot(to_p, segment_unit) * segment_unit
                    proj_point = p0 + projection
                    
                    color = 'red' if i == max_dist_idx else 'lightgray'
                    alpha = 1.0 if i == max_dist_idx else 0.3
                    linewidth = 2.5 if i == max_dist_idx else 0.5
                    
                    ax.plot([p[1], proj_point[1]], [p[0], proj_point[0]], 
                           color=color, linewidth=linewidth, alpha=alpha, zorder=2)
                
                # Evidenzia punto con distanza massima
                ax.scatter(max_point[1], max_point[0], c='red', s=250, marker='*', 
                          edgecolors='darkred', linewidths=2, 
                          label=f'Punto max distanza', zorder=5)
        
        ax.set_title('Distanze Perpendicolari', fontsize=12)
        ax.legend(fontsize=10)
        ax.invert_yaxis()
        ax.set_aspect('equal')
        ax.grid(True, alpha=0.3)
        
        # 3. Sovrapposizione originale vs semplificato
        ax = axes[1, 0]
        ax.plot(path[:, 1], path[:, 0], 'b-', linewidth=1, alpha=0.3, label='Originale')
        ax.scatter(path[:, 1], path[:, 0], c='blue', s=5, alpha=0.3)
        ax.plot(simplified[:, 1], simplified[:, 0], 'r-', linewidth=3, 
               label='Semplificato', zorder=4)
        ax.scatter(simplified[:, 1], simplified[:, 0], c='red', s=60, 
                  edgecolors='darkred', linewidths=1.5, zorder=5)
        ax.set_title(f'Confronto: {len(path)} → {len(simplified)} punti', fontsize=12)
        ax.legend(fontsize=10)
        ax.invert_yaxis()
        ax.set_aspect('equal')
        ax.grid(True, alpha=0.3)
        
        # 4. Statistiche riduzione
        ax = axes[1, 1]
        
        # Crea un grafico a barre della riduzione
        categories = ['Originale', 'Semplificato']
        values = [len(path), len(simplified)]
        colors_bar = ['blue', 'red']
        
        bars = ax.bar(categories, values, color=colors_bar, alpha=0.7, edgecolor='black', linewidth=2)
        
        # Aggiungi valori sopra le barre
        for i, (cat, val) in enumerate(zip(categories, values)):
            ax.text(i, val + max(values)*0.02, str(val), 
                   ha='center', va='bottom', fontsize=14, fontweight='bold')
        
        # Percentuale di riduzione
        reduction = 100 * (1 - len(simplified) / len(path))
        ax.text(0.5, max(values)*0.5, f'Riduzione:\n{reduction:.1f}%', 
               ha='center', va='center', fontsize=20, fontweight='bold',
               bbox=dict(boxstyle='round', facecolor='yellow', alpha=0.8))
        
        ax.set_ylabel('Numero di Punti', fontsize=12)
        ax.set_title('Riduzione Punti', fontsize=12)
        ax.grid(True, alpha=0.3, axis='y')
        
        plt.tight_layout()
        output_path = self.output_dir / "03_rdp_simplification.png"
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        print(f"✓ Salvato: {output_path}")
        plt.close()
        
    def visualize_4_bezier_curves(self, path_index: int = 0, 
                                  epsilon: float = 1.5, 
                                  smoothing_factor: float = 0.3):
        """
        Visualizza le curve di Bézier cubiche con metodo Catmull-Rom.
        
        Mostra:
        - Percorso semplificato (poligonale)
        - Vettori tangenti (Catmull-Rom)
        - Punti di controllo della curva di Bézier
        - Curva finale smooth
        
        Args:
            path_index: Indice del percorso
            epsilon: Tolleranza RDP
            smoothing_factor: Fattore di smoothing (0-1)
        """
        print("\n=== 4. CURVE DI BÉZIER CUBICHE (METODO CATMULL-ROM) ===")
        
        if not self.main_paths:
            print("  ⚠ Nessun percorso disponibile")
            return
        
        # Seleziona percorso
        path = self.main_paths[path_index] if path_index < len(self.main_paths) else max(self.main_paths, key=len)
        
        # Semplifica
        simplified = rdp(path, epsilon=epsilon)
        print(f"  Percorso semplificato: {len(simplified)} punti")
        
        if len(simplified) < 4:
            print("  ⚠ Percorso troppo corto per Bézier cubica")
            return
        
        # Calcola curve di Bézier usando Catmull-Rom
        tension = smoothing_factor * 0.5  # τ = smoothing_factor / 2
        
        # Prepara per visualizzazione: prendi una sezione centrale
        start_idx = len(simplified) // 3
        end_idx = min(start_idx + 5, len(simplified) - 1)
        section = simplified[start_idx:end_idx + 1]
        
        print(f"  Visualizzando sezione: punti {start_idx}-{end_idx}")
        
        # Crea figura
        fig = plt.figure(figsize=(16, 12))
        gs = fig.add_gridspec(2, 2, hspace=0.3, wspace=0.3)
        fig.suptitle(f'4. Curve di Bézier Cubiche (Catmull-Rom, τ={tension:.2f})', 
                     fontsize=16, fontweight='bold')
        
        # 1. Poligonale semplificata
        ax1 = fig.add_subplot(gs[0, 0])
        ax1.plot(simplified[:, 1], simplified[:, 0], 'b-', linewidth=1.5, 
                marker='o', markersize=6, label='Poligonale RDP')
        
        # Evidenzia sezione
        ax1.plot(section[:, 1], section[:, 0], 'r-', linewidth=3, alpha=0.8,
                marker='o', markersize=10, label='Sezione visualizzata')
        
        ax1.set_title(f'Percorso Semplificato ({len(simplified)} punti)', fontsize=12)
        ax1.legend(fontsize=10)
        ax1.invert_yaxis()
        ax1.set_aspect('equal')
        ax1.grid(True, alpha=0.3)
        
        # 2. Vettori tangenti (Catmull-Rom)
        ax2 = fig.add_subplot(gs[0, 1])
        
        # Disegna poligonale
        ax2.plot(section[:, 1], section[:, 0], 'b--', linewidth=1.5, alpha=0.5, label='Poligonale')
        ax2.scatter(section[:, 1], section[:, 0], c='blue', s=120, edgecolors='black', 
                   linewidths=1.5, zorder=5)
        
        # Calcola e disegna tangenti per punti intermedi
        for i in range(1, len(section) - 1):
            p0 = section[i - 1]
            p1 = section[i]
            p2 = section[i + 1]
            
            # Tangente Catmull-Rom: t = τ(p2 - p0)
            tangent = tension * (p2 - p0)
            
            # Disegna tangente
            arrow = FancyArrowPatch(
                (p1[1], p1[0]),
                (p1[1] + tangent[1], p1[0] + tangent[0]),
                arrowstyle='->', mutation_scale=25, linewidth=3,
                color='red', zorder=4
            )
            ax2.add_patch(arrow)
        
        ax2.set_title('Vettori Tangenti (Catmull-Rom)', fontsize=12)
        ax2.legend(fontsize=10)
        ax2.invert_yaxis()
        ax2.set_aspect('equal')
        ax2.grid(True, alpha=0.3)
        
        # 3. Punti di controllo Bézier
        ax3 = fig.add_subplot(gs[1, 0])
        
        # Prendiamo un segmento specifico per mostrare i dettagli
        if len(section) >= 4:
            i = 1  # Secondo punto della sezione
            p0 = section[i - 1]
            p1 = section[i]
            p2 = section[i + 1]
            p3 = section[i + 2]
            
            # Tangenti
            t1 = tension * (p2 - p0)
            t2 = tension * (p3 - p1)
            
            # Punti di controllo
            c1 = p1 + t1 / 3
            c2 = p2 - t2 / 3
            
            # Disegna poligonale di controllo
            control_polygon = np.array([p1, c1, c2, p2])
            ax3.plot(control_polygon[:, 1], control_polygon[:, 0], 'g--', 
                    linewidth=2, alpha=0.5, label='Poligono controllo')
            
            # Disegna punti
            ax3.scatter(p1[1], p1[0], c='blue', s=180, marker='o', 
                       edgecolors='black', linewidths=2, label='Punti dati', zorder=5)
            ax3.scatter(p2[1], p2[0], c='blue', s=180, marker='o', 
                       edgecolors='black', linewidths=2, zorder=5)
            ax3.scatter(c1[1], c1[0], c='red', s=180, marker='s', 
                       edgecolors='darkred', linewidths=2, label='Punti controllo', zorder=5)
            ax3.scatter(c2[1], c2[0], c='red', s=180, marker='s', 
                       edgecolors='darkred', linewidths=2, zorder=5)
            
            # Genera curva di Bézier
            t_values = np.linspace(0, 1, 100)
            bezier_points = []
            
            for t in t_values:
                # B(t) = (1-t)³p₁ + 3(1-t)²t·c₁ + 3(1-t)t²·c₂ + t³p₂
                point = ((1 - t)**3 * p1 + 
                        3 * (1 - t)**2 * t * c1 + 
                        3 * (1 - t) * t**2 * c2 + 
                        t**3 * p2)
                bezier_points.append(point)
            
            bezier_curve = np.array(bezier_points)
            ax3.plot(bezier_curve[:, 1], bezier_curve[:, 0], 'purple', 
                    linewidth=4, label='Curva Bézier', zorder=4)
        
        ax3.set_title('Punti di Controllo Bézier', fontsize=12)
        ax3.legend(loc='best', fontsize=10)
        ax3.invert_yaxis()
        ax3.set_aspect('equal')
        ax3.grid(True, alpha=0.3)
        
        # 4. Confronto poligonale vs curva smooth
        ax4 = fig.add_subplot(gs[1, 1])
        
        # Genera curve complete per confronto
        if len(simplified) >= 4:
            # Disegna poligonale
            ax4.plot(simplified[:, 1], simplified[:, 0], 'b-', linewidth=2, 
                    alpha=0.5, label='Poligonale', zorder=3)
            ax4.scatter(simplified[:, 1], simplified[:, 0], c='blue', s=40, 
                       edgecolors='darkblue', linewidths=1, zorder=4)
            
            # Genera curve di Bézier per tutti i segmenti
            all_bezier = []
            for i in range(1, len(simplified) - 2):
                p0 = simplified[i-1] if i > 0 else simplified[0]
                p1 = simplified[i]
                p2 = simplified[i+1]
                p3 = simplified[i+2] if i+2 < len(simplified) else simplified[-1]
                
                t1 = tension * (p2 - p0)
                t2 = tension * (p3 - p1)
                
                c1 = p1 + t1 / 3
                c2 = p2 - t2 / 3
                
                t_vals = np.linspace(0, 1, 50)
                for t in t_vals:
                    pt = ((1 - t)**3 * p1 + 
                         3 * (1 - t)**2 * t * c1 + 
                         3 * (1 - t) * t**2 * c2 + 
                         t**3 * p2)
                    all_bezier.append(pt)
            
            if all_bezier:
                bezier_full = np.array(all_bezier)
                ax4.plot(bezier_full[:, 1], bezier_full[:, 0], 'red', 
                        linewidth=3, label='Curva Smooth', zorder=5, alpha=0.8)
        
        ax4.set_title('Confronto Poligonale vs Curva Smooth', fontsize=12)
        ax4.legend(fontsize=10)
        ax4.invert_yaxis()
        ax4.set_aspect('equal')
        ax4.grid(True, alpha=0.3)
        
        plt.tight_layout()
        output_path = self.output_dir / "04_bezier_curves.png"
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        print(f"✓ Salvato: {output_path}")
        plt.close()
        
    def visualize_5_profile_extraction(self, vertical_confidence: int = 15):
        """
        Visualizza l'estrazione del profilo archeologico.
        
        Mostra:
        - Profilo completo
        - Punti estremi (y_min, y_max)
        - Rette orizzontali di riferimento
        - Contorno esterno sinistro estratto
        
        Args:
            vertical_confidence: Tolleranza verticale per fondi piatti
        """
        print("\n=== 5. ESTRAZIONE PROFILO ARCHEOLOGICO ===")
        
        if not self.main_paths:
            print("  ⚠ Nessun percorso disponibile")
            return
        
        # Seleziona il percorso più lungo (presumibilmente il profilo)
        profile_path = max(self.main_paths, key=len)
        print(f"  Percorso profilo: {len(profile_path)} punti")
        
        # Trova punti estremi verticali
        y_min = np.min(profile_path[:, 0])
        y_max = np.max(profile_path[:, 0])
        
        print(f"  y_min = {y_min:.1f}, y_max = {y_max:.1f}")
        
        # Trova punti sulle rette orizzontali
        tolerance_top = 2
        tolerance_bottom = vertical_confidence
        
        top_line_points = profile_path[np.abs(profile_path[:, 0] - y_min) <= tolerance_top]
        bottom_line_points = profile_path[np.abs(profile_path[:, 0] - y_max) <= tolerance_bottom]
        
        if len(top_line_points) == 0 or len(bottom_line_points) == 0:
            print("  ⚠ Impossibile trovare punti sulle rette orizzontali")
            return
        
        # Punti di intersezione
        top_left_point = top_line_points[np.argmin(top_line_points[:, 1])]
        bottom_right_point = bottom_line_points[np.argmax(bottom_line_points[:, 1])]
        
        print(f"  Punto superiore sinistro: ({top_left_point[1]:.1f}, {top_left_point[0]:.1f})")
        print(f"  Punto inferiore destro: ({bottom_right_point[1]:.1f}, {bottom_right_point[0]:.1f})")
        
        # Trova indici nel percorso
        top_idx = np.where(np.all(profile_path == top_left_point, axis=1))[0]
        bottom_idx = np.where(np.all(profile_path == bottom_right_point, axis=1))[0]
        
        if len(top_idx) > 0 and len(bottom_idx) > 0:
            top_idx = top_idx[0]
            bottom_idx = bottom_idx[0]
            
            # Estrai contorno esterno
            if top_idx < bottom_idx:
                outer_contour = profile_path[top_idx:bottom_idx + 1]
            else:
                outer_contour = profile_path[bottom_idx:top_idx + 1]
            
            print(f"  Contorno esterno: {len(outer_contour)} punti")
        else:
            print("  ⚠ Impossibile estrarre il contorno")
            outer_contour = profile_path
        
        # Crea figura
        fig, axes = plt.subplots(2, 2, figsize=(16, 14))
        fig.suptitle(f'5. Estrazione Profilo Archeologico (τ_bottom={vertical_confidence}px)', 
                     fontsize=16, fontweight='bold')
        
        # 1. Profilo completo con rette orizzontali
        ax = axes[0, 0]
        ax.plot(profile_path[:, 1], profile_path[:, 0], 'b-', linewidth=2, label='Profilo completo')
        
        # Rette orizzontali
        x_min, x_max = np.min(profile_path[:, 1]), np.max(profile_path[:, 1])
        ax.axhline(y=y_min, color='green', linestyle='--', linewidth=2.5, 
                  label='Linea superiore', alpha=0.8)
        ax.axhline(y=y_max, color='red', linestyle='--', linewidth=2.5, 
                  label='Linea inferiore', alpha=0.8)
        
        # Banda di tolleranza
        ax.axhspan(y_min - tolerance_top, y_min + tolerance_top, 
                  color='green', alpha=0.2)
        ax.axhspan(y_max - tolerance_bottom, y_max + tolerance_bottom, 
                  color='red', alpha=0.2)
        
        ax.set_title('Profilo con Rette Orizzontali', fontsize=12)
        ax.legend(loc='best', fontsize=10)
        ax.invert_yaxis()
        ax.set_aspect('equal')
        ax.grid(True, alpha=0.3)
        
        # 2. Punti di intersezione
        ax = axes[0, 1]
        ax.plot(profile_path[:, 1], profile_path[:, 0], 'b-', linewidth=1.5, alpha=0.5)
        
        # Evidenzia punti sulle rette
        if len(top_line_points) > 0:
            ax.scatter(top_line_points[:, 1], top_line_points[:, 0], 
                      c='green', s=40, alpha=0.7, label=f'Punti superiori ({len(top_line_points)})')
        
        if len(bottom_line_points) > 0:
            ax.scatter(bottom_line_points[:, 1], bottom_line_points[:, 0], 
                      c='red', s=40, alpha=0.7, label=f'Punti inferiori ({len(bottom_line_points)})')
        
        # Punti di intersezione selezionati
        ax.scatter(top_left_point[1], top_left_point[0], 
                  c='darkgreen', s=250, marker='*', edgecolors='black', linewidths=2,
                  label='Punto superiore (sinistra)', zorder=5)
        ax.scatter(bottom_right_point[1], bottom_right_point[0], 
                  c='darkred', s=250, marker='*', edgecolors='black', linewidths=2,
                  label='Punto inferiore (destra)', zorder=5)
        
        ax.set_title('Identificazione Punti di Intersezione', fontsize=12)
        ax.legend(loc='best', fontsize=9)
        ax.invert_yaxis()
        ax.set_aspect('equal')
        ax.grid(True, alpha=0.3)
        
        # 3. Contorno esterno estratto
        ax = axes[1, 0]
        ax.plot(profile_path[:, 1], profile_path[:, 0], 'b-', linewidth=1.5, 
               alpha=0.2, label='Profilo completo')
        ax.plot(outer_contour[:, 1], outer_contour[:, 0], 'red', linewidth=4, 
               label='Contorno esterno', zorder=4)
        
        # Evidenzia start e end
        ax.scatter(outer_contour[0, 1], outer_contour[0, 0], 
                  c='lime', s=180, marker='o', edgecolors='black', linewidths=2,
                  label='Inizio', zorder=5)
        ax.scatter(outer_contour[-1, 1], outer_contour[-1, 0], 
                  c='orange', s=180, marker='o', edgecolors='black', linewidths=2,
                  label='Fine', zorder=5)
        
        ax.set_title(f'Contorno Esterno Estratto ({len(outer_contour)} punti)', fontsize=12)
        ax.legend(loc='best', fontsize=10)
        ax.invert_yaxis()
        ax.set_aspect('equal')
        ax.grid(True, alpha=0.3)
        
        # 4. Statistiche estrazione
        ax = axes[1, 1]
        
        # Grafico a torta della distribuzione punti
        original_pts = len(profile_path)
        extracted_pts = len(outer_contour)
        remaining_pts = original_pts - extracted_pts
        
        sizes = [extracted_pts, remaining_pts]
        labels = ['Contorno esterno', 'Altri punti']
        colors_pie = ['red', 'lightgray']
        explode = (0.1, 0)  # Esplodi il primo slice
        
        ax.pie(sizes, explode=explode, labels=labels, colors=colors_pie, autopct='%1.1f%%',
               shadow=True, startangle=90, textprops={'fontsize': 11})
        
        ax.set_title(f'Distribuzione Punti\n({extracted_pts}/{original_pts})', fontsize=12)
        
        plt.tight_layout()
        output_path = self.output_dir / "05_profile_extraction.png"
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        print(f"✓ Salvato: {output_path}")
        plt.close()
        
    def visualize_all(self, **kwargs):
        """
        Genera tutte le visualizzazioni.
        
        Args:
            **kwargs: Parametri opzionali per le singole visualizzazioni
        """
        print(f"\n{'='*60}")
        print("VISUALIZZAZIONE PIPELINE DI VETTORIALIZZAZIONE")
        print(f"{'='*60}")
        print(f"Immagine: {self.image_path}")
        print(f"Output: {self.output_dir}")
        print(f"{'='*60}")
        
        # 1. Scheletrizzazione
        self.visualize_1_skeletonization(
            threshold=kwargs.get('threshold', 200)
        )
        
        # 2. Tracciamento intelligente
        self.visualize_2_intelligent_tracing()
        
        # 3. RDP
        self.visualize_3_rdp_simplification(
            epsilon=kwargs.get('epsilon', 1.5)
        )
        
        # 4. Bézier
        self.visualize_4_bezier_curves(
            epsilon=kwargs.get('epsilon', 1.5),
            smoothing_factor=kwargs.get('smoothing_factor', 0.3)
        )
        
        # 5. Profilo
        self.visualize_5_profile_extraction(
            vertical_confidence=kwargs.get('vertical_confidence', 15)
        )
        
        print(f"\n{'='*60}")
        print("✓ TUTTE LE VISUALIZZAZIONI COMPLETATE")
        print(f"{'='*60}")
        print(f"\nFile salvati in: {self.output_dir.absolute()}")
        print("\nVisualizzazioni generate:")
        for i, filename in enumerate([
            "01_skeletonization.png",
            "02_intelligent_tracing.png",
            "03_rdp_simplification.png",
            "04_bezier_curves.png",
            "05_profile_extraction.png"
        ], 1):
            filepath = self.output_dir / filename
            if filepath.exists():
                print(f"  {i}. {filename}")


def main():
    """Main function - usa le variabili definite in cima al file."""
    
    # Verifica immagine
    if not Path(INPUT_IMAGE).exists():
        print(f"❌ Errore: Immagine non trovata: {INPUT_IMAGE}")
        print(f"   Percorso cercato: {Path(INPUT_IMAGE).absolute()}")
        return 1
    
    # Crea visualizzatore
    try:
        viz = VectorizationVisualizer(INPUT_IMAGE, OUTPUT_DIR)
    except Exception as e:
        print(f"❌ Errore nell'inizializzazione: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    # Parametri
    params = {
        'threshold': THRESHOLD,
        'epsilon': EPSILON_RDP,
        'smoothing_factor': SMOOTHING_FACTOR,
        'vertical_confidence': VERTICAL_CONFIDENCE
    }
    
    # Genera visualizzazioni
    try:
        if STEPS_TO_VISUALIZE:
            # Solo step selezionati
            print(f"Visualizzazione step selezionati: {STEPS_TO_VISUALIZE}")
            for step in sorted(STEPS_TO_VISUALIZE):
                if step == 1:
                    viz.visualize_1_skeletonization(threshold=params['threshold'])
                elif step == 2:
                    viz.visualize_2_intelligent_tracing()
                elif step == 3:
                    viz.visualize_3_rdp_simplification(epsilon=params['epsilon'])
                elif step == 4:
                    viz.visualize_4_bezier_curves(
                        epsilon=params['epsilon'],
                        smoothing_factor=params['smoothing_factor']
                    )
                elif step == 5:
                    viz.visualize_5_profile_extraction(
                        vertical_confidence=params['vertical_confidence']
                    )
        else:
            # Tutte le visualizzazioni
            viz.visualize_all(**params)
        
        return 0
        
    except Exception as e:
        print(f"❌ Errore durante la visualizzazione: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    exit(main())
