/**
 * 3D Terrain Map & Chase Camera Controller (MapLibre GL JS)
 * Handles satellite/terrain rendering, route line layers, rider marker, and camera tracking.
 */

export class MapViewController {
    constructor(containerId = 'map', initialState = { lon: 138.583, lat: 35.474, bearing: 0 }, onCameraParamChange = null) {
        this.containerId = containerId;
        this.onCameraParamChange = onCameraParamChange;
        this.cameraMode = 'track'; // 'track' | 'free'
        this.isModeTransitioning = false;
        this.smoothStrength = 5; // 0 = なし (OFF), 1〜10 = スムージング度合い
        this.currentCamBearing = null;
        this.orbitAngleOffset = 0;
        this.cameraParams = { pitch: 68, zoom: 16.5 };
        this.lastState = initialState;
        this.riderMarker = null;
        this.fwdMarker = null;
        this.bwdMarker = null;
        this.showFwdMarker = true;
        this.showBwdMarker = true;
        this.initMap(initialState);
        // this.setupMainScreenSwipe(); // 全画面スワイプでのアングル調整は一時停止
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
            zoom: this.cameraParams.zoom,
            pitch: this.cameraParams.pitch,
            bearing: startState.bearing,
            maxPitch: 75
        });

        this.map.on('load', () => {
            this.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.15 });
            const el = document.createElement('div');
            el.className = 'rider-marker';
            el.innerHTML = '<div class="rider-beacon"></div><div class="rider-dot"></div>';
            this.riderMarker = new maplibregl.Marker({ element: el })
                .setLngLat([startState.lon, startState.lat])
                .addTo(this.map);

            // 前方注視点マーカー (赤ドット)
            const fwdEl = document.createElement('div');
            fwdEl.className = 'target-marker fwd-marker';
            fwdEl.innerHTML = '<div class="target-dot" title="前方注視点"></div>';
            this.fwdMarker = new maplibregl.Marker({ element: fwdEl })
                .setLngLat([startState.lon, startState.lat])
                .addTo(this.map);

            // 後方注視点マーカー (紫ドット)
            const bwdEl = document.createElement('div');
            bwdEl.className = 'target-marker bwd-marker';
            bwdEl.innerHTML = '<div class="target-dot" title="後方注視点"></div>';
            this.bwdMarker = new maplibregl.Marker({ element: bwdEl })
                .setLngLat([startState.lon, startState.lat])
                .addTo(this.map);

            if (this.pendingCourse) {
                this.setCourse(this.pendingCourse, this.pendingState);
                this.pendingCourse = null;
            }

            // 追従モード（track）時はMapLibre既定のパン操作を無効化（スワイプでのカメラ操作を優先）
            if (this.cameraMode === 'track') {
                this.map.dragPan.disable();
                this.map.dragRotate.disable();
            }

            this.map.on('rotate', () => {
                this.onCameraParamChange?.({ bearing: this.map.getBearing() });
            });
        });
    }

    getCameraPadding() {
        return { left: 0, top: Math.round(window.innerHeight * 0.35), right: 0, bottom: 0 };
    }

    setCourse(course, initialState) {
        this.currentCamBearing = null;
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

    setMarkerVisibility({ fwd, bwd }) {
        if (typeof fwd === 'boolean') this.showFwdMarker = fwd;
        if (typeof bwd === 'boolean') this.showBwdMarker = bwd;
        if (this.lastState) {
            if (this.fwdMarker) this.fwdMarker.getElement().style.display = this.showFwdMarker && this.lastState.fwdPoint ? 'flex' : 'none';
            if (this.bwdMarker) this.bwdMarker.getElement().style.display = this.showBwdMarker && this.lastState.bwdPoint ? 'flex' : 'none';
        }
    }

    updateRiderAndCamera(state, duration = 0, isMoving = false) {
        this.lastState = state;
        this.riderMarker?.setLngLat([state.lon, state.lat]);

        // 注視点マーカー更新 (前方: 赤, 後方: 紫)
        if (state.fwdPoint && this.fwdMarker) {
            this.fwdMarker.setLngLat([state.fwdPoint.lon, state.fwdPoint.lat]);
            this.fwdMarker.getElement().style.display = this.showFwdMarker ? 'flex' : 'none';
        } else if (this.fwdMarker) {
            this.fwdMarker.getElement().style.display = 'none';
        }

        if (state.bwdPoint && this.bwdMarker) {
            this.bwdMarker.setLngLat([state.bwdPoint.lon, state.bwdPoint.lat]);
            this.bwdMarker.getElement().style.display = this.showBwdMarker ? 'flex' : 'none';
        } else if (this.bwdMarker) {
            this.bwdMarker.getElement().style.display = 'none';
        }

        if (!this.isModeTransitioning && this.cameraMode !== 'free') {
            this.applyCameraTarget(state, duration, isMoving);
        }
    }

    setCameraMode(mode, currentState) {
        this.cameraMode = mode;
        if (this.map) {
            if (mode === 'free') {
                this.map.dragPan.enable();
                this.map.dragRotate.enable();
            } else {
                this.map.dragPan.disable();
                this.map.dragRotate.disable();
            }
        }
        if (mode !== 'free' && currentState) {
            this.currentCamBearing = null;
            this.isModeTransitioning = true;
            this.applyCameraTarget(currentState, 2000);
            setTimeout(() => { this.isModeTransitioning = false; }, 2000);
        }
    }

    setSmoothing(val) {
        this.smoothStrength = Math.max(0, Math.min(10, Number(val) || 0));
    }

    /**
     * メイン画面スワイプによるカメラアングル（横）＆ピッチ（縦）調整
     */
    setupMainScreenSwipe() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        let isDragging = false;
        let startX = 0, startY = 0;
        let startOrbit = 0, startPitch = 0;

        container.addEventListener('pointerdown', (e) => {
            if (this.cameraMode !== 'track') return;
            if (e.target.closest('#top-bar, #hud-metrics, #bottom-bar, .floating-cam-dialog, .floating-settings-dialog')) return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startOrbit = this.orbitAngleOffset;
            startPitch = this.cameraParams.pitch;
            container.setPointerCapture?.(e.pointerId);
        });

        container.addEventListener('pointermove', (e) => {
            if (!isDragging || this.cameraMode !== 'track') return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            // 横スワイプ: アングル調整 (-180° 〜 +180°)
            const nextOrbit = Math.max(-180, Math.min(180, Math.round(startOrbit + dx * 0.45)));
            // 縦スワイプ: ピッチ調整 (20° 〜 75°)
            const nextPitch = Math.max(20, Math.min(75, Math.round(startPitch - dy * 0.25)));

            this.orbitAngleOffset = nextOrbit;
            this.cameraParams.pitch = nextPitch;
            this.onCameraParamChange?.({ orbitAngleOffset: nextOrbit, pitch: nextPitch });

            if (this.lastState) {
                this.applyCameraTarget(this.lastState, 0);
            }
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

    setCameraParams({ pitch, zoom, orbitAngleOffset }, currentState) {
        if (typeof pitch === 'number') this.cameraParams.pitch = pitch;
        if (typeof zoom === 'number') this.cameraParams.zoom = zoom;
        if (typeof orbitAngleOffset === 'number') this.orbitAngleOffset = orbitAngleOffset;
        if (this.cameraMode !== 'free' && currentState) this.applyCameraTarget(currentState, 0);
    }

    resize(currentState) {
        if (!this.map) return;
        this.map.resize();
        if (this.cameraMode !== 'free' && currentState) this.applyCameraTarget(currentState, 0);
    }

    applyCameraTarget(state, duration = 0, isMoving = false) {
        if (!this.map || this.cameraMode === 'free' || !state) return;

        let targetPitch = this.cameraParams.pitch;
        const targetBearing = (state.bearing - this.orbitAngleOffset + 360) % 360;

        // スムージング度合い0（無効時）、初回ロード時、アニメーション指定時、または停止中（手動操作時）は即座に目標方向へ向く
        if (this.smoothStrength === 0 || this.currentCamBearing === null || duration > 0 || !isMoving) {
            this.currentCamBearing = targetBearing;
        } else {
            // 走行中スムージング: 目標との角度差 (-180°〜+180°) に対しスムージング度合い (1〜10) に応じた速度で追従
            // smoothStrength = 5 を標準基準 (係数 0.08, 上限 1.5°/frame) とする
            const diff = ((targetBearing - this.currentCamBearing + 540) % 360) - 180;
            const factor = 0.4 / (1 + this.smoothStrength * 0.8);
            const maxStep = 7.5 / (1 + this.smoothStrength * 0.8);
            const step = Math.max(-maxStep, Math.min(maxStep, diff * factor));
            this.currentCamBearing = (this.currentCamBearing + step + 360) % 360;
        }

        if (this.map.queryTerrainElevation) {
            const rad = (this.currentCamBearing + 180) * (Math.PI / 180);
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
            bearing: this.currentCamBearing,
            zoom: this.cameraParams.zoom,
            padding: this.getCameraPadding(),
            duration,
            essential: true
        };

        if (duration > 0) this.map.easeTo(cameraOptions);
        else this.map.jumpTo(cameraOptions);

        this.onCameraParamChange?.({ bearing: this.currentCamBearing });
    }
}
