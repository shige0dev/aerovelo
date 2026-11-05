/**
 * 3D Terrain Map, GSI 10m / AWS 30m Hybrid DEM, 5m Contour Lines, & Chase Camera Controller (MapLibre GL JS)
 * Handles satellite/terrain rendering, DEM contour isolines, route layers, and camera tracking.
 */

import { clamp } from './course.js';
import { decodeAndFillGsiTile, encodeTerrariumPixel } from './gpx-gsi.js';

const DEM_AWS_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const HYBRID_DEM_URL = 'gsi-dem://{z}/{x}/{y}';

// タイルメモリキャッシュ（3D地形とコンター生成で同一タイルを1回だけフェッチ・変換）
const tileCache = new Map();
const inFlightTiles = new Map();
let activeCourseForDem = null;

/**
 * 3D地形メッシュが橋の下の谷底・湖面に落ち込まないよう、
 * タイル内の橋 (bridge) 区間の標高を路面標高（直線高度）に持ち上げる
 */
function applyBridgesToDemGrid(grid, z, x, y, course) {
    const bridges = (course.structureRanges || []).filter((r) => r.type === 'bridge');
    if (!bridges.length) return;

    const n = 2 ** z;
    const lonMin = (x / n) * 360 - 180;
    const lonMax = ((x + 1) / n) * 360 - 180;
    const latRadMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)));
    const latRadMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
    const latMin = (latRadMin * 180) / Math.PI;
    const latMax = (latRadMax * 180) / Math.PI;

    const pad = 0.001;
    const pts = course.interpolatedPoints || course.rawSamples || [];

    for (const b of bridges) {
        for (const p of pts) {
            if (p.dist < b.d0 || p.dist > b.d1) continue;
            if (p.lon < lonMin - pad || p.lon > lonMax + pad || p.lat < latMin - pad || p.lat > latMax + pad) continue;

            const latRad = (p.lat * Math.PI) / 180;
            const my = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
            const px = Math.round(((p.lon - lonMin) / (lonMax - lonMin)) * 256);
            const py = Math.round((my * n - y) * 256);

            const bridgeAlt = p.alt;
            for (let dy = -1; dy <= 1; dy++) {
                const gy = py + dy;
                if (gy < 0 || gy >= 256) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const gx = px + dx;
                    if (gx < 0 || gx >= 256) continue;
                    const gIdx = gy * 256 + gx;
                    if (bridgeAlt > grid[gIdx]) {
                        grid[gIdx] = bridgeAlt;
                    }
                }
            }
        }
    }
}

/**
 * 国土地理院 10mメッシュ (dem_png z<=14) を取得し、水面補完＋Terrarium形式RGB (ArrayBuffer) に変換する共通関数
 * ※重要: MapLibre Workerへ渡すと ArrayBuffer が移転(Detached)されてメモリ長0になるため、
 * キャッシュには原本を保持し、呼び出し側へは必ず .slice(0) で安全な複製を返す。
 */
async function fetchGsiTerrariumPng(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key).slice(0);
    if (inFlightTiles.has(key)) {
        const buf = await inFlightTiles.get(key);
        return buf ? buf.slice(0) : null;
    }

    const promise = (async () => {
        // 日本国外または広域低ズーム(z < 9)または z > 14 は AWS Terrarium へフォールバック
        const n = 2 ** z;
        const lonMin = (x / n) * 360 - 180;
        const lonMax = ((x + 1) / n) * 360 - 180;
        const isJapan = lonMin < 154 && lonMax > 122;

        if (!isJapan || z < 9 || z > 14) {
            const res = await fetch(`${DEM_AWS_BASE}/${z}/${x}/${y}.png?_c=1`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.arrayBuffer();
        }

        // 日本国内 (z=9〜14): 国土地理院 10mメッシュ統合タイル (dem_png) を 1:1 座標で取得・変換
        try {
            const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const img = await createImageBitmap(blob);

            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, 256, 256);
            const imgData = ctx.getImageData(0, 0, 256, 256);
            const d = imgData.data;

            // 水面(NoData)を周囲の水際標高でシームレスに補完し、Terrarium RGB形式へ変換
            const grid = decodeAndFillGsiTile(d);
            if (!grid) {
                const awsRes = await fetch(`${DEM_AWS_BASE}/${z}/${x}/${y}.png?_c=1`);
                return await awsRes.arrayBuffer();
            }

            // コース上に橋 (bridge) が存在する場合、3D地形メッシュが谷底・湖面に落ち込まないよう
            // タイル内の橋区間のメッシュ標高を路面標高（直線高度）に持ち上げる
            if (activeCourseForDem && Array.isArray(activeCourseForDem.structureRanges)) {
                applyBridgesToDemGrid(grid, z, x, y, activeCourseForDem);
            }

            for (let i = 0; i < 65536; i++) {
                const [tr, tg, tb] = encodeTerrariumPixel(grid[i]);
                const idx = i * 4;
                d[idx] = tr;
                d[idx + 1] = tg;
                d[idx + 2] = tb;
                d[idx + 3] = 255;
            }

            ctx.putImageData(imgData, 0, 0);
            const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            if (!outBlob) throw new Error('toBlob failed');
            return await outBlob.arrayBuffer();
        } catch {
            const awsRes = await fetch(`${DEM_AWS_BASE}/${z}/${x}/${y}.png?_c=1`);
            return await awsRes.arrayBuffer();
        }
    })();

    inFlightTiles.set(key, promise);
    try {
        const buf = await promise;
        if (buf && buf.byteLength > 0) {
            tileCache.set(key, buf);
            if (tileCache.size > 200) {
                const oldest = tileCache.keys().next().value;
                tileCache.delete(oldest);
            }
            return buf.slice(0);
        }
        return buf;
    } finally {
        inFlightTiles.delete(key);
    }
}

// 国土地理院 10mメッシュを 3D地形 (MapLibre addProtocol) および等高線 (fetch hook) の双方に直結
let isGsiProtocolRegistered = false;
function registerGsiDemProtocol() {
    if (isGsiProtocolRegistered) return;
    isGsiProtocolRegistered = true;

    // 1. window.fetch をフックして gsi-dem:// をインターセプト
    // これにより mlcontour (worker: false) が呼ぶ fetch も完全に国土地理院 10m メッシュになる
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
        const urlStr = typeof input === 'string' ? input : (input?.url || '');
        const match = urlStr.match(/^gsi-dem:\/\/(\d+)\/(\d+)\/(\d+)/);
        if (match) {
            try {
                const z = parseInt(match[1], 10);
                const x = parseInt(match[2], 10);
                const y = parseInt(match[3], 10);
                const buf = await fetchGsiTerrariumPng(z, x, y);
                return new Response(buf, {
                    status: 200,
                    headers: { 'Content-Type': 'image/png' }
                });
            } catch (err) {
                return new Response(null, { status: 404, statusText: err.message });
            }
        }
        return origFetch.apply(this, arguments);
    };

    // 2. MapLibre GL JS の addProtocol にも登録 (3D地形用)
    if (window.maplibregl?.addProtocol) {
        maplibregl.addProtocol('gsi-dem', (params, callback) => {
            const match = params.url.match(/gsi-dem:\/\/(\d+)\/(\d+)\/(\d+)/);
            if (!match) {
                callback(new Error('Invalid gsi-dem URL'));
                return { cancel: () => {} };
            }
            const z = parseInt(match[1], 10);
            const x = parseInt(match[2], 10);
            const y = parseInt(match[3], 10);
            fetchGsiTerrariumPng(z, x, y)
                .then((buf) => callback(null, buf, null, null))
                .catch((err) => callback(err));
            return { cancel: () => {} };
        });
    }
}

export class MapViewController {
    constructor(containerId = 'map', initialState = { lon: 138.583, lat: 35.474, bearing: 0 }, onCameraChange = null) {
        this.containerId = containerId;
        this.onCameraChange = onCameraChange;
        this.cam = {
            mode: 'track', // 'track' | 'free'
            isTransitioning: false,
            smooth: 5,     // 0 = なし (OFF), 1〜10 = スムージング度合い
            bearing: null,
            orbit: 0,
            pitch: 68,
            zoom: 16.5
        };
        this.lastState = initialState;
        this.markers = { rider: null, fwd: null, bwd: null };
        // 前後注視点マーカー・等高線は起動時非表示 (SHOWボタン押下で表示)
        this.markerVisible = { fwd: false, bwd: false, contour: false };
        this.isMapLoaded = false;
        this.demSource = null;

        registerGsiDemProtocol();
        this.initMap(initialState);
        this.setupMainScreenSwipe();
    }

    get cameraMode() {
        return this.cam.mode;
    }

    initMap(startState) {
        // maplibre-contour による国土地理院 10m メッシュ等高線生成プロトコル登録
        // worker: false によりメインスレッドの fetch フックを通して gsi-dem:// (10mメッシュ) から直接生成
        if (window.mlcontour) {
            try {
                this.demSource = new window.mlcontour.DemSource({
                    url: HYBRID_DEM_URL,
                    encoding: 'terrarium',
                    maxzoom: 14,
                    worker: false
                });
                // MapLibre WorkerへのTransferによってmlcontour内部キャッシュのPBF ArrayBufferが
                // Detached(0バイト化)されるのを防ぐため、常に .slice(0) で複製を渡すラッパーを介して登録
                this.demSource.setupMaplibre({
                    addProtocol: (customProtocol, loadFn) => {
                        maplibregl.addProtocol(customProtocol, (params, callback) => {
                            return loadFn(params, (err, buf, cacheControl, expires) => {
                                const safeBuf = (buf && buf.byteLength > 0 && typeof buf.slice === 'function')
                                    ? buf.slice(0)
                                    : buf;
                                callback(err, safeBuf, cacheControl, expires);
                            });
                        });
                    }
                });
            } catch (err) {
                console.warn('Contour DemSource setup error:', err);
                this.demSource = null;
            }
        }

        const sources = {
            'satellite': {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics'
            },
            'terrain-dem': {
                type: 'raster-dem',
                tiles: [HYBRID_DEM_URL],
                encoding: 'terrarium',
                tileSize: 256,
                maxzoom: 14
            }
        };

        const layers = [
            { id: 'satellite-layer', type: 'raster', source: 'satellite', minzoom: 0, maxzoom: 22 }
        ];

        if (this.demSource) {
            sources['contours'] = {
                type: 'vector',
                tiles: [
                    this.demSource.contourProtocolUrl({
                        multiplier: 1,
                        overzoom: 2,
                        thresholds: {
                            11: [25],
                            12: [10],
                            13: [5],
                            14: [5],
                            15: [5],
                            16: [5]
                        },
                        elevationKey: 'ele',
                        levelKey: 'level',
                        contourLayer: 'contours'
                    })
                ],
                maxzoom: 16
            };

            layers.push({
                id: 'contour-lines',
                type: 'line',
                source: 'contours',
                'source-layer': 'contours',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round',
                    'visibility': this.markerVisible.contour ? 'visible' : 'none'
                },
                paint: {
                    'line-color': 'rgba(255, 225, 110, 1.0)',
                    'line-opacity': this.markerVisible.contour ? 0.55 : 0,
                    'line-width': 0.8
                }
            });
        }

        this.map = new maplibregl.Map({
            container: this.containerId,
            fadeDuration: 0,
            style: {
                version: 8,
                sources,
                layers,
                sky: {
                    'sky-color': '#1e293b',
                    'sky-horizon-blend': 0.6,
                    'horizon-color': '#38bdf8',
                    'horizon-fog-blend': 0.6,
                    'fog-color': '#0284c7',
                    'fog-ground-blend': 0.4
                }
            },
            center: [startState.lon, startState.lat],
            zoom: this.cam.zoom,
            pitch: this.cam.pitch,
            bearing: startState.bearing,
            maxPitch: 75
        });

        this.map.on('load', () => {
            this.isMapLoaded = true;
            // 国土地理院 10mメッシュ (dem_png) / 海外 30mメッシュ起伏を実寸 1.0 で立体レンダリング
            this.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.0 });

            const makeMarker = (cls, html) => {
                const el = document.createElement('div');
                el.className = cls;
                el.innerHTML = html;
                return new maplibregl.Marker({ element: el })
                    .setLngLat([startState.lon, startState.lat])
                    .addTo(this.map);
            };

            this.markers.rider = makeMarker('rider-marker', '<div class="rider-beacon"></div><div class="rider-dot"></div>');
            this.markers.fwd = makeMarker('target-marker fwd-marker', '<div class="target-dot" title="前方注視点"></div>');
            this.markers.bwd = makeMarker('target-marker bwd-marker', '<div class="target-dot" title="後方注視点"></div>');
            this.syncTargetMarkers(startState);

            if (this.pendingCourse) {
                this.setCourse(this.pendingCourse, this.pendingState);
                this.pendingCourse = null;
            }

            if (this.cam.mode === 'track') {
                this.map.dragPan.disable();
                this.map.dragRotate.disable();
                this.map.touchPitch?.disable();
                this.map.touchZoomRotate?.disable();
            }

            this.map.on('rotate', () => {
                this.onCameraChange?.({ bearing: this.map.getBearing() });
            });
        });
    }

    getCameraPadding() {
        return { left: 0, top: Math.round(window.innerHeight * 0.35), right: 0, bottom: 0 };
    }

    setCourse(course, initialState) {
        this.cam.bearing = null;
        if (!this.map) return;

        activeCourseForDem = course;
        tileCache.clear(); // 橋の3D標高持ち上げを反映するためDEMタイルキャッシュを更新

        if (!this.isMapLoaded) {
            this.pendingCourse = course;
            this.pendingState = initialState;
            return;
        }

        const geojsonData = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: course.toGeoJSONCoordinates() }
        };

        // 勾配で彩度・明度を変える line-gradient（line-progress は経路長比率 0〜1）
        const gradientExpr = ['interpolate', ['linear'], ['line-progress']];
        let lastP = -1;
        for (const [p, color] of course.getRouteColorStops()) {
            if (p <= lastP) continue;
            gradientExpr.push(p, color);
            lastP = p;
        }

        if (this.map.getSource('route')) {
            this.map.getSource('route').setData(geojsonData);
            this.map.setPaintProperty('route-line', 'line-gradient', gradientExpr);
        } else {
            this.map.addSource('route', { type: 'geojson', data: geojsonData, lineMetrics: true });
            const layout = { 'line-join': 'round', 'line-cap': 'round' };
            this.map.addLayer({
                id: 'route-glow',
                type: 'line',
                source: 'route',
                layout,
                paint: { 'line-color': '#000000', 'line-width': 9, 'line-opacity': 0.45, 'line-blur': 2 }
            });
            this.map.addLayer({
                id: 'route-line',
                type: 'line',
                source: 'route',
                layout,
                paint: { 'line-width': 5, 'line-gradient': gradientExpr }
            });
        }

        if (initialState) this.updateRiderAndCamera(initialState, 1500);
    }

    syncTargetMarkers(state = this.lastState) {
        if (!state) return;
        for (const [key, pt] of [['fwd', state.fwdPoint], ['bwd', state.bwdPoint]]) {
            const marker = this.markers[key];
            if (!marker) continue;
            const visible = !!(pt && this.markerVisible[key]);
            if (visible) marker.setLngLat([pt.lon, pt.lat]);
            marker.getElement().style.display = visible ? 'flex' : 'none';
        }
    }

    setMarkerVisibility(visibility) {
        Object.assign(this.markerVisible, visibility);
        if (typeof visibility.contour === 'boolean' && this.map?.getLayer('contour-lines')) {
            if (visibility.contour && this.map.getLayoutProperty('contour-lines', 'visibility') === 'none') {
                this.map.setLayoutProperty('contour-lines', 'visibility', 'visible');
            }
            this.map.setPaintProperty('contour-lines', 'line-opacity', visibility.contour ? 0.55 : 0);
        }
        this.syncTargetMarkers();
    }

    updateRiderAndCamera(state, duration = 0, isMoving = false) {
        this.lastState = state;
        this.markers.rider?.setLngLat([state.lon, state.lat]);
        this.syncTargetMarkers(state);

        if (!this.cam.isTransitioning && this.cam.mode !== 'free') {
            this.applyCameraTarget(state, duration, isMoving);
        }
    }

    setCameraMode(mode, currentState) {
        this.cam.mode = mode;
        if (this.map) {
            const action = mode === 'free' ? 'enable' : 'disable';
            this.map.dragPan[action]();
            this.map.dragRotate[action]();
            this.map.touchPitch?.[action]();
            this.map.touchZoomRotate?.[action]();
        }
        if (mode !== 'free' && currentState) {
            this.cam.bearing = null;
            this.cam.isTransitioning = true;
            this.applyCameraTarget(currentState, 2000);
            setTimeout(() => { this.cam.isTransitioning = false; }, 2000);
        }
    }

    setSmoothing(val) {
        this.cam.smooth = clamp(Number(val) || 0, 0, 10);
    }

    /**
     * メイン画面上下スワイプによるカメラピッチ調整（スマホでの引っ掛かり・フレーム落ちを防止）
     */
    setupMainScreenSwipe() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        let isDragging = false, startY = 0, startPitch = 0;
        let pendingPitch = null;
        let rafId = null;

        const flushPitchUpdate = () => {
            rafId = null;
            if (pendingPitch !== null && this.lastState) {
                this.cam.pitch = pendingPitch;
                this.onCameraChange?.({ pitch: pendingPitch });
                this.applyCameraTarget(this.lastState, 0);
            }
        };

        container.addEventListener('pointerdown', (e) => {
            if (this.cam.mode !== 'track') return;
            if (e.target.closest('#top-bar, #hud-metrics, #bottom-bar, .floating-dialog, .compass-widget')) return;

            isDragging = true;
            startY = e.clientY;
            startPitch = this.cam.pitch;
            pendingPitch = startPitch;
            container.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        }, { passive: false });

        container.addEventListener('pointermove', (e) => {
            if (!isDragging || this.cam.mode !== 'track') return;
            e.preventDefault();
            const dy = e.clientY - startY;
            const nextPitch = clamp(Math.round((startPitch - dy * 0.2) * 10) / 10, 20, 75);
            if (nextPitch !== pendingPitch) {
                pendingPitch = nextPitch;
                if (!rafId) {
                    rafId = requestAnimationFrame(flushPitchUpdate);
                }
            }
        }, { passive: false });

        const endDrag = (e) => {
            if (isDragging) {
                isDragging = false;
                try { container.releasePointerCapture?.(e.pointerId); } catch {}
                if (rafId) {
                    cancelAnimationFrame(rafId);
                    flushPitchUpdate();
                }
            }
        };
        container.addEventListener('pointerup', endDrag);
        container.addEventListener('pointercancel', endDrag);
    }

    setCameraParams({ pitch, zoom, orbit, smooth }, currentState) {
        if (typeof pitch === 'number') this.cam.pitch = pitch;
        if (typeof zoom === 'number') this.cam.zoom = zoom;
        if (typeof orbit === 'number') this.cam.orbit = orbit;
        if (typeof smooth === 'number') this.setSmoothing(smooth);
        if (this.cam.mode !== 'free' && currentState) this.applyCameraTarget(currentState, 0);
    }

    resize(currentState) {
        if (!this.map) return;
        this.map.resize();
        if (this.cam.mode !== 'free' && currentState) this.applyCameraTarget(currentState, 0);
    }

    applyCameraTarget(state, duration = 0, isMoving = false) {
        if (!this.map || this.cam.mode === 'free' || !state) return;

        const targetPitch = this.cam.pitch;
        const targetBearing = (state.bearing - this.cam.orbit + 360) % 360;

        if (this.cam.smooth === 0 || this.cam.bearing === null || duration > 0 || !isMoving) {
            this.cam.bearing = targetBearing;
        } else {
            const diff = ((targetBearing - this.cam.bearing + 540) % 360) - 180;
            const scale = 1 + this.cam.smooth * 0.8;
            const factor = 0.4 / scale;
            const maxStep = 7.5 / scale;
            const step = clamp(diff * factor, -maxStep, maxStep);
            this.cam.bearing = (this.cam.bearing + step + 360) % 360;
        }

        const cameraOptions = {
            center: [state.lon, state.lat],
            pitch: targetPitch,
            bearing: this.cam.bearing,
            zoom: this.cam.zoom,
            padding: this.getCameraPadding(),
            duration,
            essential: true
        };

        if (duration > 0) this.map.easeTo(cameraOptions);
        else this.map.jumpTo(cameraOptions);

        this.onCameraChange?.({ bearing: this.cam.bearing });
    }
}
