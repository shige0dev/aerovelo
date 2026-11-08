/**
 * 3D Course Ribbon Layer (MapLibre CustomLayerInterface + Three.js)
 * Renders the course as a true 3D road ribbon at ground + 2.0m altitude,
 * along with corresponding 3D definition point markers on the mesh surface.
 */

import { GeoCourseManager } from './course.js';

let sharedCircleTexture = null;
function getCirclePointTexture() {
    if (sharedCircleTexture) return sharedCircleTexture;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // 外枠（スレートグレー）
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = '#475569';
    ctx.fill();

    // 内側（白ベース：vertexColorsが乗る）
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    sharedCircleTexture = new THREE.CanvasTexture(canvas);
    return sharedCircleTexture;
}

export class CourseRibbonLayer {
    constructor(id = 'course-ribbon-3d', widthMeters = 3.5) {
        this.id = id;
        this.type = 'custom';
        this.renderingMode = '3d';
        this.widthMeters = widthMeters;
        this.altitudeOffset = 2.0; // コース定義点よりも +2.0m 上空

        this.camera = null;
        this.scene = null;
        this.renderer = null;
        this.map = null;
        this.mesh = null;
        this.pointsMesh = null; // メッシュ側の定義点オブジェクト
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

        // 3. メッシュ側にも定義点に対応した点（+2.0m 空中ドットマーカー）を生成
        if (course.rawWaypoints && course.rawWaypoints.length > 0) {
            const numWp = course.rawWaypoints.length;
            const ptVerts = new Float32Array(numWp * 3);
            const ptColors = new Float32Array(numWp * 3);
            const startAlt = pts[0]?.alt || course.rawWaypoints[0]?.alt || 0;

            for (let i = 0; i < numWp; i++) {
                const dist = course.cumDistances[i] ?? 0;
                const samplePt = course.sampleAtDist(dist);
                const wpAlt = (typeof samplePt.alt === 'number' && !isNaN(samplePt.alt)) ? samplePt.alt : startAlt;

                // メッシュ上面（+2.0m）の直上（+0.06m）に配置してリボンとZファイトしないようにする
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

            const ptGeom = new THREE.BufferGeometry();
            ptGeom.setAttribute('position', new THREE.BufferAttribute(ptVerts, 3));
            ptGeom.setAttribute('color', new THREE.BufferAttribute(ptColors, 3));

            const ptMat = new THREE.PointsMaterial({
                size: 13,
                map: getCirclePointTexture(),
                transparent: true,
                alphaTest: 0.1,
                vertexColors: true,
                sizeAttenuation: false,
                depthTest: true
            });

            this.pointsMesh = new THREE.Points(ptGeom, ptMat);
            this.scene.add(this.pointsMesh);
        }

        this.map?.triggerRepaint();
    }

    render(gl, matrix) {
        if ((!this.mesh && !this.pointsMesh) || !this.renderer || !this.scene || !this.camera) return;

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
