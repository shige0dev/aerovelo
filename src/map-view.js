/**
 * 3D Terrain Map & Chase Camera Controller (MapLibre GL JS)
 * Handles satellite/terrain rendering, route line layers, rider marker, and camera tracking.
 */

export class MapViewController {
    constructor(containerId = 'map', initialState = { lon: 138.583, lat: 35.474, bearing: 0 }) {
        this.containerId = containerId;
        this.cameraMode = 'track'; // 'track' | 'free'
        this.isModeTransitioning = false;

        this.currentCamBearing = null;
        this.orbitAngleOffset = 0; // -180° ~ +180°
        this.cameraParams = {
            pitch: 68,
            zoom: 16.5
        };

        this.riderMarker = null;
        this.initMap(initialState);
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
                        tiles: [
                            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                        ],
                        tileSize: 256,
                        attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics'
                    },
                    'terrain-dem': {
                        type: 'raster-dem',
                        tiles: [
                            'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
                        ],
                        encoding: 'terrarium',
                        tileSize: 256,
                        maxzoom: 14
                    }
                },
                layers: [
                    {
                        id: 'satellite-layer',
                        type: 'raster',
                        source: 'satellite',
                        minzoom: 0,
                        maxzoom: 22
                    }
                ],
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
            this.map.setTerrain({
                source: 'terrain-dem',
                exaggeration: 1.15
            });

            const el = document.createElement('div');
            el.className = 'rider-marker';
            el.innerHTML = `
                <div class="rider-beacon"></div>
                <div class="rider-dot"></div>
            `;
            this.riderMarker = new maplibregl.Marker({ element: el })
                .setLngLat([startState.lon, startState.lat])
                .addTo(this.map);

            if (this.pendingCourse) {
                this.setCourse(this.pendingCourse, this.pendingState);
                this.pendingCourse = null;
            }
        });
    }

    /**
     * MapLibre の padding を用いて注視点の位置を決定
     * - left: PC画面では左側UIパネルを避ける
     * - top: 画面高さの約35%の余白を設けることで、ライダーが画面下部に配置される
     */
    getCameraPadding() {
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        return {
            left: (screenWidth > 600) ? 240 : 0,
            top: Math.round(screenHeight * 0.35),
            right: 0,
            bottom: 0
        };
    }

    setCourse(course, initialState) {
        this.currentCamBearing = null;
        if (!this.map) return;

        if (!this.map.isStyleLoaded()) {
            this.pendingCourse = course;
            this.pendingState = initialState;
            return;
        }

        const coordinates = course.toGeoJSONCoordinates();
        const geojsonData = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: coordinates
            }
        };

        if (this.map.getSource('route')) {
            this.map.getSource('route').setData(geojsonData);
        } else {
            this.map.addSource('route', {
                type: 'geojson',
                data: geojsonData
            });

            this.map.addLayer({
                id: 'route-glow',
                type: 'line',
                source: 'route',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#00f0ff',
                    'line-width': 8,
                    'line-opacity': 0.6,
                    'line-blur': 3
                }
            });

            this.map.addLayer({
                id: 'route-line',
                type: 'line',
                source: 'route',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 4
                }
            });
        }

        if (initialState) {
            this.updateRiderAndCamera(initialState, 1500);
        }
    }

    updateRiderAndCamera(state, duration = 0) {
        if (this.riderMarker) {
            this.riderMarker.setLngLat([state.lon, state.lat]);
        }
        if (!this.isModeTransitioning && this.cameraMode !== 'free') {
            this.applyCameraTarget(state, duration);
        }
    }

    setCameraMode(mode, currentState) {
        this.cameraMode = mode;
        if (mode !== 'free' && currentState) {
            this.isModeTransitioning = true;
            this.applyCameraTarget(currentState, 2000);
            setTimeout(() => {
                this.isModeTransitioning = false;
            }, 2000);
        }
    }

    setCameraParams({ pitch, zoom, orbitAngleOffset }, currentState) {
        if (typeof pitch === 'number') this.cameraParams.pitch = pitch;
        if (typeof zoom === 'number') this.cameraParams.zoom = zoom;
        if (typeof orbitAngleOffset === 'number') this.orbitAngleOffset = orbitAngleOffset;

        if (this.cameraMode !== 'free' && currentState) {
            this.applyCameraTarget(currentState, 0);
        }
    }

    resize(currentState) {
        if (!this.map) return;
        this.map.resize();
        if (this.cameraMode !== 'free' && currentState) {
            this.applyCameraTarget(currentState, 0);
        }
    }

    static lerpAngle(fromAngle, toAngle, t) {
        let diff = (toAngle - fromAngle) % 360;
        if (diff < -180) diff += 360;
        if (diff > 180) diff -= 360;
        return (fromAngle + diff * t + 360) % 360;
    }

    applyCameraTarget(state, duration = 0) {
        if (!this.map || this.cameraMode === 'free' || !state) return;

        const padding = this.getCameraPadding();
        let targetPitch = this.cameraParams.pitch;
        const targetZoom = this.cameraParams.zoom;

        const targetBearing = (state.bearing - this.orbitAngleOffset + 360) % 360;

        if (this.currentCamBearing === null || duration > 0) {
            this.currentCamBearing = targetBearing;
        } else {
            this.currentCamBearing = MapViewController.lerpAngle(this.currentCamBearing, targetBearing, 0.08);
        }

        if (this.map.queryTerrainElevation) {
            const riderAlt = state.alt;
            const rad = (this.currentCamBearing + 180) * (Math.PI / 180);
            const distMeters = 50;
            const camLon = state.lon + (distMeters * Math.sin(rad)) / (111320 * Math.cos(state.lat * Math.PI / 180));
            const camLat = state.lat + (distMeters * Math.cos(rad)) / 110574;
            const terrainAlt = this.map.queryTerrainElevation([camLon, camLat]);

            if (terrainAlt !== null && terrainAlt > riderAlt + 12) {
                targetPitch = Math.min(targetPitch, 45);
            }
        }

        const cameraOptions = {
            center: [state.lon, state.lat],
            pitch: targetPitch,
            bearing: this.currentCamBearing,
            zoom: targetZoom,
            padding: padding,
            duration: duration,
            essential: true
        };

        if (duration > 0) {
            this.map.easeTo(cameraOptions);
        } else {
            this.map.jumpTo(cameraOptions);
        }
    }
}
