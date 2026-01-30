# SVG Comparison Report
Generated: 2025-12-11 11:09:09

## Summary Statistics

| Metric | Mean | Std Dev | Min | Max |
|--------|------|---------|-----|-----|
| Hausdorff Distance | 0.0186 | 0.0060 | 0.0086 | 0.0266 |
| Fréchet Distance | 0.6346 | 0.5081 | 0.0578 | 1.3874 |
| Mean Point Distance | 0.4183 | 0.2791 | 0.0549 | 0.7462 |
| Endpoint Error (Start) | 0.6317 | 0.5068 | 0.0567 | 1.3874 |
| Endpoint Error (End) | 0.6313 | 0.5065 | 0.0578 | 1.3874 |

## Individual Results

| File | Hausdorff | Fréchet | Mean Dist | Start Err | End Err |
|------|-----------|---------|-----------|-----------|---------|
| 0352.svg | 0.0266 | 0.1521 | 0.1665 | 0.1521 | 0.1521 |
| 3205.svg | 0.0197 | 0.9054 | 0.6853 | 0.8833 | 0.8833 |
| 3213.svg | 0.0211 | 0.9956 | 0.6249 | 0.9956 | 0.9921 |
| ceramic_001.svg | 0.0123 | 1.3874 | 0.7462 | 1.3874 | 1.3874 |
| ceramic_046.svg | 0.0086 | 0.1575 | 0.1512 | 0.1575 | 0.1562 |
| ceramic_066.svg | 0.0254 | 0.2156 | 0.2023 | 0.2156 | 0.2156 |
| ceramic_071.svg | 0.0211 | 1.2057 | 0.7152 | 1.2057 | 1.2057 |
| Montale_109.svg | 0.0139 | 0.0578 | 0.0549 | 0.0567 | 0.0578 |

## Metric Descriptions

- **Hausdorff Distance**: Maximum distance from any point on one curve to the nearest point on the other. Lower is better.
- **Fréchet Distance**: 'Dog-walking' distance that respects point ordering. Lower is better.
- **Mean Point Distance**: Average distance between corresponding points. Lower is better.
- **Endpoint Error**: How well start/end points are preserved. Lower is better.

*All distances normalized to [0,1] range.*