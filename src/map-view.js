/**
 * 3D Terrain Map & Chase Camera Controller (MapLibre GL JS)
 * Handles satellite/terrain rendering, DEM contour isolines, route layers, and camera tracking.
 */

import { clamp } from './utils.js';
import { HYBRID_DEM_URL, registerGsiDemProtocol } from './dem-service.js';
import { CourseRibbonLayer } from './ribbon-layer.js';

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
        this.ribbonLayer = new CourseRibbonLayer('course-ribbon-3d', 3.5);

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

            // 3D コースリボンレイヤー（地面 + 1.0m の空中・立体道路オブジェクト）を追加
            if (!this.map.getLayer(this.ribbonLayer.id)) {
                this.map.addLayer(this.ribbonLayer);
            }

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

        if (!this.isMapLoaded) {
            this.pendingCourse = course;
            this.pendingState = initialState;
            return;
        }

        // 3D コースリボン（地面 + 1.0m）の更新
        this.ribbonLayer?.updateCourse(course);

        const geojsonData = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: course.toGeoJSONCoordinates() }
        };

        const pointsGeoJson = course.toDefinitionPointsGeoJSON?.() || { type: 'FeatureCollection', features: [] };

        // コースライン色（基本は白、橋はオレンジ、トンネルはパープル）
        const gradientExpr = ['interpolate', ['linear'], ['line-progress']];
        let lastP = -1;
        for (const [p, color] of course.getRouteColorStops()) {
            if (p <= lastP) continue;
            gradientExpr.push(p, color);
            lastP = p;
        }

        if (this.map.getSource('route')) {
            this.map.getSource('route').setData(geojsonData);
            this.map.setLayoutProperty('route-glow', 'visibility', 'none');
            this.map.setLayoutProperty('route-line', 'visibility', 'none');
        } else {
            this.map.addSource('route', { type: 'geojson', data: geojsonData, lineMetrics: true });
            const layout = { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'none' };
            this.map.addLayer({
                id: 'route-glow',
                type: 'line',
                source: 'route',
                layout,
                paint: { 'line-color': '#000000', 'line-width': 8, 'line-opacity': 0.5, 'line-blur': 1.5 }
            });
            this.map.addLayer({
                id: 'route-line',
                type: 'line',
                source: 'route',
                layout,
                paint: { 'line-width': 4.5, 'line-gradient': gradientExpr }
            });
        }

        // 定義点（GPXポイント）の高度ステップ着色ドットレイヤー（地盤メッシュ上は非表示）
        if (this.map.getSource('route-points')) {
            this.map.getSource('route-points').setData(pointsGeoJson);
            this.map.setLayoutProperty('route-points-circle', 'visibility', 'none');
        } else {
            this.map.addSource('route-points', { type: 'geojson', data: pointsGeoJson });
            this.map.addLayer({
                id: 'route-points-circle',
                type: 'circle',
                source: 'route-points',
                layout: { 'visibility': 'none' },
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 4.5, 18, 6],
                    'circle-color': ['get', 'color'],
                    'circle-stroke-color': '#475569',
                    'circle-stroke-width': 0.8,
                    'circle-opacity': 0.95
                }
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
     * メイン画面スワイプによるカメラアングル（横スワイプ: ライダー上下を境に反転）およびピッチ調整（縦スワイプ）
     */
    setupMainScreenSwipe() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        let isDragging = false;
        let startX = 0, startY = 0;
        let startPitch = 0, startOrbit = 0;
        let pendingPitch = null, pendingOrbit = null;
        let isAboveRider = true;
        let rafId = null;

        const flushCameraUpdate = () => {
            rafId = null;
            let changed = false;
            if (pendingPitch !== null && pendingPitch !== this.cam.pitch) {
                this.cam.pitch = pendingPitch;
                changed = true;
            }
            if (pendingOrbit !== null && pendingOrbit !== this.cam.orbit) {
                this.cam.orbit = pendingOrbit;
                changed = true;
            }
            if (changed && this.lastState) {
                this.onCameraChange?.({ pitch: this.cam.pitch, orbit: this.cam.orbit });
                this.applyCameraTarget(this.lastState, 0);
            }
        };

        container.addEventListener('pointerdown', (e) => {
            if (this.cam.mode !== 'track') return;
            if (e.target.closest('#top-bar, #hud-metrics, #bottom-bar, .floating-dialog, .compass-widget')) return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startPitch = this.cam.pitch;
            startOrbit = this.cam.orbit;
            pendingPitch = startPitch;
            pendingOrbit = startOrbit;

            // 現在ポイント（ライダー位置）の画面Y座標を取得し、上下どちらをタップしたか判定
            const rect = container.getBoundingClientRect();
            let riderScreenY = rect.top + rect.height * 0.65;
            if (this.map && this.lastState) {
                try {
                    const pt = this.map.project([this.lastState.lon, this.lastState.lat]);
                    if (pt && typeof pt.y === 'number') {
                        riderScreenY = rect.top + pt.y;
                    }
                } catch {}
            }
            isAboveRider = startY < riderScreenY;

            container.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        }, { passive: false });

        container.addEventListener('pointermove', (e) => {
            if (!isDragging || this.cam.mode !== 'track') return;
            e.preventDefault();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            // 1. 縦スワイプ: ピッチ調整 (20〜75度)
            const nextPitch = clamp(Math.round((startPitch - dy * 0.2) * 10) / 10, 20, 75);

            // 2. 横スワイプ: アングル(orbit)調整 (-180〜180度)
            // 現在ポイント（ライダー位置）の上下を境に反応を反転
            const direction = isAboveRider ? 1 : -1;
            const deltaAngle = dx * 0.35 * direction;
            const nextOrbit = clamp(Math.round(startOrbit + deltaAngle), -180, 180);

            if (nextPitch !== pendingPitch || nextOrbit !== pendingOrbit) {
                pendingPitch = nextPitch;
                pendingOrbit = nextOrbit;
                if (!rafId) {
                    rafId = requestAnimationFrame(flushCameraUpdate);
                }
            }
        }, { passive: false });

        const endDrag = (e) => {
            if (isDragging) {
                isDragging = false;
                try { container.releasePointerCapture?.(e.pointerId); } catch {}
                if (rafId) {
                    cancelAnimationFrame(rafId);
                    flushCameraUpdate();
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
