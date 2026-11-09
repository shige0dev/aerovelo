/**
 * Google Photorealistic 3D Tiles Layer (Type B Building Display)
 * MapLibre CustomLayerInterface + Three.js GLTFLoader / DRACOLoader
 * Streams and renders Google Earth 3D Tiles around the current camera/rider location.
 */

import * as THREE from 'three';
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

/**
 * 点 P (targetEcef) から 3D Tiles の Oriented Bounding Box (box[12]) までの正確な最短距離(m)を算出
 * 点が OBB の内部にある場合は 0 を返す
 */
function distanceToObb(targetEcef, box) {
    if (!box || box.length < 12) return 0;
    const dx = targetEcef[0] - box[0];
    const dy = targetEcef[1] - box[1];
    const dz = targetEcef[2] - box[2];

    const axisExcess = (ax, ay, az) => {
        const len = Math.hypot(ax, ay, az);
        if (len < 1e-6) return 0;
        const proj = Math.abs(dx * ax + dy * ay + dz * az) / len;
        return Math.max(0, proj - len);
    };

    const ex1 = axisExcess(box[3], box[4], box[5]);
    const ex2 = axisExcess(box[6], box[7], box[8]);
    const ex3 = axisExcess(box[9], box[10], box[11]);
    return Math.hypot(ex1, ex2, ex3);
}

/**
 * region [west, south, east, north, minH, maxH] (rad) までの概算距離(m)を算出
 */
function distanceToRegion(lonDeg, latDeg, region) {
    if (!region || region.length < 4) return 0;
    const lon = (lonDeg * Math.PI) / 180;
    const lat = (latDeg * Math.PI) / 180;
    const clampedLon = Math.max(region[0], Math.min(region[2], lon));
    const clampedLat = Math.max(region[1], Math.min(region[3], lat));
    const dLonM = (lon - clampedLon) * Math.cos(lat) * WGS84_A;
    const dLatM = (lat - clampedLat) * WGS84_A;
    return Math.hypot(dLonM, dLatM);
}

export class Google3DTilesLayer {
    constructor(id = 'google-3d-tiles', onStatusChange = null) {
        this.id = id;
        this.type = 'custom';
        this.renderingMode = '3d';
        this.visible = false;
        this.apiKey = '';
        this.sessionToken = '';
        this.onStatusChange = onStatusChange;

        this.map = null;
        this.camera = null;
        this.scene = null;
        this.renderer = null;
        this.gltfLoader = null;

        this.rootNode = null;
        this.isLoadingRoot = false;
        this.isTraversing = false;
        this.loadedMeshes = new Map();   // uri -> THREE.Object3D
        this.loadingUris = new Set();    // uri currently fetching
        this.jsonCache = new Map();      // uri -> parsed tileset JSON
        this.lastUpdatePos = null;
        this.lastUpdateTime = 0;
        this.origin = null;
        this.originScale = 1e-7;
    }

    setStatus(text) {
        this.onStatusChange?.(text);
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

        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
        this.gltfLoader = new GLTFLoader();
        this.gltfLoader.setDRACOLoader(dracoLoader);

        if (this.visible && this.apiKey) {
            this.updateTilesForCurrentView(true);
        }
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
        } else if (!this.visible) {
            this.setStatus('G-Earth');
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

    resolveTileUrl(uri, baseUrl = 'https://tile.googleapis.com') {
        const u = new URL(uri, baseUrl);
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
        this.setStatus('接続中...');
        try {
            const res = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(this.apiKey)}`);
            if (!res.ok) {
                let errMsg = `HTTP ${res.status}`;
                try {
                    const errJson = await res.json();
                    if (errJson?.error?.message) errMsg = errJson.error.message;
                } catch {}
                this.setStatus('ERR');
                alert(`Google 3D Tiles 取得エラー:\n${errMsg}\n\n※Google Cloud Console で「Map Tiles API」が有効化されているかご確認ください。`);
                return;
            }
            const json = await res.json();
            this.rootNode = json.root;
            this.extractSessionFromNode(this.rootNode);
            this.updateTilesForCurrentView(true);
        } catch (err) {
            console.warn('Google 3D Tiles root error:', err);
            this.setStatus('ERR');
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
        if (this.isTraversing) return;

        const now = performance.now();
        if (!force && now - this.lastUpdateTime < 700) return;

        const center = this.map.getCenter();
        const lon = center.lng;
        const lat = center.lat;
        const terrainEle = this.map.transform?.elevation || 0;

        if (!force && this.lastUpdatePos) {
            const dLon = (lon - this.lastUpdatePos.lon) * 91000;
            const dLat = (lat - this.lastUpdatePos.lat) * 111000;
            if (Math.hypot(dLon, dLat) < 40) return;
        }

        this.lastUpdateTime = now;
        this.lastUpdatePos = { lon, lat };

        if (!this.origin) {
            const c = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
            this.origin = { x: c.x, y: c.y, z: c.z };
            this.originScale = c.meterInMercatorCoordinateUnits();
        }

        this.isTraversing = true;
        const targetEcef = lngLatAltToEcef(lon, lat, terrainEle + DEFAULT_GEOID_OFFSET_M);
        const desiredGlbUris = new Set();
        let fetchedNewJson = false;

        try {
            const traverse = async (node, baseUrl = 'https://tile.googleapis.com/v1/3dtiles/root.json', depth = 0) => {
                if (!node || depth > 28) return;

                // OBB または Region との最短距離判定（ボックス内部なら 0m）
                let distToTile = 0;
                const box = node.boundingVolume?.box;
                const region = node.boundingVolume?.region;
                if (box && box.length >= 12) {
                    distToTile = distanceToObb(targetEcef, box);
                } else if (region && region.length >= 4) {
                    distToTile = distanceToRegion(lon, lat, region);
                }

                // 現在地から 700m 以内のタイルのみ展開
                if (distToTile > 700) return;

                const geomErr = node.geometricError ?? 9999;
                const uri = node.content?.uri || node.content?.url || '';
                const cleanPath = uri.split('?')[0].toLowerCase();

                // 子 JSON タイルセットの展開
                if (cleanPath.endsWith('.json')) {
                    const fullUrl = this.resolveTileUrl(uri, baseUrl);
                    let subJson = this.jsonCache.get(fullUrl);
                    if (!subJson && !this.loadingUris.has(fullUrl)) {
                        this.loadingUris.add(fullUrl);
                        try {
                            const res = await fetch(fullUrl);
                            if (res.ok) {
                                subJson = await res.json();
                                this.jsonCache.set(fullUrl, subJson);
                                this.extractSessionFromNode(subJson.root);
                                fetchedNewJson = true;
                            }
                        } catch {} finally {
                            this.loadingUris.delete(fullUrl);
                        }
                    }
                    if (subJson?.root) {
                        await traverse(subJson.root, fullUrl, depth + 1);
                        return;
                    }
                }

                const hasChildren = Array.isArray(node.children) && node.children.length > 0;
                const targetError = distToTile < 250 ? 8 : distToTile < 500 ? 16 : 28;
                const isEnoughDetail = geomErr <= targetError || !hasChildren;

                if (isEnoughDetail && cleanPath.endsWith('.glb')) {
                    const fullUrl = this.resolveTileUrl(uri, baseUrl);
                    desiredGlbUris.add(fullUrl);
                    if (!this.loadedMeshes.has(fullUrl) && !this.loadingUris.has(fullUrl) && desiredGlbUris.size <= 50) {
                        this.loadGlbTile(fullUrl, box, node.transform);
                    }
                    return;
                }

                if (hasChildren) {
                    for (const child of node.children) {
                        await traverse(child, baseUrl, depth + 1);
                    }
                }
            };

            await traverse(this.rootNode, 'https://tile.googleapis.com/v1/3dtiles/root.json', 0);

            // 範囲外の古いタイルを整理
            if (this.loadedMeshes.size > 65) {
                for (const [uri, obj] of this.loadedMeshes.entries()) {
                    if (!desiredGlbUris.has(uri)) {
                        this.scene?.remove(obj);
                        this.loadedMeshes.delete(uri);
                    }
                }
            }

            if (this.loadedMeshes.size > 0) {
                this.setStatus(`${this.loadedMeshes.size} tiles`);
            } else if (this.loadingUris.size > 0 || fetchedNewJson) {
                this.setStatus('読込中...');
            }
        } finally {
            this.isTraversing = false;
            if (fetchedNewJson && this.loadedMeshes.size === 0) {
                setTimeout(() => this.updateTilesForCurrentView(true), 100);
            }
        }
    }

    loadGlbTile(url, box, tileTransform) {
        if (!this.gltfLoader || !this.scene) return;
        this.loadingUris.add(url);
        this.setStatus(this.loadedMeshes.size > 0 ? `${this.loadedMeshes.size} tiles` : '読込中...');

        this.gltfLoader.load(
            url,
            (gltf) => {
                this.loadingUris.delete(url);
                try {
                    const rtcCenter = gltf.parser?.json?.extensions?.CESIUM_RTC?.center ||
                                      gltf.userData?.gltfExtensions?.CESIUM_RTC?.center || null;
                    const group = this.buildMercatorMeshGroup(gltf.scene, box, rtcCenter, tileTransform);
                    if (group) {
                        this.scene.add(group);
                        this.loadedMeshes.set(url, group);
                        this.setStatus(`${this.loadedMeshes.size} tiles`);
                        this.map?.triggerRepaint();
                    }
                } catch (err) {
                    console.warn('GLB tile placement error:', err);
                }
            },
            undefined,
            (err) => {
                this.loadingUris.delete(url);
                console.warn('GLB load failed:', err);
            }
        );
    }

    /**
     * Google 3D Tiles (.glb) 内の全メッシュ頂点を 64bit 精度で ECEF -> MapLibre Mercator へ変換
     * GPU Float32 桁落ち・裏面カリング・法線反転を完全に回避する
     */
    buildMercatorMeshGroup(gltfScene, box, rtcCenter, tileTransform) {
        gltfScene.updateMatrixWorld(true);

        const rawVerts = [];
        const meshes = [];
        gltfScene.traverse((child) => {
            if (child.isMesh && child.geometry?.attributes?.position) {
                meshes.push(child);
                const pos = child.geometry.attributes.position;
                const v = new THREE.Vector3().fromBufferAttribute(pos, 0).applyMatrix4(child.matrixWorld);
                rawVerts.push(v);
            }
        });

        if (meshes.length === 0) return null;

        // サンプル頂点から glTF ワールド座標系と ECEF (box[0..2]) の対応関係を自動判定
        const v0 = rawVerts[0];
        let offsetX = 0, offsetY = 0, offsetZ = 0;
        if (rtcCenter && rtcCenter.length >= 3) {
            offsetX = rtcCenter[0];
            offsetY = rtcCenter[1];
            offsetZ = rtcCenter[2];
        } else if (tileTransform && tileTransform.length >= 16) {
            offsetX = tileTransform[12];
            offsetY = tileTransform[13];
            offsetZ = tileTransform[14];
        }

        // Y-up (glTF標準: EcefX = x, EcefY = -z, EcefZ = y) か Z-up かを box 中心との距離で判定
        const candYUp = [v0.x + offsetX, -v0.z + offsetY, v0.y + offsetZ];
        const candZUp = [v0.x + offsetX,  v0.y + offsetY, v0.z + offsetZ];

        let isYUp = true;
        if (box && box.length >= 3) {
            const dYUp = Math.hypot(candYUp[0] - box[0], candYUp[1] - box[1], candYUp[2] - box[2]);
            const dZUp = Math.hypot(candZUp[0] - box[0], candZUp[1] - box[1], candZUp[2] - box[2]);
            isYUp = dYUp <= dZUp;
            // もし頂点がローカル原点付近（|v0| < 100,000）でオフセット未指定なら box 中心を基準にする
            if (Math.hypot(candYUp[0], candYUp[1], candYUp[2]) < 1000000) {
                offsetX = box[0];
                offsetY = box[1];
                offsetZ = box[2];
            }
        }

        const toEcef = (vx, vy, vz) => {
            if (isYUp) return [vx + offsetX, -vz + offsetY, vy + offsetZ];
            return [vx + offsetX, vy + offsetY, vz + offsetZ];
        };

        // タイル基準点 (先頭頂点) の Mercator 座標と ENU 基底を算出
        const [refEx, refEy, refEz] = toEcef(v0.x, v0.y, v0.z);
        const { lon: refLon, lat: refLat, ellipsoidAlt: refEllipAlt } = ecefToLngLatAlt(refEx, refEy, refEz);
        const refOrthoAlt = refEllipAlt - DEFAULT_GEOID_OFFSET_M;
        const refMerc = maplibregl.MercatorCoordinate.fromLngLat([refLon, refLat], refOrthoAlt);
        const scale = refMerc.meterInMercatorCoordinateUnits();

        const latRad = (refLat * Math.PI) / 180;
        const lonRad = (refLon * Math.PI) / 180;
        const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
        const sinLon = Math.sin(lonRad), cosLon = Math.cos(lonRad);

        // ECEF における East, North, Up 単位ベクトル
        const eastX = -sinLon, eastY = cosLon, eastZ = 0;
        const northX = -sinLat * cosLon, northY = -sinLat * sinLon, northZ = cosLat;
        const upX = cosLat * cosLon, upY = cosLat * sinLon, upZ = sinLat;

        const group = new THREE.Group();
        group.position.set(
            refMerc.x - this.origin.x,
            refMerc.y - this.origin.y,
            refMerc.z - this.origin.z
        );

        const tempV = new THREE.Vector3();
        for (const srcMesh of meshes) {
            const geom = srcMesh.geometry.clone();
            const pos = geom.attributes.position;
            const count = pos.count;
            const newPositions = new Float32Array(count * 3);

            for (let i = 0; i < count; i++) {
                tempV.fromBufferAttribute(pos, i).applyMatrix4(srcMesh.matrixWorld);
                const [ex, ey, ez] = toEcef(tempV.x, tempV.y, tempV.z);
                const dx = ex - refEx;
                const dy = ey - refEy;
                const dz = ez - refEz;

                // ENU メートル変位 -> MapLibre Mercator (East=+X, South=+Y, Up=+Z)
                const eastM = dx * eastX + dy * eastY + dz * eastZ;
                const northM = dx * northX + dy * northY + dz * northZ;
                const upM = dx * upX + dy * upY + dz * upZ;

                newPositions[i * 3]     = eastM * scale;
                newPositions[i * 3 + 1] = -northM * scale;
                newPositions[i * 3 + 2] = upM * scale;
            }

            geom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
            geom.deleteAttribute('normal');
            geom.computeBoundingSphere();

            const srcMat = Array.isArray(srcMesh.material) ? srcMesh.material[0] : srcMesh.material;
            const mat = new THREE.MeshBasicMaterial({
                map: srcMat?.map || null,
                color: srcMat?.color || 0xffffff,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.92,
                depthTest: true,
                depthWrite: true
            });

            const outMesh = new THREE.Mesh(geom, mat);
            outMesh.frustumCulled = false;
            group.add(outMesh);
        }

        return group;
    }

    render(gl, matrix) {
        if (!this.visible || !this.renderer || !this.scene || !this.camera) return;

        this.updateTilesForCurrentView(false);
        if (this.loadedMeshes.size === 0 || !this.origin) return;

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
