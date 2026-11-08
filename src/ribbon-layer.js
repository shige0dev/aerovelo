/**
 * 3D Course Ribbon Layer (MapLibre CustomLayerInterface + Three.js)
 * Renders the course as a true 3D road ribbon at ground + 2.0m altitude,
 * along with corresponding 3D definition point markers on the mesh surface.
 */

import { GeoCourseManager } from './course.js';

let sharedCircleMaskTexture = null;
function getCircleMaskTexture() {
    if (sharedCircleMaskTexture) return sharedCircleMaskTexture;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // 綺麗なアンチエイリアス白円マスク（中心から半径 28px、エッジ 2px 滑らかにフェード）
    const r = 28;
    const grad = ctx.createRadialGradient(size / 2, size / 2, r - 2, size / 2, size / 2, r);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    ctx.fill();

    sharedCircleMaskTexture = new THREE.CanvasTexture(canvas);
    return sharedCircleMaskTexture;
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
        this.pointsMesh = null;     // メッシュ側定義点（極小・面だけ）
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
     * コースデータから 3D リボンメッシュ（幅 3.5m・地面 + 1.0m）を生成
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

        if (this.pointsMesh) {
            this.scene.remove(this.pointsMesh);
            this.pointsMesh.geometry.dispose();
            this.pointsMesh.material.dispose();
            this.pointsMesh = null;
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

        // 構造物（橋・トンネル）色判定ヘルパー
        const getPointColor = (dist) => {
            const struct = course.getStructureAtDist(dist);
            if (struct?.type === 'bridge') return [0.96, 0.62, 0.07]; // アンバー
            if (struct?.type === 'tunnel') return [0.66, 0.33, 0.97]; // パープル
            return [1.0, 1.0, 1.0]; // 基本は白色
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
            depthTest: true
        });

        this.mesh = new THREE.Mesh(geometry, material);
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
                transparent: true,
                opacity: 0.85
            });
            this.tunnelXrayMesh = new THREE.Mesh(tunnelGeom, tunnelMat);
            this.scene.add(this.tunnelXrayMesh);
        }

        // 3. メッシュ側にも定義点に対応した点（極小サイズ・面だけで表示）
        if (course.rawWaypoints && course.rawWaypoints.length > 0) {
            const numWp = course.rawWaypoints.length;
            const ptVerts = new Float32Array(numWp * 3);
            const ptColors = new Float32Array(numWp * 3);
            const startAlt = course.interpolatedPoints[0]?.alt || course.rawWaypoints[0]?.alt || 0;

            for (let i = 0; i < numWp; i++) {
                const dist = course.cumDistances[i] ?? 0;
                const samplePt = course.sampleAtDist(dist);
                const wpAlt = (typeof samplePt.alt === 'number' && !isNaN(samplePt.alt)) ? samplePt.alt : startAlt;

                // メッシュ上面（+3.0m）の直上（+0.06m）に配置してリボンとZファイトしないようにする
                const wpCoord = maplibregl.MercatorCoordinate.fromLngLat(
                    [samplePt.lon, samplePt.lat],
                    wpAlt + this.altitudeOffset + 0.06
                );

                const pIdx = i * 3;
                ptVerts[pIdx] = wpCoord.x - this.origin.x;
                ptVerts[pIdx + 1] = wpCoord.y - this.origin.y;
                ptVerts[pIdx + 2] = wpCoord.z - this.origin.z;

                // 20cm ごとに 1/256 ずつ明るくなるモノクロ明度カラー
                const [pr, pg, pb] = GeoCourseManager.altToStepRgb(wpAlt, startAlt);
                ptColors[pIdx] = pr;
                ptColors[pIdx + 1] = pg;
                ptColors[pIdx + 2] = pb;
            }

            const maskTex = getCircleMaskTexture();

            // 極小サイズの純粋な面ドット（枠線なし、サイズ 5px）
            const innerGeom = new THREE.BufferGeometry();
            innerGeom.setAttribute('position', new THREE.BufferAttribute(ptVerts, 3));
            innerGeom.setAttribute('color', new THREE.BufferAttribute(ptColors, 3));
            const innerMat = new THREE.PointsMaterial({
                size: 5, // 極小サイズ（面だけで上品に表示）
                map: maskTex,
                vertexColors: true,
                transparent: true,
                alphaTest: 0.05,
                sizeAttenuation: false,
                depthTest: true
            });
            this.pointsMesh = new THREE.Points(innerGeom, innerMat);
            this.scene.add(this.pointsMesh);
        }

        this.map?.triggerRepaint();
    }

    render(gl, matrix) {
        if ((!this.mesh && !this.pointsMesh && !this.tunnelXrayMesh) || !this.renderer || !this.scene || !this.camera) return;

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
