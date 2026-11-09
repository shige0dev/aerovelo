/**
 * Google Photorealistic 3D Tiles Layer (Type B Building Display)
 * MapLibre CustomLayerInterface + Three.js GLTFLoader / DRACOLoader
 * Streams and renders Google Earth 3D Tiles around the current camera/rider location.
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;
// 日本付近の標準ジオイド高（Google 3D Tilesの楕円体高から標高への補正値）
const DEFAULT_GEOID_OFFSET_M = 36.7;

/**
 * ECEF (X, Y, Z) 座標から WGS84 (lon, lat, ellipsoidHeight) へ変換
 */
function ecefToLngLatAlt(x, y, z) {
    const lon = Math.atan2(y, x) * (180 / Math.PI);
    const p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - WGS84_E2));
    let alt = 0;
    for (let i = 0; i < 4; i++) {
        const sinLat = Math.sin(lat);
        const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
        alt = p / Math.cos(lat) - N;
        lat = Math.atan2(z, p * (1 - WGS84_E2 * (N / (N + alt))));
    }
    return { lon, lat: lat * (180 / Math.PI), ellipsoidAlt: alt };
}

/**
 * WGS84 (lon, lat, ellipsoidHeight) から ECEF (X, Y, Z) へ変換
 */
function lngLatAltToEcef(lon, lat, ellipsoidAlt = 0) {
    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    return [
        (N + ellipsoidAlt) * cosLat * cosLon,
        (N + ellipsoidAlt) * cosLat * sinLon,
        (N * (1 - WGS84_E2) + ellipsoidAlt) * sinLat
    ];
}

export class Google3DTilesLayer {
    constructor(id = 'google-3d-tiles') {
        this.id = id;
        this.type = 'custom';
        this.renderingMode = '3d';
        this.visible = false;
        this.apiKey = '';
        this.sessionToken = '';

        this.map = null;
        this.camera = null;
        this.scene = null;
        this.renderer = null;
        this.gltfLoader = null;

        this.rootNode = null;
        this.isLoadingRoot = false;
        this.loadedMeshes = new Map();   // uri -> THREE.Object3D
        this.loadingUris = new Set();    // uri currently fetching
        this.jsonCache = new Map();      // uri -> parsed tileset JSON
        this.lastUpdatePos = null;
        this.lastUpdateTime = 0;
        this.origin = null;
        this.originScale = 1e-7;
    }

    onAdd(map, gl) {
        this.map = map;
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();

        // 環境光＋平行光源（テクスチャ付き3Dタイル用）
        const ambient = new THREE.AmbientLight(0xffffff, 1.35);
        this.scene.add(ambient);

        this.renderer = new THREE.WebGLRenderer({
            canvas: map.getCanvas(),
            context: gl,
            antialias: true
        });
        this.renderer.autoClear = false;

        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
        this.gltfLoader = new GLTFLoader();
        this.gltfLoader.setDRACOLoader(dracoLoader);
    }

    setApiKey(key) {
        const trimmed = (key || '').trim();
        if (this.apiKey !== trimmed) {
            this.apiKey = trimmed;
            this.sessionToken = '';
            this.rootNode = null;
            this.clearTiles();
            if (this.visible && this.apiKey) {
                this.updateTilesForCurrentView(true);
            }
        }
    }

    setVisible(visible) {
        this.visible = !!visible;
        if (this.visible && this.apiKey) {
            this.updateTilesForCurrentView(true);
        }
        this.map?.triggerRepaint();
    }

    clearTiles() {
        for (const obj of this.loadedMeshes.values()) {
            this.scene?.remove(obj);
        }
        this.loadedMeshes.clear();
        this.loadingUris.clear();
        this.jsonCache.clear();
    }

    resolveTileUrl(uri) {
        const u = new URL(uri, 'https://tile.googleapis.com');
        if (this.sessionToken && !u.searchParams.has('session')) {
            u.searchParams.set('session', this.sessionToken);
        }
        if (this.apiKey && !u.searchParams.has('key')) {
            u.searchParams.set('key', this.apiKey);
        }
        return u.toString();
    }

    extractSessionFromNode(node) {
        if (!node) return;
        const uri = node.content?.uri || node.content?.url || '';
        if (uri.includes('session=')) {
            try {
                const u = new URL(uri, 'https://tile.googleapis.com');
                const s = u.searchParams.get('session');
                if (s) this.sessionToken = s;
            } catch {}
        }
        if (!this.sessionToken && Array.isArray(node.children)) {
            for (const c of node.children) {
                this.extractSessionFromNode(c);
                if (this.sessionToken) break;
            }
        }
    }

    async ensureRootLoaded() {
        if (this.rootNode || this.isLoadingRoot || !this.apiKey) return;
        this.isLoadingRoot = true;
        try {
            const res = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(this.apiKey)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            this.rootNode = json.root;
            this.extractSessionFromNode(this.rootNode);
            this.updateTilesForCurrentView(true);
        } catch (err) {
            console.warn('Google 3D Tiles root error:', err);
        } finally {
            this.isLoadingRoot = false;
        }
    }

    /**
     * 現在視点周辺の 3D タイルを探索してロード
     */
    async updateTilesForCurrentView(force = false) {
        if (!this.visible || !this.apiKey || !this.map) return;
        if (!this.rootNode) {
            this.ensureRootLoaded();
            return;
        }

        const now = performance.now();
        if (!force && now - this.lastUpdateTime < 600) return;

        const center = this.map.getCenter();
        const lon = center.lng;
        const lat = center.lat;
        const terrainEle = this.map.transform?.elevation || 0;

        if (!force && this.lastUpdatePos) {
            const dLon = (lon - this.lastUpdatePos.lon) * 91000;
            const dLat = (lat - this.lastUpdatePos.lat) * 111000;
            if (Math.hypot(dLon, dLat) < 60) return;
        }

        this.lastUpdateTime = now;
        this.lastUpdatePos = { lon, lat };

        if (!this.origin) {
            const c = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
            this.origin = { x: c.x, y: c.y, z: c.z };
            this.originScale = c.meterInMercatorCoordinateUnits();
        }

        const targetEcef = lngLatAltToEcef(lon, lat, terrainEle + DEFAULT_GEOID_OFFSET_M);
        const desiredGlbUris = new Set();

        const traverse = async (node, depth = 0) => {
            if (!node || depth > 24) return;

            // BoundingVolume (box) との距離判定
            let distToBox = 0;
            let boxRadius = 1000;
            const box = node.boundingVolume?.box;
            if (box && box.length >= 12) {
                const dx = targetEcef[0] - box[0];
                const dy = targetEcef[1] - box[1];
                const dz = targetEcef[2] - box[2];
                const centerDist = Math.hypot(dx, dy, dz);
                const r1 = Math.hypot(box[3], box[4], box[5]);
                const r2 = Math.hypot(box[6], box[7], box[8]);
                const r3 = Math.hypot(box[9], box[10], box[11]);
                boxRadius = Math.max(r1, r2, r3);
                distToBox = Math.max(0, centerDist - boxRadius);
            }

            // 視点から 900m 以内のタイルのみ対象
            if (distToBox > 900) return;

            const geomErr = node.geometricError ?? 9999;
            const uri = node.content?.uri || node.content?.url || '';

            if (uri.endsWith('.json')) {
                const fullUrl = this.resolveTileUrl(uri);
                let subJson = this.jsonCache.get(fullUrl);
                if (!subJson && !this.loadingUris.has(fullUrl)) {
                    this.loadingUris.add(fullUrl);
                    try {
                        const res = await fetch(fullUrl);
                        if (res.ok) {
                            subJson = await res.json();
                            this.jsonCache.set(fullUrl, subJson);
                            this.extractSessionFromNode(subJson.root);
                        }
                    } catch {} finally {
                        this.loadingUris.delete(fullUrl);
                    }
                }
                if (subJson?.root) {
                    await traverse(subJson.root, depth + 1);
                    return;
                }
            }

            // 詳細度（geometricError <= 18m）または葉ノードであれば GLB メッシュを採用
            const hasChildren = Array.isArray(node.children) && node.children.length > 0;
            const isEnoughDetail = geomErr <= (distToBox < 350 ? 12 : 22) || !hasChildren;

            if (isEnoughDetail && uri && (uri.endsWith('.glb') || uri.includes('.glb?'))) {
                const fullUrl = this.resolveTileUrl(uri);
                desiredGlbUris.add(fullUrl);
                if (!this.loadedMeshes.has(fullUrl) && !this.loadingUris.has(fullUrl) && desiredGlbUris.size <= 45) {
                    this.loadGlbTile(fullUrl, box);
                }
                return;
            }

            if (hasChildren) {
                for (const child of node.children) {
                    await traverse(child, depth + 1);
                }
            }
        };

        await traverse(this.rootNode, 0);

        // 範囲外になった古いタイルを破棄（最大60タイルまで保持）
        if (this.loadedMeshes.size > 60) {
            for (const [uri, obj] of this.loadedMeshes.entries()) {
                if (!desiredGlbUris.has(uri)) {
                    this.scene?.remove(obj);
                    this.loadedMeshes.delete(uri);
                }
            }
        }
    }

    loadGlbTile(url, box) {
        if (!this.gltfLoader || !this.scene) return;
        this.loadingUris.add(url);

        this.gltfLoader.load(
            url,
            (gltf) => {
                this.loadingUris.delete(url);
                const model = gltf.scene;
                this.placeEcefModelInMercator(model, box);
                this.scene.add(model);
                this.loadedMeshes.set(url, model);
                this.map?.triggerRepaint();
            },
            undefined,
            () => {
                this.loadingUris.delete(url);
            }
        );
    }

    /**
     * Google 3D Tiles (ECEF座標系・glTF Y-up) のメッシュをローカル Mercator 座標系に変換して配置
     */
    placeEcefModelInMercator(model, box) {
        // タイル内の全頂点の重心(ECEF)を算出して基準経緯度・高度を決定
        model.updateMatrixWorld(true);
        const bbox = new THREE.Box3().setFromObject(model);
        const centerThree = new THREE.Vector3();
        bbox.getCenter(centerThree);

        // glTF 2.0 は Y-up: Three.js 上の (x, y, z) は ECEF の (X, Z, -Y) すなわち ECEF = (x, -z, y)
        let ecefX = centerThree.x;
        let ecefY = -centerThree.z;
        let ecefZ = centerThree.y;

        if (Math.hypot(ecefX, ecefY, ecefZ) < 1000000 && box && box.length >= 3) {
            ecefX += box[0];
            ecefY += box[1];
            ecefZ += box[2];
        }

        const { lon, lat, ellipsoidAlt } = ecefToLngLatAlt(ecefX, ecefY, ecefZ);
        const orthoAlt = ellipsoidAlt - DEFAULT_GEOID_OFFSET_M;

        const merc = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], orthoAlt);
        const scale = merc.meterInMercatorCoordinateUnits();

        const rx = merc.x - this.origin.x;
        const ry = merc.y - this.origin.y;
        const rz = merc.z - this.origin.z;

        // 現地 ENU (East, North, Up) 単位ベクトルを ECEF で算出
        const latRad = (lat * Math.PI) / 180;
        const lonRad = (lon * Math.PI) / 180;
        const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
        const sinLon = Math.sin(lonRad), cosLon = Math.cos(lonRad);

        // East, North, Up in ECEF
        const eastEcef  = [-sinLon, cosLon, 0];
        const northEcef = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
        const upEcef    = [cosLat * cosLon, cosLat * sinLon, sinLat];

        // glTF (x_g, y_g, z_g) -> ECEF (x_g, -z_g, y_g)
        // MapLibre Mercator は X=East (+), Y=South (-North), Z=Up (+)
        const toThreeVec = (ecefVec) => new THREE.Vector3(ecefVec[0], ecefVec[2], -ecefVec[1]);
        const eVec = toThreeVec(eastEcef);
        const sVec = toThreeVec([-northEcef[0], -northEcef[1], -northEcef[2]]);
        const uVec = toThreeVec(upEcef);

        // 回転＋スケール変換行列（glTFローカル -> ENU(MapLibre Mercator)）
        const rotScale = new THREE.Matrix4().set(
            eVec.x * scale, eVec.y * scale, eVec.z * scale, 0,
            sVec.x * scale, sVec.y * scale, sVec.z * scale, 0,
            uVec.x * scale, uVec.y * scale, uVec.z * scale, 0,
            0, 0, 0, 1
        );

        const shiftToOrigin = new THREE.Matrix4().makeTranslation(-centerThree.x, -centerThree.y, -centerThree.z);
        const shiftToMerc = new THREE.Matrix4().makeTranslation(rx, ry, rz);

        const finalMat = new THREE.Matrix4()
            .multiply(shiftToMerc)
            .multiply(rotScale)
            .multiply(shiftToOrigin);

        model.matrixAutoUpdate = false;
        model.matrix.copy(finalMat);
        model.updateMatrixWorld(true);

        model.traverse((child) => {
            if (child.isMesh && child.material) {
                child.frustumCulled = false;
                child.material.transparent = true;
                child.material.opacity = 0.85;
            }
        });
    }

    render(gl, matrix) {
        if (!this.visible || !this.renderer || !this.scene || !this.camera || !this.origin) return;

        this.updateTilesForCurrentView(false);
        if (this.loadedMeshes.size === 0) return;

        const terrainElevation = this.map?.transform?.elevation || 0;
        const zCorrection = terrainElevation * (this.originScale || 1e-7);

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
