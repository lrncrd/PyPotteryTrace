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

A prospect mixes several drawing conventions (outline, interior lines, decoration, stippled shading). At the resolution of typical scans, dots and decoration motifs touch or overlap, so they cannot be traced reliably. PyPotteryTrace therefore extracts only the **outer border** of the prospect; shading and decoration are then produced in the **Prospect Canvas** tab, where the shading is **generated** from the vessel shape given by the profile (below) and decorations are drawn with brushes. The canvas computes everything in the browser (`interactive_app/static/js/prospect/`) and stores its parameters in the SVG, so the result stays editable.

### Outline

The ink mask $M$ (high threshold) is closed with a disk of radius $\lceil w \rceil$, where $w$ is the median stroke width
$$w = 2 \cdot \operatorname{median}_{p \in S} D(p)$$
($D$ = Euclidean distance transform of the ink, $S$ its skeleton, on components $\geq 500$ px). The closed mask, together with the edge of the segmentation mask (which closes the border where it is interrupted or shared with the symmetry axis), is hole-filled. Ink-free regions that touch the outside of the segmentation mask and are no wider than $1.5w + 6$ px (the margin between the drawn border and the mask edge) are removed. The largest remaining region is the silhouette; eroding it by $w/2$ puts its contour along the middle of the drawn border. The contour is simplified (RDP) and smoothed (Section 4) into one closed path.

### Surface of Revolution

From the profile section and the axis position $c_x$, the radius $r(y)$ is the outermost distance $|c_x - x|$ on each row crossed by the section, interpolated and smoothed with a Gaussian ($\sigma = \max(3, H/80)$, $H$ = profile height). Above and below the section $r(y)$ continues with the end slope of the profile. A point $(x, y)$ of the prospect, with $\Delta x = x - c_x$, lies on the surface
$$F(\Delta x, y, z) = \Delta x^2 + z^2 - r(y)^2 = 0, \qquad z = \sqrt{r(y)^2 - \Delta x^2}$$
whose normal is
$$\vec{n} \propto \nabla F = \big(\Delta x,\ -r(y)\,r'(y),\ z\big)$$

### Lighting and Dot Density

With the conventional light from the upper left, $\vec{L} \propto (-1, -1, 1)$ (x right, y down, z towards the viewer; direction and elevation are adjustable in the canvas), the Lambert luminance is $\ell = \hat{n} \cdot \hat{L}$, normalized to $[0,1]$ over the prospect (1st–99th percentile). The dot density is
$$\rho = \operatorname{clip}\left(\frac{\ell_0 - \ell}{\ell_0},\ 0,\ 1\right)^{\gamma}, \qquad \ell_0 = 0.75,\ \gamma = 1.3$$
so lit areas stay blank and surfaces facing down or away (under the rim, the lower body) get dense dots. In **tone** mode the same density is rendered as a continuous grey, $255\,(1 - k\rho)$ with darkness $k$ (default 0.85), embedded as a PNG image.

### Stippling

Dots have radius $r_d = \max(0.9, H/420)$ and spacing $s = 3.6\,r_d$ at full density. The dots are a variable-density blue noise (dart throwing): candidates on a jittered grid of step $0.5\,r_{min}$ are taken in random order and kept if they are inside the prospect, clear of the outline and of the decorations, and farther from every kept dot than the mean of the two local radii $r(\mathbf{x}) = 0.83\,s/\sqrt{\rho(\mathbf{x})}$ (a saturated dart throw packs $0.7/r^2$ dots per px², so the count is $\rho/s^2$, as for an ordered dither, without its rows and worms; no dot where $\rho < 0.03$). Each dot is drawn with radius $r_d (0.75 + 0.5\rho)$. Dots keep only $1.3\,r_d$ from the outline, so the shading reaches the drawn border, and never fall on a decoration or within $1.5\,r_d$ of it. The density and dot-size sliders scale $s$ and $r_d$.

### Decoration Brushes

A decoration is a guide polyline (a horizontal band clipped to the outline, a polyline, or a freehand stroke smoothed by Chaikin corner cutting) plus a brush. The **groove** brush draws $n$ parallel copies of the guide, offset along its normal (miter joins, limited at sharp zig-zag corners); the **impressions** brush places a stamp (an ellipse of given length and width, rotated by a fixed angle to the local tangent) every $s$ px of arc length, in one or more parallel rows. Nothing is cut by the brushes: every decoration is drawn under a clip path equal to the prospect outline (canvas clip; `<clipPath>` in the SVG), so marks crossing the border appear cut, as on the vessel, and the shading dots are kept away only from the visible part of a mark.

**Variability.** Stamps are placed at arc-length $s_k$ along the guide, $s_{k+1} = s_k + \sigma\,(1 + v_s\,u_1)$ with $u_i$ uniform in $[-1,1]$, shifted across the path by $v_o u_2$, scaled by $(1 + v_z u_3)$ (times a factor $\beta$ for a random share $p_\beta$ of larger marks) and rotated by $v_a u_4$ on top of the fixed angle to the path. The draws come from a seeded generator (mulberry32) stored with each decoration, so the same decoration is redrawn identically when the SVG is reopened; \"New variation\" only changes the seed. The **digitate cord** is a band around the guide whose edges swell as $\pm\big(w/2 + a\cos(2\pi s/\sigma)\big)$ in step with the finger impressions, drawn in relief (shadow outside the edge facing away from the light) with incised oval impressions along its middle.

Decorations are shaded by the same light. With $\hat{\ell}$ the direction of the light projected on the drawing plane and $\hat{n}$ the outward normal of the mark's outline (for a groove, of each edge of the stroke), an **incised or impressed** mark has its wall in shadow where $\hat{n}\cdot\hat{\ell} > 0$ (the wall slopes down into the mark and faces away from the light), a **relief** (protruding) mark where $\hat{n}\cdot\hat{\ell} < 0$. The stroke is thickened there by $w_s \max(0, \pm\,\hat{n}\cdot\hat{\ell})$, towards the inside of an impression and the outside of a relief, and written as a filled even-odd shape.

A **single mark** (Stamp tool) is the impressions brush with `single`: one stamp at the middle of a short guide instead of a row.

The **wide incision** is a channel of width $w$ around the guide, drawn as its outline. The half-width along the guide is $h\,k(s)$ where $k$ is 1 for flat and open ends, $\sqrt{1-(1-t)^2}$ for a rounded end and $t$ for a pointed one, with $t = \min(1, d/L_c)$, $d$ the distance from that end and $L_c = h\,c$ the closing length ($c$ adjustable; the two ends share a short guide). Each end can be closed (flat, rounded, pointed) or left open, in which case the outline is cut there. The guide is first rounded (Chaikin) so that the walls do not fold at clicked corners. The wall shadow follows the rule above, with the thickness limited to $0.7$ of the local half-width and smoothed along the outline so that it does not jump at the corners of the ends. The centerline of a hand-drawn stroke is smoothed over a window of about $1.2\,h$ before the walls are offset, so they do not fold. Parallel channels are $w + g$ apart (channel width plus the clear gap), so widening a channel never makes neighbours overlap; an end of the guide that lies outside the prospect is treated as open (the channel continues beyond the border), and the Band tool extends its guide well beyond the outline. The floor of a mark is shaded by the mark itself: a channel is dark next to the wall in shadow, with density $f\,(1-a)^{1.4}$ ($f$ the shadow factor of that wall, $a$ the distance from it as a fraction of the width); an incised impression is dark next to the rim facing the light and a relief boss on the side away from it, $ho = ig((\pm\hat{q}\cdot\hat{\ell} + 0.2)/1.2ig)^{1.4}$ with $\hat{q}$ the position in the unit disc of the mark. Inside these regions the shading density of the prospect is *replaced* by the density of the mark, and the result is rendered like the rest of the prospect: dots of the same size and spacing (same stipple) in stipple mode, a grey gradient of the same darkness in tone mode. The gain is the *Inner shading* parameter.

Every brush has a **Size ×** multiplier $k$ that scales all its lengths (widths, spacings, offsets, shadow weight).

### Handles (Applied Parts)

A handle is not a surface of revolution, so its shading uses a general rule: every visible surface is a height field, with normal $\vec{n} \propto (-\partial_x H,\ -\partial_y H,\ 1)$, lit and rendered exactly like the vessel (same light, same luminance range $[\ell_{lo}, \ell_{hi}]$ of the vessel, so tones match; same density, stippling or tone). Handles are read from the `Handle` and `Application` layers, where a hand-traced handle is a set of open strokes: the largest is the outline. A handle is applied to the vessel, so if the ends of that stroke are far apart, the parts of the stroke inside the wall $r(y)$ are cut at the wall and the figure is closed along the wall itself between the two ends (the wall arc is part of the region but is not an edge: no line, no edge shading). Then the endpoints of the other strokes are merged (tolerance $2\%$ of the size, 4–14 px) into a graph whose independent cycles (spanning forest plus one cycle per remaining edge) are the holes.

**Side view.** The silhouette is inflated into a strap. With $d$ the distance of a pixel to the drawn edges (exact Euclidean distance transform, smoothed with two box blurs), $R$ the largest inscribed radius (98th percentile of $d$) and $b = \beta R$ the rounded width ($\beta$ = *Edge rounding*, $\beta = 1$ a round rod),
$$H(d) = \kappa\, b \sqrt{1 - (1 - d/b)^2}\ \ (d < b), \qquad H = \kappa\, b\ \ (d \geq b), \qquad \vec{n} \propto \big(-H'(d)\,\nabla d,\ 1\big)$$
with $\kappa$ the *Edge steepness*. The flat face stays lit; the edges facing away from the light get the dots, as in the conventional drawing.

**One surface for the vessel and the parts.** The vessel and every applied part are signed distance fields (negative inside, in px of the drawing), and what is seen is their **smooth union**, not two solids side by side. The vessel is the surface of revolution, $d_v = (\rho - r(y))/\sqrt{1 + r'(y)^2}$ with $\rho = \sqrt{(x - c_x)^2 + z^2}$, closed at the first and last row of the profile. A part is $d_p$ (below); the union is the cubic smooth minimum
$$d = \min(d_v, d_p) - \frac{h^3 k}{6}, \qquad h = \frac{\max(k - |d_v - d_p|,\ 0)}{k}$$
with $k = 1.4\,\beta_w\,\bar{b}$ ($\beta_w$ = *Blend into the wall*, $\bar{b}$ the median thickness of the part; $\beta_w = 0$ is a sharp weld). Outside the outline traced on the drawing $k$ fades to 0 over $0.3\,k$ px, so the fillet does not spread beyond what the drawing gives. Where the part rises from the wall, the wall rises into it and the part spreads over the wall (a fillet of at most $k/6$ px), so the handle grows out of the vessel and the wall itself is modified around the attachment. The normal is the gradient of $d$ (central differences), so the tone flows from the wall into the part with no seam.

**A part is the intersection of what the drawing gives of it.** With $a$ the signed distance to the front polygon (extruded along the view, $z$) and $b$ the signed distance to the second figure (extruded across), the part is the rounded intersection
$$d_p = \Big\|\big(\max(a + R, 0),\ \max(b + R, 0)\big)\Big\| + \min\big(\max(a + R,\ b + R),\ 0\big) - R, \qquad R = \beta \min(h_w,\ b_{s}/2)$$
($\beta$ = *Edge rounding*, $h_w$ the half-width on that row, $b_s$ the local thickness), so both drawings rule: the silhouette seen from the front is the traced polygon, and the one seen from the side is the drawn side view. For a vertical handle the corners are rounded radially, $d_p = \max\big(b,\ a + \varrho(t)\big)$ with $\varrho(t) = R - \sqrt{R^2 - (R - t)^2}$ for $t < R$ (0 beyond) and $t$ the depth below the outer face along $\rho'$ (or the distance to the hole edges for the inner corners): with the distance to the whole side figure the strap narrowed towards the tip of an arm, where the figure is thin in the $y$ direction.

- *Vertical handle* ($y$ axis): the polygon is tapped by the user on the original drawing (its two ends and its sides, so it can be asymmetric). The second figure is the **side view** (Handle layer): the region between the outer contour and the holes, in the half-plane $(\rho', y)$ at the azimuth $\theta$ of the handle, $\rho' = (x - c_x)\sin\theta + z\cos\theta$, $\theta = \arcsin\big((c - c_x)/\rho(y)\big)$ at mid height, $|\sin\theta| \leq 0.97$. It is continued 64 px into the wall (more than the rounding of the corners) on the rows where its arms meet the wall, and cleared between the wall and a hole drawn a few px short of it. **The thickness of the strap and the size of the lume are those of the side view**; the distance is to the drawn edges only (exact Euclidean distance transform of the rasterized edges, smoothed with box blurs), the closing along the wall is not an edge. *Thickness* overrides the inner face.
- *Horizontal handle and lug* ($x$ axis): the second figure is the shell between two offsets of the wall, $\max(d_v - \Delta(t),\ \Delta(t) - b - d_v)$, where $\Delta$ is a **crest** profile (Catmull–Rom through control points $(t, \Delta)$, $t \in [0,1]$ along the length, ends at the wall by default, an ellipse of height $0.35\,L$ for a handle and $0.5\,L$ for a lug) and $b = \max(6,\ 1.2\,h)$ the thickness ($h$ the half-height of the polygon on that column). The crest is the dimension the drawing does not give: it is edited in the top view; under the shell is the passage of the handle.

**Front view.** Each pixel of the drawing (at its centre) is ray-marched along $z$ from in front of the part to the surface of the union (sphere tracing on $d$, step $0.85\,d$); pixels farther than $k$ from the outline are the untouched wall. The normal $\vec n$ is the gradient of $d$, with its $y$ component scaled by $1 - s\,(1 - g)$ ($s$ = share of the part at that point, $g$ = *Arch shading*, tempering the tilt of the arch so that its ends are not black); the luminance is the vessel's, $\ell = (\vec n \cdot \vec L - \ell_{lo})/(\ell_{hi} - \ell_{lo})$ with the same light and range. On the wall behind, the change made by the part, $\Delta\ell = (\vec n \cdot \vec L - \vec n_w \cdot \vec L)/(\ell_{hi} - \ell_{lo})$, is added to the wall's own luminance: the wall around the part is modified where the fillet rises. A pixel belongs to the part where it is inside the traced polygon and the surface is in front of the wall by more than 0.3 px, $z > \sqrt{r(y)^2 - (x - c_x)^2}$; the two side lines are drawn where that holds, and end where the part merges into the wall. The **cast shadow** is real: from every wall (or fillet) pixel a soft shadow ray is marched towards the light through the field of the part alone, $t \mapsto d_p(\mathbf{p} + t\hat{\ell})$, up to a reach of $1.6\,\bar{b} + 10$ px, with $\text{res} = \min(1,\ 6\,d_p/t)$ (0 if the ray touches the part), and the luminance is multiplied by $1 - s\,(1 - \text{res})$ ($s$ = *Shadow on the wall*, at most 0.95); a part does not shadow itself. The contour drawn is the traced outline, wherever the part stands out of the wall, with gaps of a few px bridged. The vertices of the polygon can be dragged, added and removed.

**3D views and the quad mesh.** The surface of the same field is extracted as a mesh of **quads** (naive surface nets in a box around the part, aligned to the part: $u$ across, $y$, $\rho'$ outwards; one vertex per crossed cell, one quad per crossed grid edge; the vertices are relaxed three times towards the mean of their neighbours and put back on $d = 0$ with Newton steps). Every vertex carries the normal $\nabla d$ and the share of the part, which tints the surface continuously from wall to part. The quad size (3–24 px) is a slider; the whole vessel, a piece of wall around the part or the part alone can be shown. The views are rasterized orthographically with a z-buffer and a light attached to the camera; the side view looks across the plane through the axis and the part, as the drawn side view does; from above a vertical handle shows the section of the union at a chosen row, a horizontal one the mesh with its crest points.

The drawing rules: the traced outline and the side view set the extents, and the 3D never rewrites them. A shape *placed* by the user (a polygon generated from a few parameters: pill, ellipse or band) is only a proposal; "Adopt" turns it into a traced polygon.

In the canvas all the elements of the drawing (the front views and the side views of the applied parts) are shown together, each with its own shading and decorations; a click on another element makes it the current one.

---

## References

- Maragos, P. (1986). Tutorial on advances in morphological image processing and analysis. *Optical Engineering*, 26(7), 623–632.
- Dodge, M. (2011). *Algorithms for Lines and Polygons*. In: Geographic Information Science. Springer.
- Mortenson, M. E. (1999). *Mathematics for Computer Graphics Applications*. Industrial Press.
- Arasteh, S., & Kalisz, A. (2021). Conversion between cubic Bézier curves and Catmull-Rom splines. *SN Computer Science*, 2(5), 1–9.
