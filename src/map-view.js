/**
 * 3D Terrain Map, Full-Screen 5m/2.5m Contour Lines, & Chase Camera Controller (MapLibre GL JS)
 * Handles satellite/terrain rendering, DEM contour isolines, route layers, and camera tracking.
 */

import { clamp } from './course.js';

const DEM_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

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

        this.initMap(initialState);
        this.setupMainScreenSwipe();
    }

    get cameraMode() {
        return this.cam.mode;
    }

    initMap(startState) {
        // maplibre-contour による画面全体リアルタイム等高線生成プロトコル登録
        if (window.mlcontour) {
            try {
                this.demSource = new window.mlcontour.DemSource({
                    url: DEM_TILE_URL,
                    encoding: 'terrarium',
                    maxzoom: 14,
                    worker: true
                });
                this.demSource.setupMaplibre(maplibregl);
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
                tiles: [DEM_TILE_URL],
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
                        // z=14 のDEMタイルをオーバーズームして z=16 (カメラズーム16.5〜18.0) でも 404 を出さずに滑らかに生成
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
                    'line-color': 'rgba(255, 225, 110, 0.55)',
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
            // 3D地形の高さ倍率を 1.0 (実寸) に設定し、計算標高・等高線・視覚勾配を完全一致させる
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

        if (this.map.getSource('route')) {
            this.map.getSource('route').setData(geojsonData);
        } else {
            this.map.addSource('route', { type: 'geojson', data: geojsonData });
            const layout = { 'line-join': 'round', 'line-cap': 'round' };
            this.map.addLayer({
                id: 'route-glow',
                type: 'line',
                source: 'route',
                layout,
                paint: { 'line-color': '#00f0ff', 'line-width': 8, 'line-opacity': 0.6, 'line-blur': 3 }
            });
            this.map.addLayer({
                id: 'route-line',
                type: 'line',
                source: 'route',
                layout,
                paint: { 'line-color': '#ffffff', 'line-width': 4 }
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
            this.map.setLayoutProperty('contour-lines', 'visibility', visibility.contour ? 'visible' : 'none');
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
            // 0.1度刻みの滑らかな補間（感度: 0.2）
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

        // スムージング度合い0（無効時）、初回ロード時、アニメーション指定時、または停止中（手動操作時）は即座に目標方向へ向く
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
