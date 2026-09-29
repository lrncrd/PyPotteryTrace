# Vectorization Pipeline: Mathematical Formulation

This document provides the complete mathematical formulation of the algorithms implemented in PyPotteryTrace. For a more accessible overview, see the main supplementary materials.

---

## 1. Morphological Skeletonization

Morphological skeletonization reduces binary regions of the image $I(x,y)$ to unit-width curves while preserving topology. The skeleton $S$ of a region $R$ is formally defined as:

$$S = \{p \in R \mid \exists \text{ at least two points } q_1, q_2 \in \partial R : d(p, q_1) = d(p, q_2) = d(p, \partial R)\}$$

where $\partial R$ represents the region boundary and $d(p, \partial R)$ is the minimum Euclidean distance from point $p$ to the boundary. The skeleton is the *locus* of the centers of maximal inscribed circles in the region.

The implementation uses scikit-image's `skeletonize` function, which through successive iterations removes boundary pixels while preserving 8-adjacent connectivity.

---

## 2. Intensity-Based Guidance Path Tracing

Once the binary skeleton $S$ is obtained, it is converted into a set of continuous curves $\mathcal{C} = \{C_1, C_2, \ldots, C_n\}$. The algorithm begins by identifying the skeleton's critical points:

- **Endpoints**: $E = \{p \mid |\mathcal{N}_8(p) \cap S| = 1\}$ (degree-1 nodes)
- **Junctions**: $J = \{p \mid |\mathcal{N}_8(p) \cap S| \geq 3\}$ (degree ≥ 3 nodes)

where $\mathcal{N}_8(p)$ represents the 8-connected neighborhood of pixel $p$.

### Score Function

Tracing occurs through a local search that, at each step, selects the next pixel $p_{i+1}$ based on a multi-criteria score function:

$$\text{score}(p_{i+1}) = w_d \cdot \phi_{\text{dir}}(\vec{v}_i, \vec{v}_{i+1}) + w_I \cdot \phi_{\text{int}}(p_{i+1}) + \phi_{\text{branch}}(p_{i+1})$$

where:

### Directional Continuity Term

$$\phi_{\text{dir}}(\vec{v}_i, \vec{v}_{i+1}) = \vec{v}_i \cdot \vec{v}_{i+1}$$

measures directional continuity through the dot product between consecutive direction vectors.

### Intensity Term

$$\phi_{\text{int}}(p_{i+1}) = \sum_{k=1}^{K} \frac{255 - I_{\text{gray}}(p_{i+1} + k\vec{v}_{i+1})}{1 + k \cdot \alpha}$$

evaluates line intensity along the proposed direction, sampling up to $K = 500$ pixels ahead. Darker lines (lower gray values) obtain higher scores. The denominator implements **hyperbolic decay** with $\alpha = 0.01$ to privilege closer pixels.

### Branch Penalty Term

$$\phi_{\text{branch}}(p_{i+1}) = \begin{cases} -2000 & \text{if } |\mathcal{N}_8(p_{i+1}) \cap S| \geq 4 \\ -500 & \text{if } |\mathcal{N}_8(p_{i+1}) \cap S| = 3 \\ 0 & \text{otherwise} \end{cases}$$

strongly penalizes highly branched areas, eliminating spurious branches during tracing.

### Implemented Weights

The weights are empirically calibrated as:
- $w_d = 30$ (directional continuity)
- $w_I = 2$ (intensity lookahead)

These values favor continuous paths along the most marked lines of the original drawing.

---

## 3. Geometric Simplification: Ramer-Douglas-Peucker Algorithm

The extracted paths require simplification to obtain efficient vector curves. PyPotteryTrace employs the Ramer-Douglas-Peucker (RDP) algorithm, a recursive polygonal reduction method.

Given a path $P = [p_0, p_1, \ldots, p_n]$ and a tolerance $\epsilon$, RDP operates as follows:

1. Draw the segment $\overline{p_0 p_n}$
2. Identify the point $p_k$ with maximum perpendicular distance:
   $$p_k = \arg\max_{i=1,\ldots,n-1} d_\perp(p_i, \overline{p_0 p_n})$$
3. If $d_\perp(p_k, \overline{p_0 p_n}) > \epsilon$:
   - Recursively simplify $[p_0, \ldots, p_k]$ and $[p_k, \ldots, p_n]$
4. Otherwise, approximate with segment $\overline{p_0 p_n}$

---

## 4. Smoothing with Cubic Bézier Curves: Catmull-Rom Method

To obtain visually natural curves, PyPotteryTrace converts simplified paths into cubic Bézier curves using the Catmull-Rom method to calculate control points.

Given a sequence of points $\{p_0, p_1, p_2, p_3\}$, the tangent vectors at intermediate points are calculated as:

$$\vec{t}_1 = \tau(p_2 - p_0), \quad \vec{t}_2 = \tau(p_3 - p_1)$$

where $\tau = \frac{\text{smoothing\_factor}}{2}$ is the tension parameter (default: $\tau = 0.15$ for smoothing_factor = 0.3).

The control points of the cubic Bézier curve between $p_1$ and $p_2$ are:

$$c_1 = p_1 + \frac{\vec{t}_1}{3}, \quad c_2 = p_2 - \frac{\vec{t}_2}{3}$$

The resulting curve is parametrically defined as:

$$B(t) = (1-t)^3 p_1 + 3(1-t)^2 t \, c_1 + 3(1-t)t^2 c_2 + t^3 p_2, \quad t \in [0,1]$$

This representation guarantees:

- **$C^1$ continuity**: tangents are continuous between adjacent segments (implemented via SVG `S` command for smooth curvature)
- **Interpolation**: the curve passes exactly through points $p_1$ and $p_2$
- **Local control**: modifications to a point affect only adjacent segments

---

## 5. Archaeological Profile Extraction

For archaeological profiles, PyPotteryTrace implements a specialized algorithm that extracts the vessel's **left external contour**.

### Algorithm Steps

1. **Identification of vertical extreme points**: 
   $$y_{\min} = \min_i y_i, \quad y_{\max} = \max_i y_i$$

2. **Left edge extraction**: 
   - Identify all points on the upper horizontal line:
     $$\mathcal{L}_{\text{top}} = \{p \in P \mid |y_p - y_{\min}| \leq \tau_{\text{top}}\}$$
     with $\tau_{\text{top}} = 2$ pixels
   
   - Identify all points on the lower horizontal line:
     $$\mathcal{L}_{\text{bottom}} = \{p \in P \mid |y_p - y_{\max}| \leq \tau_{\text{bottom}}\}$$
     with $\tau_{\text{bottom}} = 15$ pixels (greater tolerance to handle flat bases)
   
   - Upper intersection point (leftmost):
     $$p_{\text{top}} = \arg\min_{p \in \mathcal{L}_{\text{top}}} x_p$$
   
   - Lower intersection point (rightmost, to include the base):
     $$p_{\text{bottom}} = \arg\max_{p \in \mathcal{L}_{\text{bottom}}} x_p$$

3. **Path selection**: Given the two candidate paths between $p_{\text{top}}$ and $p_{\text{bottom}}$ on the closed curve, select the one with minimum average $x$-coordinate (i.e., the leftmost/external contour).

This process exploits the radial symmetry characteristic of ceramic profiles, allowing isolation of the external side for subsequent mirroring operations around the vertical symmetry axis.

---

## 6. Prospect (Front View): Outline and Generated Shading

A prospect mixes several drawing conventions (outline, interior lines, decoration, stippled shading). At the resolution of typical scans, dots and decoration motifs touch or overlap, so they cannot be traced reliably. PyPotteryTrace therefore extracts only the **outer border** of the prospect and **generates** the shading from the vessel shape given by the profile.

### Outline

The ink mask $M$ (high threshold) is closed with a disk of radius $\lceil w \rceil$, where $w$ is the median stroke width
$$w = 2 \cdot \operatorname{median}_{p \in S} D(p)$$
($D$ = Euclidean distance transform of the ink, $S$ its skeleton, on components $\geq 500$ px). The closed mask, together with the edge of the segmentation mask (which closes the border where it is interrupted or shared with the symmetry axis), is hole-filled. Ink-free regions that touch the outside of the segmentation mask and are no wider than $1.5w + 6$ px (the margin between the drawn border and the mask edge) are removed. The largest remaining region is the silhouette; eroding it by $w/2$ puts its contour along the middle of the drawn border. The contour is simplified (RDP) and smoothed (Section 4) into one closed path.

### Surface of Revolution

From the outer contour of the profile and the axis position $c_x$, the radius $r(y)$ is the outermost distance $|c_x - x|$ on each row, interpolated and smoothed with a Gaussian ($\sigma = \max(3, H/80)$, $H$ = profile height). A point $(x, y)$ of the prospect, with $\Delta x = x - c_x$, lies on the surface
$$F(\Delta x, y, z) = \Delta x^2 + z^2 - r(y)^2 = 0, \qquad z = \sqrt{r(y)^2 - \Delta x^2}$$
whose normal is
$$\vec{n} \propto \nabla F = \big(\Delta x,\ -r(y)\,r'(y),\ z\big)$$

### Lighting and Dot Density

With the conventional light from the upper left, $\vec{L} \propto (-1, -1, 1)$ (x right, y down, z towards the viewer), the Lambert luminance is $\ell = \hat{n} \cdot \hat{L}$, normalized to $[0,1]$ over the prospect (1st–99th percentile). The dot density is
$$\rho = \operatorname{clip}\left(\frac{\ell_0 - \ell}{\ell_0},\ 0,\ 1\right)^{\gamma}, \qquad \ell_0 = 0.75,\ \gamma = 1.3$$
so lit areas stay blank and surfaces facing down or away (under the rim, the lower body) get dense dots.

### Stippling

Dots have radius $r_d = \max(0.9, H/420)$ and spacing $s = 3.6\,r_d$ at full density. $\rho$ is averaged on a grid of cell $s$ and binarized with serpentine Floyd–Steinberg error diffusion, which yields a blue-noise distribution whose local density follows $\rho$. Each dot is jittered by up to $\pm 0.35\,s$ and drawn with radius $r_d (0.75 + 0.5\rho)$; dots closer than $\approx s$ to the outline are dropped.

---

## References

- Maragos, P. (1986). Tutorial on advances in morphological image processing and analysis. *Optical Engineering*, 26(7), 623–632.
- Dodge, M. (2011). *Algorithms for Lines and Polygons*. In: Geographic Information Science. Springer.
- Mortenson, M. E. (1999). *Mathematics for Computer Graphics Applications*. Industrial Press.
- Arasteh, S., & Kalisz, A. (2021). Conversion between cubic Bézier curves and Catmull-Rom splines. *SN Computer Science*, 2(5), 1–9.
