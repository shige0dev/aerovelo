/**
 * 3D Terrain Map & Chase Camera Controller (MapLibre GL JS)
 * Handles satellite/terrain rendering, route line layers, rider marker, and camera tracking.
 */

import { clamp } from './course.js';

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
        this.markerVisible = { fwd: true, bwd: true };

        this.initMap(initialState);
        this.setupMainScreenSwipe();
    }

    get cameraMode() {
        return this.cam.mode;
    }

    initMap(startState) {
        this.map = new maplibregl.Map({
            container: this.containerId,
            fadeDuration: 0,
            style: {
                version: 8,
                sources: {
                    'satellite': {
                        type: 'raster',
                        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                        tileSize: 256,
                        attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics'
                    },
                    'terrain-dem': {
                        type: 'raster-dem',
                        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
                        encoding: 'terrarium',
                        tileSize: 256,
                        maxzoom: 14
                    }
                },
                layers: [{ id: 'satellite-layer', type: 'raster', source: 'satellite', minzoom: 0, maxzoom: 22 }],
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
            this.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.15 });

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

            if (this.pendingCourse) {
                this.setCourse(this.pendingCourse, this.pendingState);
                this.pendingCourse = null;
            }

            if (this.cam.mode === 'track') {
                this.map.dragPan.disable();
                this.map.dragRotate.disable();
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

        if (!this.map.isStyleLoaded()) {
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
     * メイン画面上下スワイプによるカメラピッチ調整
     */
    setupMainScreenSwipe() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        let isDragging = false, startY = 0, startPitch = 0;

        container.addEventListener('pointerdown', (e) => {
            if (this.cam.mode !== 'track') return;
            if (e.target.closest('#top-bar, #hud-metrics, #bottom-bar, .floating-dialog, .compass-widget')) return;

            isDragging = true;
            startY = e.clientY;
            startPitch = this.cam.pitch;
            container.setPointerCapture?.(e.pointerId);
        });

        container.addEventListener('pointermove', (e) => {
            if (!isDragging || this.cam.mode !== 'track') return;
            const nextPitch = clamp(Math.round(startPitch - (e.clientY - startY) * 0.25), 20, 75);
            this.cam.pitch = nextPitch;
            this.onCameraChange?.({ pitch: nextPitch });
            if (this.lastState) this.applyCameraTarget(this.lastState, 0);
        });

        const endDrag = (e) => {
            if (isDragging) {
                isDragging = false;
                container.releasePointerCapture?.(e.pointerId);
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

        let targetPitch = this.cam.pitch;
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

        if (this.map.queryTerrainElevation) {
            const rad = (this.cam.bearing + 180) * (Math.PI / 180);
            const camLon = state.lon + (50 * Math.sin(rad)) / (111320 * Math.cos(state.lat * Math.PI / 180));
            const camLat = state.lat + (50 * Math.cos(rad)) / 110574;
            const terrainAlt = this.map.queryTerrainElevation([camLon, camLat]);
            if (terrainAlt !== null && terrainAlt > state.alt + 12) {
                targetPitch = Math.min(targetPitch, 45);
            }
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
