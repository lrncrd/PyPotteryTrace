// Prospect Canvas - cameras and a small software rasterizer
//
// The mesh of the 3D views (the quads of prospect-field.js, two triangles each) is drawn by an
// orthographic rasterizer with a z-buffer, for the side, top and orbit views. No dependencies.
//
// World frame = the drawing: x right, y down (image rows), z towards the viewer of the front view. The
// axis of the vessel is x = axisX, z = 0.

(function () {
    const PI = Math.PI;

    // ------------------------------------------------------------------
    // Cameras (orthographic)
    // ------------------------------------------------------------------

    // The front view of the drawing: image x, y and z towards the viewer; (x0, y0) the origin of the raster
    function frontCamera(x0, y0) {
        return { project: (x, y, z) => [x - x0, y - y0, z], view: [0, 0, 1] };
    }

    // Orbit around (cx, cy, 0): yaw about the vertical, then pitch (negative = seen from above)
    function orbitCamera(o) {
        const cy = Math.cos(o.yaw), sy = Math.sin(o.yaw), cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
        return {
            project: (x, y, z) => {
                const dx = x - o.cx, dy = y - o.cy, dz = z - (o.cz || 0);
                const x1 = cy * dx + sy * dz, z1 = -sy * dx + cy * dz;
                const y2 = cp * dy - sp * z1, z2 = sp * dy + cp * z1;
                return [o.W / 2 + o.scale * x1 + (o.panX || 0), o.H / 2 + o.scale * y2 + (o.panY || 0), z2];
            },
            view: [-sy * cp, sp, cy * cp],
            // world directions of the screen axes
            right: [cy, 0, sy],
            down: [sp * sy, cp, -sp * cy]
        };
    }

    // ------------------------------------------------------------------
    // Rasterizer
    // ------------------------------------------------------------------

    // Draws the meshes with a z-buffer at the integer sample points of a W x H raster. opts.baseZ(i, j)
    // (optional) gives the depth of what lies behind a sample (the wall of the vessel): only what is
    // in front of it by more than 0.3 is kept, and `elev` holds that height.
    // Returns { W, H, z, id (index in `meshes`, -1 = none), nx, ny, nz (unit, world), elev, attr (mesh.attr
    // interpolated), vert (the vertex nearest to the sample) }.
    function rasterize(meshes, cam, W, H, opts = {}) {
        const n = W * H;
        const z = new Float32Array(n).fill(-1e30);
        const id = new Int16Array(n).fill(-1);
        const nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n);
        const elev = opts.baseZ ? new Float32Array(n) : null;
        const attr = new Float32Array(n), vert = new Int32Array(n).fill(-1);
        meshes.forEach((mesh, mi) => {
            const V = mesh.pos.length / 3;
            const sx = new Float32Array(V), sy = new Float32Array(V), sz = new Float32Array(V);
            for (let v = 0; v < V; v++) {
                const p = cam.project(mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]);
                sx[v] = p[0]; sy[v] = p[1]; sz[v] = p[2];
            }
            const idx = mesh.idx, N = mesh.nrm;
            for (let t = 0; t < idx.length; t += 3) {
                const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
                const x0 = sx[i0], y0 = sy[i0], x1 = sx[i1], y1 = sy[i1], x2 = sx[i2], y2 = sy[i2];
                const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
                if (Math.abs(area) < 1e-9) continue;
                const xmin = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 1e-6)), xmax = Math.min(W - 1, Math.floor(Math.max(x0, x1, x2) + 1e-6));
                const ymin = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 1e-6)), ymax = Math.min(H - 1, Math.floor(Math.max(y0, y1, y2) + 1e-6));
                const inv = 1 / area;
                for (let j = ymin; j <= ymax; j++) {
                    for (let i = xmin; i <= xmax; i++) {
                        const w0 = ((x1 - i) * (y2 - j) - (x2 - i) * (y1 - j)) * inv;
                        const w1 = ((x2 - i) * (y0 - j) - (x0 - i) * (y2 - j)) * inv;
                        const w2 = 1 - w0 - w1;
                        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                        const zz = w0 * sz[i0] + w1 * sz[i1] + w2 * sz[i2];
                        const k = j * W + i;
                        if (zz <= z[k]) continue;
                        if (opts.baseZ) {
                            const e = zz - opts.baseZ(i, j);
                            if (e <= 0.3) continue;
                            elev[k] = e;
                        }
                        z[k] = zz;
                        id[k] = mi;
                        nx[k] = w0 * N[3 * i0] + w1 * N[3 * i1] + w2 * N[3 * i2];
                        ny[k] = w0 * N[3 * i0 + 1] + w1 * N[3 * i1 + 1] + w2 * N[3 * i2 + 1];
                        nz[k] = w0 * N[3 * i0 + 2] + w1 * N[3 * i1 + 2] + w2 * N[3 * i2 + 2];
                        if (mesh.attr) attr[k] = w0 * mesh.attr[i0] + w1 * mesh.attr[i1] + w2 * mesh.attr[i2];
                        vert[k] = w0 >= w1 && w0 >= w2 ? i0 : (w1 >= w2 ? i1 : i2);
                    }
                }
            }
        });
        // unit normals; a double-sided surface seen from behind shows its other side
        const v = cam.view;
        for (let k = 0; k < n; k++) {
            if (id[k] < 0) continue;
            const l = Math.hypot(nx[k], ny[k], nz[k]) || 1;
            let a = nx[k] / l, b = ny[k] / l, c = nz[k] / l;
            if (meshes[id[k]].doubleSided && a * v[0] + b * v[1] + c * v[2] < 0) { a = -a; b = -b; c = -c; }
            nx[k] = a; ny[k] = b; nz[k] = c;
        }
        return { W, H, z, id, nx, ny, nz, elev, attr, vert };
    }

    window.ProspectMesh = { frontCamera, orbitCamera, rasterize };
})();
