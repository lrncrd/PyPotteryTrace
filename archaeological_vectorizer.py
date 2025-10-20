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
import svgwrite
from rdp import rdp
import matplotlib.pyplot as plt
import math
from typing import List, Tuple, Dict, Any, Optional
from path_tracer import extract_main_paths, visualize_paths


def close_profile_curve(path: np.ndarray) -> np.ndarray:
    """
    Chiude una curva connettendo il punto finale al punto iniziale.
    
    Args:
        path: Array di punti [(y1,x1), (y2,x2), ...] che formano il profilo
        
    Returns:
        Curva chiusa con il punto iniziale aggiunto alla fine
    """
    if len(path) < 2:
        return path
    
    # Verifica se la curva è già chiusa
    start_point = path[0]
    end_point = path[-1]
    distance = np.linalg.norm(start_point - end_point)
    
    if distance < 5:  # Già abbastanza vicini
        return path
    
    # Aggiungi il punto iniziale alla fine per chiudere
    closed_path = np.vstack([path, start_point])
    
    print(f"Curva chiusa: distanza tra inizio e fine = {distance:.2f}px")
    return closed_path


def extract_outer_contour(binary_image: np.ndarray, profile_path: np.ndarray) -> np.ndarray:
    """
    Estrae il contorno esterno di un profilo archeologico.
    Il contorno esterno è quello orientato verso sinistra (verso l'esterno del vaso).
    
    Args:
        binary_image: Immagine binaria del profilo
        profile_path: Percorso del profilo tracciato
        
    Returns:
        Percorso del solo contorno esterno
    """
    if len(profile_path) < 3:
        return profile_path
    
    # Trova il contorno più esterno nell'immagine binaria
    # Questo ci dà il bordo effettivo del profilo
    contours, hierarchy = cv2.findContours(
        binary_image.astype(np.uint8) * 255, 
        cv2.RETR_EXTERNAL, 
        cv2.CHAIN_APPROX_NONE
    )
    
    if len(contours) == 0:
        print("Nessun contorno trovato, uso il percorso originale")
        return profile_path
    
    # Prendi il contorno più grande (dovrebbe essere il profilo principale)
    largest_contour = max(contours, key=cv2.contourArea)
    
    # Converti da formato OpenCV (N, 1, 2) a formato (N, 2) con (y, x)
    contour_points = largest_contour.squeeze()
    if len(contour_points.shape) == 1:
        contour_points = contour_points.reshape(1, -1)
    
    # Converti da (x, y) a (y, x) per coerenza con il resto del codice
    contour_yx = np.column_stack([contour_points[:, 1], contour_points[:, 0]])
    
    print(f"Contorno esterno estratto: {len(contour_yx)} punti")
    
    return contour_yx


def extract_left_side_of_profile(profile_path: np.ndarray, vertical_confidence: int = 30) -> np.ndarray:
    """
    Estrae il lato sinistro (esterno) di un profilo archeologico.
    
    POST-PROCESSING:
    1. Trova il punto più alto (y minimo) e più basso (y massimo) del profilo
    2. Traccia due rette ORIZZONTALI tangenti a questi punti
    3. Trova i punti di intersezione più a SINISTRA su queste rette
    4. Tiene solo la porzione di curva che sta a SINISTRA (il fronte esterno del vaso)
    5. NUOVO: Se il fondo è piatto, include tutti i punti entro vertical_confidence dalla base
    
    Args:
        profile_path: Percorso completo del profilo (array di punti y, x)
        vertical_confidence: Tolleranza verticale per fondi piatti (pixel). 
                           Punti entro questa distanza dal fondo vengono inclusi.
        
    Returns:
        Solo il lato sinistro del profilo (fronte esterno)
    """
    if len(profile_path) < 3:
        return profile_path
    
    # 1. Trova il punto più alto (y minimo) e più basso (y massimo)
    y_coords = profile_path[:, 0]
    y_top = np.min(y_coords)      # coordinata y del punto più alto
    y_bottom = np.max(y_coords)   # coordinata y del punto più basso
    
    print(f"Retta orizzontale superiore: y={y_top:.1f}")
    print(f"Retta orizzontale inferiore: y={y_bottom:.1f}")
    print(f"Tolleranza verticale per fondi piatti: {vertical_confidence}px")
    
    # 2. Trova tutti i punti sulla retta superiore (y = y_top)
    #    e sulla retta inferiore (y = y_bottom) con tolleranza estesa per fondi piatti
    tolerance_top = 2  # Tolleranza standard per il punto superiore
    tolerance_bottom = vertical_confidence  # Tolleranza estesa per il fondo (default 15px)
    
    top_line_points = profile_path[np.abs(profile_path[:, 0] - y_top) <= tolerance_top]
    bottom_line_points = profile_path[np.abs(profile_path[:, 0] - y_bottom) <= tolerance_bottom]
    
    if len(top_line_points) == 0 or len(bottom_line_points) == 0:
        print("ATTENZIONE: Nessun punto trovato sulle rette orizzontali!")
        return profile_path
    
    # 3. Trova il punto più a SINISTRA (x minimo) sulla retta SUPERIORE
    #    e il punto più a DESTRA (x massimo) sulla retta INFERIORE (per fondi piatti)
    top_left_point = top_line_points[np.argmin(top_line_points[:, 1])]
    bottom_right_point = bottom_line_points[np.argmax(bottom_line_points[:, 1])]  # CAMBIATO: argmax invece di argmin!
    
    print(f"Intersezione superiore (più a sinistra): y={top_left_point[0]:.1f}, x={top_left_point[1]:.1f}")
    print(f"Intersezione inferiore (più a DESTRA - interno): y={bottom_right_point[0]:.1f}, x={bottom_right_point[1]:.1f}")
    print(f"Punti nell'area del fondo (entro {tolerance_bottom}px da y={y_bottom:.1f}): {len(bottom_line_points)}")
    
    # 4. Trova gli indici di questi punti nel percorso originale
    top_idx = -1
    bottom_idx = -1
    
    for i, point in enumerate(profile_path):
        if np.array_equal(point, top_left_point):
            top_idx = i
        if np.array_equal(point, bottom_right_point):
            bottom_idx = i
    
    # Se non troviamo match esatti, cerca i punti più vicini
    if top_idx == -1:
        distances = np.linalg.norm(profile_path - top_left_point, axis=1)
        top_idx = np.argmin(distances)
        print(f"  Punto superiore approssimato all'indice {top_idx}")
    
    if bottom_idx == -1:
        distances = np.linalg.norm(profile_path - bottom_right_point, axis=1)
        bottom_idx = np.argmin(distances)
        print(f"  Punto inferiore approssimato all'indice {bottom_idx}")
    
    # 5. Estrai la porzione di curva tra i due punti
    # Assicurati che top_idx < bottom_idx (ordine dall'alto verso il basso)
    if top_idx > bottom_idx:
        top_idx, bottom_idx = bottom_idx, top_idx
        print("  Invertiti gli indici per mantenere l'ordine dall'alto verso il basso")
    
    # Estrai la sottosezione del percorso (SENZA chiudere - è solo un lato!)
    left_side_profile = profile_path[top_idx:bottom_idx+1]
    
    print(f"Lato sinistro estratto: {len(left_side_profile)} punti su {len(profile_path)} totali")
    print(f"  (dall'indice {top_idx} all'indice {bottom_idx})")
    print(f"  NOTA: Contorno esterno NON chiuso (è solo un lato del profilo)")
    
    # 6. NUOVO: Rimuovi fratture (segmenti corti che rientrano verso il centro)
    # Ma mantieni il fondo piatto anche se rientra
    #left_side_profile = remove_fractures_from_profile(left_side_profile, y_bottom, tolerance_bottom)
    
    return left_side_profile



def remove_fractures_from_profile(profile_path: np.ndarray, y_bottom: float, bottom_tolerance: int) -> np.ndarray:
    """
    Rimuove fratture concentrandosi su deviazioni nette, prolungate e orizzontali,
    differenziandole da curve naturali del profilo.

    Logica affinata:
    1. Richiede un cluster di punti molto densi.
    2. Identifica un cambio di direzione MOLTO BRUSCO.
    3. **AFFINATO**: Controlla che la nuova direzione sia decisamente "anomala"
       (cioè molto orizzontale) e non un semplice cambiamento verticale.
    4. **NUOVO**: Richiede che il segmento anomalo si estenda per una lunghezza minima,
       per filtrare il rumore e conservare le curve naturali.

    Args:
        profile_path: Percorso del profilo, un array di coordinate (y, x).
        y_bottom: Coordinata y della base del profilo.
        bottom_tolerance: Tolleranza in pixel per identificare la base.

    Returns:
        Un nuovo array NumPy con i punti della frattura rimossi.
    """
    # Parametri sintonizzati per essere estremamente selettivi
    MIN_PATH_LEN = 20
    LOOKBACK_ANGLE = 15  # Quanti punti guardare indietro per il vettore "prima" (aumentato)
    LOOKAHEAD_ANGLE = 15 # Quanti punti guardare avanti per il vettore "dopo" (aumentato)
    CLUSTER_SIZE = 3
    MAX_CLUSTER_DIST = 5.0 # <-- Distanza più stretta per il cluster (più selettivo)
    MIN_ANGLE_CHANGE_DEG = 60.0 # <-- Angolo minimo per un cambio "brusco" (più alto)
    RECOVERY_ANGLE_DEG = 45.0   # Tolleranza per il "ritorno"

    # NUOVO: Direzione considerata "anomala" (es. molto orizzontale)
    # Angoli vicino a 0° (dx) o 180° (sx) rispetto all'asse orizzontale
    # Se il profilo va verso il basso (y aumenta), un angolo di 90° è verticale.
    # Vogliamo eliminare quando l'angolo è tipo 0-30° o 150-180°
    MAX_ANOMALOUS_DEVIATION_FROM_VERTICAL_DEG = 30.0 # Max deviazione da 90° per essere "verticale"
    # Un angolo di 90° è perfettamente verticale verso il basso.
    # Quindi angoli "normali" saranno tra (90-30)=60 e (90+30)=120.
    # Gli angoli al di fuori di questo intervallo saranno considerati anomali.

    MIN_FRACTURE_SEGMENT_LENGTH = 10 # <-- NUOVO: Lunghezza minima del segmento anomalo

    if len(profile_path) < MIN_PATH_LEN:
        return profile_path

    print("\n-> Inizio rimozione fratture (v4 - Estremamente Conservativa e Specifica)...")

    keep_mask = np.ones(len(profile_path), dtype=bool)
    removed_fractures_count = 0
    
    i = LOOKBACK_ANGLE 
    while i < len(profile_path) - LOOKAHEAD_ANGLE:
        
        # --- 1. Identificazione del Cluster (più stretto) ---
        is_cluster = True
        for k in range(CLUSTER_SIZE - 1):
            if i + k + 1 >= len(profile_path):
                is_cluster = False; break
            dist = np.linalg.norm(profile_path[i + k + 1] - profile_path[i + k])
            if dist >= MAX_CLUSTER_DIST: # Usiamo la distanza più stretta
                is_cluster = False; break
        
        if not is_cluster:
            i += 1
            continue

        # --- 2. Analisi Angolare (con finestre più ampie per stabilità) ---
        # Il vettore "before" deve essere molto stabile, quindi guardiamo più indietro
        if i < LOOKBACK_ANGLE: # Assicurati di non andare fuori bound all'inizio
            i += 1
            continue
        before_vec = profile_path[i] - profile_path[i - LOOKBACK_ANGLE]
        before_angle_rad = np.arctan2(before_vec[0], before_vec[1]) # Angle of the path segment *before* the cluster

        # Il vettore "after" deve essere stabile, quindi guardiamo più avanti
        if i + CLUSTER_SIZE + LOOKAHEAD_ANGLE >= len(profile_path): # Assicurati di non andare fuori bound alla fine
            i += 1
            continue
        after_vec = profile_path[i + CLUSTER_SIZE + LOOKAHEAD_ANGLE] - profile_path[i + CLUSTER_SIZE]
        after_angle_rad = np.arctan2(after_vec[0], after_vec[1]) # Angle of the path segment *after* the cluster

        # Calcolo del cambio di angolo
        angle_diff_deg = np.degrees(abs(after_angle_rad - before_angle_rad))
        if angle_diff_deg > 180: angle_diff_deg = 360 - angle_diff_deg
        
        # --- 3. Condizioni di Frattura (Logica Estremamente Selettiva) ---
        is_sharp_change = angle_diff_deg > MIN_ANGLE_CHANGE_DEG
        is_near_bottom = abs(profile_path[i][0] - y_bottom) <= bottom_tolerance
        
        # **CONTROLLO AGGIUNTIVO**: la direzione dopo il cambio è decisamente "orizzontale" (anomala)?
        # Un profilo normale scende, quindi ha un angolo vicino a 90 gradi.
        # Una frattura che va a destra avrà un angolo vicino a 0 gradi, una a sinistra vicino a 180.
        after_angle_deg = np.degrees(after_angle_rad)
        
        # Normalizziamo l'angolo su 0-180 per misurare la deviazione dalla verticale (90°).
        # Ad esempio, un angolo di 10° o 170° sono entrambi a 80° dalla verticale.
        normalized_after_angle_deg = min(after_angle_deg, 180 - after_angle_deg) # Distanza da 0 o 180
        
        # La deviazione dalla verticale ideale (90°)
        deviation_from_vertical_deg = abs(normalized_after_angle_deg - 90) # Quanto è lontano da essere orizzontale (0/180) o verticale (90)
        
        # Consideriamo "anomalo" se si discosta molto dalla verticale, cioè è molto orizzontale.
        is_anomalous_horizontal_direction = deviation_from_vertical_deg > (90 - MAX_ANOMALOUS_DEVIATION_FROM_VERTICAL_DEG)
        
        # --- 4. Frattura Rilevata? ---
        if is_sharp_change and is_anomalous_horizontal_direction and not is_near_bottom:
            
            # **NUOVO: Verifica la lunghezza minima del segmento anomalo**
            potential_fracture_end_idx = -1
            current_segment_len = 0
            
            # Partiamo da dove dovrebbe iniziare la parte anomala
            start_check_for_length = i + CLUSTER_SIZE 

            for k in range(start_check_for_length, min(len(profile_path) - LOOKBACK_ANGLE, start_check_for_length + 200)): # Max search 200 pts
                if k < LOOKBACK_ANGLE: # Assicurarsi che ci sia abbastanza storia per calcolare l'angolo
                    current_segment_len = 0 # reset
                    continue

                temp_before_vec = profile_path[k] - profile_path[k - LOOKBACK_ANGLE]
                temp_before_angle_rad = np.arctan2(temp_before_vec[0], temp_before_vec[1])

                temp_after_vec = profile_path[min(k + LOOKAHEAD_ANGLE, len(profile_path) -1)] - profile_path[k] # Vettore in avanti
                temp_after_angle_rad = np.arctan2(temp_after_vec[0], temp_after_vec[1])
                
                temp_after_angle_deg = np.degrees(temp_after_angle_rad)
                temp_normalized_after_angle_deg = min(temp_after_angle_deg, 180 - temp_after_angle_deg)
                temp_deviation_from_vertical_deg = abs(temp_normalized_after_angle_deg - 90)

                temp_is_anomalous_horizontal = temp_deviation_from_vertical_deg > (90 - MAX_ANOMALOUS_DEVIATION_FROM_VERTICAL_DEG)
                
                if temp_is_anomalous_horizontal:
                    current_segment_len += 1
                    potential_fracture_end_idx = k # Mantieni l'ultimo punto anomalo trovato
                else:
                    break # Il segmento anomalo si è interrotto

            if current_segment_len < MIN_FRACTURE_SEGMENT_LENGTH:
                # Non è una frattura sufficientemente lunga, si tratta di rumore o piccola asperità.
                print(f"    -> Potenziale frattura all'indice {i} ignorata: segmento anomalo troppo corto ({current_segment_len} punti).")
                i += 1 # Passa al prossimo punto
                continue
            
            print(f"    -> Frattura RILEVATA all'indice {i}: cambio={angle_diff_deg:.1f}°, dopo={np.degrees(after_angle_rad):.1f}° (anomalo, lungo {current_segment_len}p.)")

            # --- 5. Ricerca Fine Frattura e Rimozione (logica robusta v2) ---
            start_idx = max(0, i - 5) # Rimuovi un po' prima del cluster per essere sicuri
            end_idx = -1
            
            search_start = potential_fracture_end_idx # Iniziamo a cercare la fine da dove finiva il segmento anomalo
            if search_start == -1: # Fallback se non abbiamo trovato alcun punto anomalo prolungato
                search_start = i + CLUSTER_SIZE
                
            for j in range(search_start, min(len(profile_path) - LOOKBACK_ANGLE, search_start + 200)): # Max search 200 pts
                if j < LOOKBACK_ANGLE: continue # Evita out of bounds
                current_vec = profile_path[j] - profile_path[j - LOOKBACK_ANGLE]
                current_angle_rad = np.arctan2(current_vec[0], current_vec[1])
                
                recovery_diff_deg = np.degrees(abs(current_angle_rad - before_angle_rad))
                if recovery_diff_deg > 180: recovery_diff_deg = 360 - recovery_diff_deg

                if recovery_diff_deg < RECOVERY_ANGLE_DEG:
                    end_idx = j
                    print(f"       Fine frattura trovata all'indice {end_idx} (rientro in direzione normale)")
                    break
            
            if end_idx == -1:
                end_idx = min(len(profile_path), start_idx + 200) # Se non trovata, taglia al limite
                print(f"       Fine frattura non trovata, taglio al limite (indice {end_idx})")

            keep_mask[start_idx:end_idx] = False
            removed_fractures_count += 1
            i = end_idx # Salta alla fine della sezione rimossa
            continue

        i += 1

    cleaned_profile = profile_path[keep_mask]
    removed_points = len(profile_path) - len(cleaned_profile)
    
    if removed_fractures_count > 0:
        print(f"-> Rimozione completata. Trovate e rimosse {removed_fractures_count} fratture ({removed_points} punti).")
    else:
        print("-> Nessuna frattura trovata.")
        
    return cleaned_profile


def calculate_segment_length(segment: np.ndarray) -> float:
    """Calcola la lunghezza di un segmento di percorso."""
    if len(segment) < 2:
        return 0
    
    total_length = 0
    for i in range(1, len(segment)):
        dy = segment[i][0] - segment[i-1][0]
        dx = segment[i][1] - segment[i-1][1]
        total_length += np.sqrt(dx*dx + dy*dy)
    
    return total_length


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


def classify_paths(paths: List[np.ndarray], filter_branches: bool = True) -> Dict[str, List]:
    """
    Classify extracted paths into lines (keeping all main paths).
    
    With the new intelligent path tracing, we don't need aggressive filtering
    because spurious branches are already eliminated during tracing.
    
    Args:
        paths: List of paths from extract_main_paths
        filter_branches: Whether to apply minimal filtering (kept for compatibility)
        
    Returns:
        Dictionary with classified elements
    """
    lines = []
    dotted_points = []
    path_lengths = []
    
    for path in paths:
        if len(path) < 2:
            continue
        
        # Calculate path length
        length = calculate_path_length(path)
        path_lengths.append(length)
        
        # Simple classification: very short = noise, everything else = line
        if length < 3:
            # Extremely short - noise
            dotted_points.append(path)
        else:
            # Everything else is a valid line
            # The path tracer already eliminated spurious branches
            lines.append(path)
    
    # Debug info
    if path_lengths:
        print(f"  Path lengths: min={min(path_lengths):.1f}, max={max(path_lengths):.1f}, avg={np.mean(path_lengths):.1f}")
        print(f"  Total paths: {len(paths)}")
        print(f"  Classified as lines: {len(lines)}")
        print(f"  Classified as noise: {len(dotted_points)}")
    
    return {
        'lines': lines,
        'dotted_points': [],  # Not used with path tracing
        'painted_decorations': [],
        'filtered_branches': []  # Not needed with intelligent tracing
    }


def classify_archaeological_elements(original_image: np.ndarray, 
                                   binary_image: np.ndarray, 
                                   graph,
                                   filter_branches: bool = True) -> Dict[str, List]:
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
    
    # NUOVO: Filtraggio intelligente per eliminare rami spuri
    lines = []
    dotted_points = []
    filtered_branches = []
    path_lengths = []
    
    for (s, e) in graph.edges():
        path_pixels = graph[s][e]['pts']
        
        if len(path_pixels) < 2:
            continue
            
        # Calculate path characteristics
        length = calculate_path_length(path_pixels)
        path_lengths.append(length)
        
        # NUOVO: Identifica se è un ramo spurio (breve connesso a nodo con molti vicini)
        s_degree = graph.degree(s)
        e_degree = graph.degree(e)
        max_degree = max(s_degree, e_degree)
        
        # MIGLIORATO: Criteri più conservativi per filtrare SOLO veri rami spuri
        # 1. Molto corto in assoluto (probabilmente rumore)
        is_noise = length < 3  # Ridotto da 5 a 3 per essere più conservativi
        
        # 2. Ramo spurio solo se MOLTO corto E altamente ramificato
        # Aumentata soglia lunghezza e grado per essere più selettivi
        is_short_branch = (length < 8 and max_degree >= 4)  # Era: length < 15 e degree >= 3
        
        # Applica il filtro solo se richiesto
        if not filter_branches:
            # Filtro disabilitato - classifica solo per lunghezza
            if is_noise:
                dotted_points.append((s, e, path_pixels))
            else:
                lines.append((s, e, path_pixels))
        else:
            # Filtro abilitato - elimina anche rami spuri
            if is_noise:
                # Rumore - troppo corto
                dotted_points.append((s, e, path_pixels))
            elif is_short_branch:
                # Ramo spurio - filtrato
                filtered_branches.append((s, e, path_pixels, length))
            else:
                # Linea valida - accetta tutto il resto
                lines.append((s, e, path_pixels))
    
    # Debug info
    if path_lengths:
        print(f"  Path lengths: min={min(path_lengths):.1f}, max={max(path_lengths):.1f}, avg={np.mean(path_lengths):.1f}")
        print(f"  Total edges in graph: {len(graph.edges())}")
        print(f"  Classified as lines: {len(lines)}")
        print(f"  Classified as points: {len(dotted_points)}")
        print(f"  Filtered branches (spuri): {len(filtered_branches)}")
    
    return {
        'lines': lines,
        'dotted_points': dotted_points,
        'painted_decorations': [],  # Empty - no graph decorations
        'filtered_branches': filtered_branches  # Per debug
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
                                   lines_threshold: int = 200,
                                   points_threshold: int = 30,
                                   epsilon: float = 1.5,
                                   smoothing_factor: float = 0.3,
                                   min_dotted_area: int = 5,
                                   max_dotted_area: int = 200,
                                   dotted_circularity: float = 0.6,
                                   dark_threshold: int = 100,
                                   min_decoration_area: int = 1000,
                                   filter_branches: bool = True,
                                   show_debug_plots: bool = True,
                                   save_debug_images: bool = True,
                                   include_background_image: bool = False,
                                   extract_profile_mode: bool = False,
                                   profile_vertical_confidence: int = 15) -> Dict[str, Any]:
    """
    Main function to vectorize archaeological drawings with element classification.
    Based on the proven vectorize.py workflow.
    
    Args:
        image_path: Path to input image
        output_svg_path: Path for output SVG file
        output_jpg_path: Optional path for output JPG comparison
        lines_threshold: Threshold for binarization of LINES (higher = only dark lines, 200 recommended)
        points_threshold: Threshold for binarization of POINTS (lower = captures faint points, 30 recommended)
        epsilon: RDP simplification epsilon (higher = more simplification)
        smoothing_factor: Bézier curve smoothing (0-1)
        min_dotted_area: Minimum area for dotted points
        max_dotted_area: Maximum area for dotted points
        dotted_circularity: Minimum circularity for dotted points
        dark_threshold: Threshold for finding dark decorations
        min_decoration_area: Minimum area for painted decorations
        filter_branches: Whether to filter short spurious branches (default True). Set False to keep all lines.
        show_debug_plots: Whether to show matplotlib debug plots
        save_debug_images: Whether to save debug PNG files
        include_background_image: Whether to include original image as background in SVG
        extract_profile_mode: If True, extracts only a closed profile curve with external contour only (default False)
        profile_vertical_confidence: Tolleranza verticale in pixel per fondi piatti nei profili (default 15px)
        
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
    height, width = int(height), int(width)  # Convert numpy int to Python int for SVG
    print(f"Image dimensions: {width} x {height}")
    
    # Apply light blur to reduce noise
    img_blur = cv2.GaussianBlur(img_gray, (3, 3), 0)
    
    # DUAL THRESHOLD APPROACH
    # Create TWO separate binarizations for better element separation
    print("Using DUAL THRESHOLD approach...")
    print(f"  - Lines threshold: {lines_threshold} (higher = only marked lines)")
    print(f"  - Points threshold: {points_threshold} (lower = captures faint points)")
    
    # Invert image (black lines become white)
    img_inverted = cv2.bitwise_not(img_blur)
    
    # HIGH threshold for LINES only (captures only dark/marked lines)
    _, binary_lines = cv2.threshold(img_inverted, lines_threshold, 255, cv2.THRESH_BINARY)
    
    # LOW threshold for POINTS (captures even faint/light points)
    _, binary_points = cv2.threshold(img_inverted, points_threshold, 255, cv2.THRESH_BINARY)
    
    print(f"White pixels in LINES binarization: {np.sum(binary_lines > 0)}")
    print(f"White pixels in POINTS binarization: {np.sum(binary_points > 0)}")
    
    # Convert to boolean for subsequent processing
    binary_lines_bool = binary_lines.astype(bool)
    binary_points_bool = binary_points.astype(bool)

    # --- 2. Separation of Dotted Points, Decorations and Lines ---
    print("Separating dotted points, decorations and lines...")
    
    # Identify dotted points using LOW threshold (captures faint points)
    dotted_points = find_dotted_points(binary_points_bool, min_dotted_area, max_dotted_area, dotted_circularity)
    print(f"Found {len(dotted_points)} dotted points")
    
    # NOTE: Decorations are NOT processed in this version
    # The function now only handles LINES and POINTS
    
    # Create mask without dotted points for line skeletonization
    # Use HIGH threshold binary (only marked lines)
    lines_mask = binary_lines_bool.copy()
    
    # Remove dotted points from lines mask
    for (center_y, center_x, radius) in dotted_points:
        y_min = max(0, center_y - radius - 2)
        y_max = min(binary_lines_bool.shape[0], center_y + radius + 3)
        x_min = max(0, center_x - radius - 2)
        x_max = min(binary_lines_bool.shape[1], center_x + radius + 3)
        lines_mask[y_min:y_max, x_min:x_max] = False
    
    remaining_pixels = np.sum(lines_mask)
    print(f"Pixels remaining for lines: {remaining_pixels}")

    # --- 3. Skeletonization Only of Lines ---
    print("Performing skeletonization of lines...")
    
    if remaining_pixels > 0:
        # NUOVO: Remove small circular blobs that could be residual points
        # This prevents skeleton fragmentation in areas with many points
        print("  Filtering out small circular areas (residual points)...")
        from skimage.morphology import area_opening, remove_small_objects
        from scipy import ndimage
        
        # Label connected components
        labeled_mask, num_features = ndimage.label(lines_mask)
        
        # Analyze each component
        cleaned_mask = np.zeros_like(lines_mask)
        removed_count = 0
        
        for i in range(1, num_features + 1):
            component = (labeled_mask == i)
            area = np.sum(component)
            
            # Skip very small components (likely noise)
            if area < 10:
                removed_count += 1
                continue
            
            # Check circularity - remove circular blobs (likely points)
            if area < 500:  # Only check small components
                coords = np.argwhere(component)
                if len(coords) > 0:
                    # Calculate bounding box
                    y_min, x_min = coords.min(axis=0)
                    y_max, x_max = coords.max(axis=0)
                    comp_width = x_max - x_min + 1
                    comp_height = y_max - y_min + 1
                    
                    # Calculate aspect ratio
                    aspect_ratio = max(comp_width, comp_height) / (min(comp_width, comp_height) + 1e-6)
                    
                    # If roughly square/circular and small, it's likely a point - REMOVE
                    if aspect_ratio < 2.0:  # Nearly square = likely point
                        removed_count += 1
                        continue
            
            # Keep this component - it's a line
            cleaned_mask |= component
        
        print(f"  Removed {removed_count} small circular components (points)")
        print(f"  Kept {num_features - removed_count} line components")
        
        lines_mask = cleaned_mask
        remaining_pixels = np.sum(lines_mask)
        print(f"  Pixels after point filtering: {remaining_pixels}")
        
        # MIGLIORATO: Improve connectivity with larger disk for better line connection
        # disk(2) -> disk(5) per connettere meglio le linee interrotte
        print("  Improving line connectivity with morphological closing...")
        improved_lines = closing(lines_mask, disk(5))
        
        connectivity_improvement = np.sum(improved_lines) - remaining_pixels
        print(f"  Pixels added by closing: {connectivity_improvement}")
        
        # Skeletonization only of lines
        skeleton = skeletonize(improved_lines)
        skeleton_img = img_as_ubyte(skeleton)
        
        skeleton_pixels = np.sum(skeleton_img > 0)
        print(f"Skeleton pixels for lines: {skeleton_pixels}")
    else:
        print("No lines to skeletonize")
        skeleton_img = np.zeros_like(binary_lines, dtype=np.uint8)
        skeleton_pixels = 0

    # --- 3. NUOVO: Smart Path Extraction ---
    print("\n=== INTELLIGENT PATH TRACING ===")
    print("Extracting main paths from skeleton using smart tracing...")
    
    # Use intelligent path tracing instead of sknw
    # Pass the GRAYSCALE original image to follow darker (stronger) lines
    main_paths = extract_main_paths(
        skeleton_img,
        original_gray=img_gray,  # Pass grayscale to follow darker/stronger lines
        min_path_length=30,  # Increased to 30 to ignore small disconnected fragments
        max_branch_depth=5   # Don't follow deep branches
    )
    
    print(f"Extracted {len(main_paths)} main paths")
    
    # === MODALITÀ PROFILO: Processa il percorso principale ===
    if extract_profile_mode:
        print("\n=== MODALITÀ PROFILO ARCHEOLOGICO ===")
        
        if len(main_paths) == 0:
            print("ERRORE: Nessun percorso trovato!")
            classified_elements = {
                'lines': [], 
                'dotted_points': [], 
                'painted_decorations': [],
                'dotted_points_separate': [],
                'painted_decorations_separate': []
            }
        else:
            # Prendi il percorso più lungo (dovrebbe essere il profilo principale)
            longest_path = max(main_paths, key=len)
            print(f"Percorso principale selezionato: {len(longest_path)} punti")
            
            # 1. Chiudi la curva
            closed_profile = close_profile_curve(longest_path)
            print(f"Curva chiusa: {len(closed_profile)} punti")
            
            # 2. Estrai il contorno esterno (lato sinistro) - SOLO per il ribaltamento
            outer_contour = extract_left_side_of_profile(closed_profile, profile_vertical_confidence)
            print(f"Contorno esterno: {len(outer_contour)} punti")
            
            # Salva la CURVA CHIUSA COMPLETA come elemento principale
            # e il contorno esterno nei dati aggiuntivi
            classified_elements = {
                'lines': [closed_profile],  # CURVA COMPLETA CHIUSA
                'dotted_points': [],
                'painted_decorations': [],
                'dotted_points_separate': [],
                'painted_decorations_separate': [],
                'profile_data': {  # Dati aggiuntivi per il profilo
                    'full_closed_profile': closed_profile,  # Curva completa chiusa
                    'outer_contour': outer_contour  # Solo lato esterno (per ribaltamento)
                }
            }
            
            print("✓ Profilo estratto: curva chiusa completa")
            
            # Crea visualizzazione del profilo estratto
            if save_debug_images:
                visualize_paths(img_gray, [closed_profile], 'diagnostic_paths.png')
    else:
        # === MODALITÀ NORMALE (scheletro completo) ===
        # Create visualization of extracted paths
        if save_debug_images:
            visualize_paths(img_gray, main_paths, 'diagnostic_paths.png')
        
        # --- 4. Archaeological Element Classification ---
        print("\nClassifying archaeological elements...")
        classified_elements = classify_paths(main_paths, filter_branches)
    
    # Add elements found separately (before skeletonization)
    # Ma solo se NON siamo in modalità profilo
    if not extract_profile_mode:
        classified_elements['dotted_points_separate'] = dotted_points
        # NOTE: No decorations in this version
    
    # Create skeleton debug with final results
    if save_debug_images:
        create_skeleton_debug_image(img_gray, classified_elements)
    
    # --- 5. Enhanced SVG Saving ---
    print(f"\nSaving classified SVG file to {output_svg_path}...")
    save_classified_svg(classified_elements, output_svg_path, width, height, epsilon, smoothing_factor, 
                       image_path if include_background_image else None)
    
    # Generate JPG comparison if requested
    if output_jpg_path:
        print(f"Generating JPG comparison to {output_jpg_path}...")
        generate_jpg_comparison(classified_elements, output_jpg_path, width, height, 
                              is_profile_mode=extract_profile_mode)
    
    # Statistics
    stats = {
        'total_lines': len(classified_elements['lines']),
        'graph_dotted_points': len(classified_elements['dotted_points']),
        'separated_dotted_points': len(classified_elements.get('dotted_points_separate', [])),
        'total_paths_extracted': len(main_paths),
        'remaining_line_pixels': remaining_pixels,
        'skeleton_pixels': skeleton_pixels
    }
    
    # Add profile_data if in profile mode
    if extract_profile_mode and 'profile_data' in classified_elements:
        stats['profile_data'] = classified_elements['profile_data']
    
    print("\n=== ARCHAEOLOGICAL ELEMENT CLASSIFICATION ===")
    print(f"Lines: {stats['total_lines']}")
    print(f"Graph dotted points: {stats['graph_dotted_points']}")
    print(f"Separated dotted points: {stats['separated_dotted_points']}")
    print(f"Total paths extracted: {stats['total_paths_extracted']}")
    print("Conversion completed!")
    
    if show_debug_plots:
        show_diagnostic_plots(img_gray, binary_lines, skeleton_img, classified_elements)
    
    return stats


import cv2
import numpy as np
from skimage.morphology import skeletonize, closing, disk
from skimage.util import img_as_ubyte
from scipy import ndimage
from typing import Optional, Dict, Any, List, Tuple





def create_graph_debug_image(original: np.ndarray, graph, output_path: str):
    """
    Create debug image showing ALL edges in the graph.
    This helps identify if lines are in the graph but not being classified.
    
    Args:
        original: Original grayscale image
        graph: NetworkX graph
        output_path: Path to save the debug image
    """
    print(f"Creating graph debug image with {len(graph.edges())} edges...")
    
    # Start with original image as background
    debug_img = cv2.cvtColor(original, cv2.COLOR_GRAY2BGR)
    
    # Draw ALL edges in the graph in CYAN
    edge_count = 0
    for (s, e) in graph.edges():
        path_pixels = graph[s][e]['pts']
        
        if len(path_pixels) > 0:
            edge_count += 1
            # Draw path in CYAN (visible on grayscale)
            for i in range(len(path_pixels)-1):
                y1, x1 = int(path_pixels[i][0]), int(path_pixels[i][1])
                y2, x2 = int(path_pixels[i+1][0]), int(path_pixels[i+1][1])
                if (0 <= y1 < debug_img.shape[0] and 0 <= x1 < debug_img.shape[1] and
                    0 <= y2 < debug_img.shape[0] and 0 <= x2 < debug_img.shape[1]):
                    cv2.line(debug_img, (x1, y1), (x2, y2), (255, 255, 0), 2)  # Cyan
    
    # Draw nodes in RED (endpoints and junctions)
    for node in graph.nodes():
        y, x = int(graph.nodes[node]['o'][0]), int(graph.nodes[node]['o'][1])
        if 0 <= y < debug_img.shape[0] and 0 <= x < debug_img.shape[1]:
            cv2.circle(debug_img, (x, y), 3, (0, 0, 255), -1)  # Red
    
    cv2.imwrite(output_path, debug_img)
    print(f"Saved {output_path} with {edge_count} edges and {len(graph.nodes())} nodes")


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
    
    # NUOVO: Draw filtered branches in ORANGE (to see what was filtered out)
    for item in classified_elements.get('filtered_branches', []):
        if len(item) >= 3:  # (s, e, path_pixels, length)
            path_pixels = item[2]
            for i in range(len(path_pixels)-1):
                y1, x1 = int(path_pixels[i][0]), int(path_pixels[i][1])
                y2, x2 = int(path_pixels[i+1][0]), int(path_pixels[i+1][1])
                if (0 <= y1 < debug_img.shape[0] and 0 <= x1 < debug_img.shape[1] and
                    0 <= y2 < debug_img.shape[0] and 0 <= x2 < debug_img.shape[1]):
                    cv2.line(debug_img, (x1, y1), (x2, y2), (0, 165, 255), 1)  # Orange thin
    
    # Draw lines in BLUE (thick for visibility)
    for path_pixels in classified_elements['lines']:
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
    
    # NOTE: No decorations in this version
    
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
    # Use 'full' profile instead of 'tiny' to avoid size restrictions
    dwg = svgwrite.Drawing(svg_path, size=(f'{width}px', f'{height}px'), profile='full')
    
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
    for path_pixels in classified_elements['lines']:
        # path_pixels is now directly a numpy array from path tracer
        simplified_path = rdp(path_pixels, epsilon=epsilon)
        if len(simplified_path) > 1:
            # Verifica se il percorso è chiuso (primo e ultimo punto MOLTO vicini)
            # Soglia conservativa: solo se < 2px (praticamente coincidenti)
            is_closed = False
            if len(simplified_path) >= 3:
                start_point = simplified_path[0]
                end_point = simplified_path[-1]
                distance = np.linalg.norm(start_point - end_point)
                # MOLTO conservativo: chiudi solo se DAVVERO vicini (< 2px)
                # Questo evita di chiudere curve che sono solo "parziali" (come il contorno esterno)
                is_closed = distance < 2.0  
            
            if smoothing_factor > 0:
                # Use Bézier curves for smooth lines
                path_data = smooth_path_to_bezier(simplified_path, smoothing_factor)
            else:
                # Use simple lines if smoothing = 0
                path_data = f"M {simplified_path[0, 1]:.2f},{simplified_path[0, 0]:.2f}"
                for i in range(1, len(simplified_path)):
                    path_data += f" L {simplified_path[i, 1]:.2f},{simplified_path[i, 0]:.2f}"
            
            # Aggiungi "Z" per chiudere il percorso SOLO se è veramente chiuso
            if is_closed and path_data:
                path_data += " Z"
            
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
    
    # NOTE: Decorations are NOT saved in this version
    # Only LINES and POINTS are exported
    
    dwg.save()


def generate_jpg_comparison(classified_elements: Dict[str, List], 
                          jpg_path: str, 
                          width: int, 
                          height: int,
                          is_profile_mode: bool = False):
    """
    Generate a JPG comparison image showing the vectorized elements.
    Handles both skeleton mode and profile mode.
    """
    print(f"-> Generating JPG comparison at {jpg_path}...")
    
    # Create white background
    img = np.ones((height, width, 3), dtype=np.uint8) * 255
    
    if is_profile_mode:
        # === PROFILE MODE: Draw only the profile path ===
        if 'lines' in classified_elements and classified_elements['lines']:
            # Extract the profile path (first and only element)
            profile_path = classified_elements['lines'][0]
            
            # Convert to integer points for OpenCV
            points = np.array(profile_path, dtype=np.int32).reshape((-1, 1, 2))
            
            # Swap y,x to x,y for OpenCV
            points_xy = np.column_stack([profile_path[:, 1], profile_path[:, 0]]).astype(np.int32)
            points_xy = points_xy.reshape((-1, 1, 2))
            
            # Draw the profile path (not closed, just the external contour)
            cv2.polylines(img, [points_xy], isClosed=False, color=(0, 0, 255), thickness=2)
            print(f"   - Drew profile path with {len(profile_path)} points")
    else:
        # === SKELETON MODE: Original drawing logic ===
        # Draw lines in black
        for path_pixels in classified_elements['lines']:
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
    print("   - JPG comparison saved.")


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
    for i, path_pixels in enumerate(classified_elements['lines']):
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