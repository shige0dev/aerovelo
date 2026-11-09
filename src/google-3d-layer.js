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
const MAX_VIEW_DIST_M = 850;
const EVICT_DIST_M = 1400;
const MAX_CONCURRENT_GLB = 10;

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
        this.loadedMeshes = new Map();   // uri -> { group: THREE.Group, box: number[], ecefCenter: number[] }
        this.loadingUris = new Set();    // uri currently fetching
        this.pendingQueue = [];          // distance-sorted GLB queue
        this.activeGlbLoads = 0;
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
        for (const entry of this.loadedMeshes.values()) {
            this.scene?.remove(entry.group);
        }
        this.loadedMeshes.clear();
        this.loadingUris.clear();
        this.pendingQueue = [];
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
     * 現在視点周辺の 3D タイルを全方向均等に探索し、近い順にロードキューへ登録
     */
    async updateTilesForCurrentView(force = false) {
        if (!this.visible || !this.apiKey || !this.map) return;
        if (!this.rootNode) {
            this.ensureRootLoaded();
            return;
        }
        if (this.isTraversing) return;

        const now = performance.now();
        if (!force && now - this.lastUpdateTime < 500) return;

        const center = this.map.getCenter();
        const lon = center.lng;
        const lat = center.lat;
        const terrainEle = this.map.transform?.elevation || 0;

        if (!force && this.lastUpdatePos) {
            const dLon = (lon - this.lastUpdatePos.lon) * 91000;
            const dLat = (lat - this.lastUpdatePos.lat) * 111000;
            if (Math.hypot(dLon, dLat) < 35 && this.pendingQueue.length === 0) return;
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
        const candidates = [];
        let fetchedNewJson = false;

        try {
            const traverse = async (node, baseUrl = 'https://tile.googleapis.com/v1/3dtiles/root.json', depth = 0) => {
                if (!node || depth > 30) return;

                let distToTile = 0;
                const box = node.boundingVolume?.box;
                const region = node.boundingVolume?.region;
                if (box && box.length >= 12) {
                    distToTile = distanceToObb(targetEcef, box);
                } else if (region && region.length >= 4) {
                    distToTile = distanceToRegion(lon, lat, region);
                }

                if (distToTile > MAX_VIEW_DIST_M) return;

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
                // 近距離は高精細(14m)、中距離は24m、遠距離は38mでバランス良く面を埋める
                const targetError = distToTile < 320 ? 14 : distToTile < 600 ? 24 : 38;
                const isEnoughDetail = geomErr <= targetError || !hasChildren;

                if (isEnoughDetail && cleanPath.endsWith('.glb')) {
                    const fullUrl = this.resolveTileUrl(uri, baseUrl);
                    candidates.push({
                        fullUrl,
                        box,
                        transform: node.transform,
                        distToTile,
                        geomErr
                    });
                    return;
                }

                if (hasChildren) {
                    for (const child of node.children) {
                        await traverse(child, baseUrl, depth + 1);
                    }
                } else if (cleanPath.endsWith('.glb')) {
                    const fullUrl = this.resolveTileUrl(uri, baseUrl);
                    candidates.push({
                        fullUrl,
                        box,
                        transform: node.transform,
                        distToTile,
                        geomErr
                    });
                }
            };

            await traverse(this.rootNode, 'https://tile.googleapis.com/v1/3dtiles/root.json', 0);

            // カメラに近い順（360度全方位）にソートしてキューを更新
            candidates.sort((a, b) => a.distToTile - b.distToTile);
            const desiredUrls = new Set();
            const newQueue = [];
            for (const c of candidates) {
                if (desiredUrls.has(c.fullUrl)) continue;
                desiredUrls.add(c.fullUrl);
                if (!this.loadedMeshes.has(c.fullUrl) && !this.loadingUris.has(c.fullUrl)) {
                    newQueue.push(c);
                }
            }
            this.pendingQueue = newQueue;
            this.pumpGlbQueue();

            // 遠く離れたタイル（EVICT_DIST_M 超）のみ破棄し、表示中のタイルが消えるのを防ぐ
            if (this.loadedMeshes.size > 90) {
                for (const [uri, entry] of this.loadedMeshes.entries()) {
                    if (desiredUrls.has(uri)) continue;
                    const d = entry.box ? distanceToObb(targetEcef, entry.box) : 0;
                    if (d > EVICT_DIST_M) {
                        this.scene?.remove(entry.group);
                        this.loadedMeshes.delete(uri);
                    }
                }
            }

            if (this.loadedMeshes.size > 0) {
                this.setStatus(`${this.loadedMeshes.size} tiles`);
            } else if (this.loadingUris.size > 0 || this.pendingQueue.length > 0 || fetchedNewJson) {
                this.setStatus('読込中...');
            }
        } finally {
            this.isTraversing = false;
            if (fetchedNewJson) {
                setTimeout(() => this.updateTilesForCurrentView(true), 80);
            }
        }
    }

    pumpGlbQueue() {
        while (this.activeGlbLoads < MAX_CONCURRENT_GLB && this.pendingQueue.length > 0) {
            const item = this.pendingQueue.shift();
            if (!item || this.loadedMeshes.has(item.fullUrl) || this.loadingUris.has(item.fullUrl)) continue;
            this.loadGlbTile(item.fullUrl, item.box, item.transform);
        }
    }

    loadGlbTile(url, box, tileTransform) {
        if (!this.gltfLoader || !this.scene) return;
        this.loadingUris.add(url);
        this.activeGlbLoads++;
        this.setStatus(this.loadedMeshes.size > 0 ? `${this.loadedMeshes.size} tiles` : '読込中...');

        this.gltfLoader.load(
            url,
            (gltf) => {
                this.loadingUris.delete(url);
                this.activeGlbLoads = Math.max(0, this.activeGlbLoads - 1);
                try {
                    const rtcCenter = gltf.parser?.json?.extensions?.CESIUM_RTC?.center ||
                                      gltf.userData?.gltfExtensions?.CESIUM_RTC?.center || null;
                    const group = this.buildMercatorMeshGroup(gltf.scene, box, rtcCenter, tileTransform);
                    if (group) {
                        this.scene.add(group);
                        this.loadedMeshes.set(url, { group, box });
                        this.setStatus(`${this.loadedMeshes.size} tiles`);
                        this.map?.triggerRepaint();
                    }
                } catch (err) {
                    console.warn('GLB tile placement error:', err);
                }
                this.pumpGlbQueue();
            },
            undefined,
            (err) => {
                this.loadingUris.delete(url);
                this.activeGlbLoads = Math.max(0, this.activeGlbLoads - 1);
                console.warn('GLB load failed:', err);
                this.pumpGlbQueue();
            }
        );
    }

    /**
     * Google 3D Tiles (.glb) 内の全メッシュ頂点を 64bit 精度で ECEF -> MapLibre Mercator へ変換
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

        const candYUp = [v0.x + offsetX, -v0.z + offsetY, v0.y + offsetZ];
        const candZUp = [v0.x + offsetX,  v0.y + offsetY, v0.z + offsetZ];

        let isYUp = true;
        if (box && box.length >= 3) {
            const dYUp = Math.hypot(candYUp[0] - box[0], candYUp[1] - box[1], candYUp[2] - box[2]);
            const dZUp = Math.hypot(candZUp[0] - box[0], candZUp[1] - box[1], candZUp[2] - box[2]);
            isYUp = dYUp <= dZUp;
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

        const [refEx, refEy, refEz] = toEcef(v0.x, v0.y, v0.z);
        const { lon: refLon, lat: refLat, ellipsoidAlt: refEllipAlt } = ecefToLngLatAlt(refEx, refEy, refEz);
        const refOrthoAlt = refEllipAlt - DEFAULT_GEOID_OFFSET_M;
        const refMerc = maplibregl.MercatorCoordinate.fromLngLat([refLon, refLat], refOrthoAlt);
        const scale = refMerc.meterInMercatorCoordinateUnits();

        const latRad = (refLat * Math.PI) / 180;
        const lonRad = (refLon * Math.PI) / 180;
        const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
        const sinLon = Math.sin(lonRad), cosLon = Math.cos(lonRad);

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
                transparent: false,
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

        const m = new THREE.Matrix4().fromArray(matrix);
        const l = new THREE.Matrix4().makeTranslation(
            this.origin.x,
            this.origin.y,
            this.origin.z
        );
        this.camera.projectionMatrix = m.multiply(l);

        // 背面の2D衛星写真地形メッシュが3D建物を遮蔽（Zファイティング・埋没）しないよう深度バッファをクリアして描画
        gl.clear(gl.DEPTH_BUFFER_BIT);

        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
    }
}
