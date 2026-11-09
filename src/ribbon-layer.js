/**
 * 3D Course Ribbon Layer (MapLibre CustomLayerInterface + Three.js)
 * Renders the course as a true 3D road ribbon at ground + 2.0m altitude,
 * along with corresponding 3D definition point markers on the mesh surface.
 */

import { GeoCourseManager } from './course.js';

const riderTextures = {};
function getRiderTexture(colorHex = '#06b6d4') {
    if (riderTextures[colorHex]) return riderTextures[colorHex];
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const c = size / 2;

    // 外側グロー
    const grad = ctx.createRadialGradient(c, c, 12, c, c, 58);
    grad.addColorStop(0, colorHex);
    grad.addColorStop(0.65, colorHex);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c, c, 58, 0, Math.PI * 2);
    ctx.fill();

    // 白コア
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(c, c, 18, 0, Math.PI * 2);
    ctx.fill();

    // 枠リング
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(c, c, 38, 0, Math.PI * 2);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    riderTextures[colorHex] = tex;
    return tex;
}

export class CourseRibbonLayer {
    constructor(id = 'course-ribbon-3d', widthMeters = 3.5) {
        this.id = id;
        this.type = 'custom';
        this.renderingMode = '3d';
        this.widthMeters = widthMeters;
        this.altitudeOffset = 3.0; // 計測点高度よりも +3.0m 上空

        this.camera = null;
        this.scene = null;
        this.renderer = null;
        this.map = null;
        this.mesh = null;
        this.tunnelXrayMesh = null; // トンネル区間の地中 X-Ray 透視メッシュ
        this.riderMesh = null;      // ルートメッシュ上を走る 3D 走行点
        this.origin = { x: 0, y: 0, z: 0 };
    }

    onAdd(map, gl) {
        this.map = map;
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();

        this.renderer = new THREE.WebGLRenderer({
            canvas: map.getCanvas(),
            context: gl,
            antialias: true
        });
        this.renderer.autoClear = false;

        if (this.pendingCourse) {
            this.updateCourse(this.pendingCourse);
            this.pendingCourse = null;
        }
    }

    /**
     * コースデータから 3D リボンメッシュを生成
     */
    updateCourse(course) {
        if (!this.scene) {
            this.pendingCourse = course;
            return;
        }

        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh = null;
        }

        if (this.tunnelXrayMesh) {
            this.scene.remove(this.tunnelXrayMesh);
            this.tunnelXrayMesh.geometry.dispose();
            this.tunnelXrayMesh.material.dispose();
            this.tunnelXrayMesh = null;
        }

        if (this.riderMesh) {
            this.scene.remove(this.riderMesh);
            this.riderMesh.geometry.dispose();
            this.riderMesh.material.dispose();
            this.riderMesh = null;
        }

        if (!course || !course.interpolatedPoints || course.interpolatedPoints.length < 2) return;

        const pts = course.interpolatedPoints;
        const n = pts.length;
        const halfW = this.widthMeters / 2;

        // 1. 各点のメルカトル3D座標（地面 + 1.0m）を算出
        const mercs = new Array(n);
        const scales = new Array(n);
        for (let i = 0; i < n; i++) {
            const p = pts[i];
            const coord = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat], (p.alt || 0) + this.altitudeOffset);
            mercs[i] = coord;
            scales[i] = coord.meterInMercatorCoordinateUnits();
        }

        // 原点は最初の点
        this.origin = { x: mercs[0].x, y: mercs[0].y, z: mercs[0].z };
        this.originScale = scales[0];

        // 2. 各点での左右頂点（L, R）を生成
        const vertices = new Float32Array(n * 2 * 3);
        const colors = new Float32Array(n * 2 * 3);
        const indices = [];
        const tunnelIndices = [];

        // 勾配（-20% ~ +20%, 0.2%刻み）に応じた色相カラー
        const getPointColor = (dist) => {
            const slope = course.getSlopeAtDist(dist);
            return GeoCourseManager.slopeToRgb(slope);
        };

        for (let i = 0; i < n; i++) {
            const cur = mercs[i];
            const scale = scales[i];
            const wM = halfW * scale;

            // 進行方向の接線ベクトル
            let dx, dy;
            if (i === 0) {
                dx = mercs[1].x - cur.x;
                dy = mercs[1].y - cur.y;
            } else if (i === n - 1) {
                dx = cur.x - mercs[n - 2].x;
                dy = cur.y - mercs[n - 2].y;
            } else {
                dx = mercs[i + 1].x - mercs[i - 1].x;
                dy = mercs[i + 1].y - mercs[i - 1].y;
            }

            const len = Math.hypot(dx, dy) || 1e-6;
            // 法線ベクトル（90度回転、単位ベクトル）
            const nx = (-dy / len) * wM;
            const ny = (dx / len) * wM;

            // ローカル原点からの相対座標
            const rx = cur.x - this.origin.x;
            const ry = cur.y - this.origin.y;
            const rz = cur.z - this.origin.z;

            // 左頂点 Li (i*2)
            const idxL = i * 2 * 3;
            vertices[idxL] = rx + nx;
            vertices[idxL + 1] = ry + ny;
            vertices[idxL + 2] = rz;

            // 右頂点 Ri (i*2 + 1)
            const idxR = (i * 2 + 1) * 3;
            vertices[idxR] = rx - nx;
            vertices[idxR + 1] = ry - ny;
            vertices[idxR + 2] = rz;

            // 頂点カラー
            const [cr, cg, cb] = getPointColor(pts[i].dist);
            colors[idxL] = cr;
            colors[idxL + 1] = cg;
            colors[idxL + 2] = cb;
            colors[idxR] = cr;
            colors[idxR + 1] = cg;
            colors[idxR + 2] = cb;

            // 三角形インデックス (Quad -> 2 Triangles)
            if (i < n - 1) {
                const iL0 = i * 2;
                const iR0 = i * 2 + 1;
                const iL1 = (i + 1) * 2;
                const iR1 = (i + 1) * 2 + 1;
                indices.push(iL0, iR0, iL1);
                indices.push(iR0, iR1, iL1);

                // トンネル区間のインデックス（手前の山肌を透視する X-Ray 用）
                const isTunnelSeg = course.getStructureAtDist(pts[i].dist)?.type === 'tunnel' ||
                                    course.getStructureAtDist(pts[i + 1].dist)?.type === 'tunnel';
                if (isTunnelSeg) {
                    tunnelIndices.push(iL0, iR0, iL1);
                    tunnelIndices.push(iR0, iR1, iL1);
                }
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: false, // 半透明メッシュが背後や走行点を遮蔽しないように深度壁の書き込みを無効化
            transparent: true,
            opacity: 0.5 // 半透明（透明度50%）
        });

        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.frustumCulled = false; // カメラ移動による描画スキップを防止
        this.mesh.renderOrder = 1;
        this.scene.add(this.mesh);

        // トンネル区間の地中 X-Ray 透視メッシュ（手前の山肌をレントゲン透視）
        if (tunnelIndices.length > 0) {
            const tunnelGeom = new THREE.BufferGeometry();
            tunnelGeom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            tunnelGeom.setIndex(tunnelIndices);
            const tunnelMat = new THREE.MeshBasicMaterial({
                color: 0xc084fc, // ネオンパープル
                side: THREE.DoubleSide,
                depthTest: false, // 山肌メッシュを手前に透視！
                depthWrite: false,
                transparent: true,
                opacity: 0.5 // 半透明（透明度50%）
            });
            this.tunnelXrayMesh = new THREE.Mesh(tunnelGeom, tunnelMat);
            this.tunnelXrayMesh.frustumCulled = false;
            this.tunnelXrayMesh.renderOrder = 2;
            this.scene.add(this.tunnelXrayMesh);
        }

        if (this.pendingRider) {
            this.updateRider(this.pendingRider.state);
            this.pendingRider = null;
        }

        this.map?.triggerRepaint();
    }

    /**
     * ルートメッシュ上を走行する 3D 走行点（ライダー）を更新
     */
    updateRider(state) {
        if (!this.scene || !this.origin) {
            this.pendingRider = { state };
            return;
        }
        if (!state || typeof state.lon !== 'number' || typeof state.lat !== 'number') return;

        // 走行メッシュ（+3.0m）よりさらに +1.0m 上空に配置してリボン埋まりを完全防止
        const riderAlt = (state.alt || 0) + this.altitudeOffset + 1.0;
        const riderCoord = maplibregl.MercatorCoordinate.fromLngLat([state.lon, state.lat], riderAlt);
        const rx = riderCoord.x - this.origin.x;
        const ry = riderCoord.y - this.origin.y;
        const rz = riderCoord.z - this.origin.z;

        const isInTunnel = state.structure?.type === 'tunnel';

        // ルートメッシュ上の走行点（3D ライダー）
        if (!this.riderMesh) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([rx, ry, rz]), 3));
            const mat = new THREE.PointsMaterial({
                size: 28,
                map: getRiderTexture(isInTunnel ? '#c084fc' : '#06b6d4'),
                transparent: true,
                sizeAttenuation: false,
                depthTest: false, // 常時最前面表示（メッシュや地形による隠れを100%防止）
                depthWrite: false
            });
            this.riderMesh = new THREE.Points(geom, mat);
            this.riderMesh.frustumCulled = false; // カメラ移動による視錐台カリング（途中で消える不具合）を防止
            this.riderMesh.renderOrder = 999;    // 最前面に確実にレンダリング
            this.scene.add(this.riderMesh);
        } else {
            const pos = this.riderMesh.geometry.attributes.position;
            pos.setXYZ(0, rx, ry, rz);
            pos.needsUpdate = true;
            this.riderMesh.geometry.computeBoundingSphere?.();
            this.riderMesh.frustumCulled = false;
            this.riderMesh.material.map = getRiderTexture(isInTunnel ? '#c084fc' : '#06b6d4');
            this.riderMesh.material.depthTest = false; // 常時最前面表示
            this.riderMesh.renderOrder = 999;
            this.riderMesh.visible = true;
        }

        this.map?.triggerRepaint();
    }

    render(gl, matrix) {
        if ((!this.mesh && !this.tunnelXrayMesh && !this.riderMesh) || !this.renderer || !this.scene || !this.camera) return;

        // 3D 地形モード時のカメラ基準標高（画面中央の地形標高）のオフセットを補正して上空浮遊を防止
        const terrainElevation = this.map?.transform?.elevation || 0;
        const scale = this.originScale || 1e-7;
        const zCorrection = terrainElevation * scale;

        const m = new THREE.Matrix4().fromArray(matrix);
        const l = new THREE.Matrix4().makeTranslation(
            this.origin.x,
            this.origin.y,
            this.origin.z - zCorrection
        );
        this.camera.projectionMatrix = m.multiply(l);

        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
    }
}
