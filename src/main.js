import { GeoCourseManager, GPXParser, DEFAULT_LAKE_ROUTE } from './course.js';

class App {
    constructor() {
        this.course = new GeoCourseManager(DEFAULT_LAKE_ROUTE, '本栖湖レイクサイド (サンプル)');
        this.currentProgress = 0.0;
        this.cameraMode = 'chase'; // 'chase' | 'drone' | 'free'
        this.isPlaying = false;
        this.speedKmh = 25; // 時速 (km/h)
        this.isModeTransitioning = false;
        this.lastFrameTime = 0;

        // 滑らかな角度補間（Lerp）用の現在カメラBearing
        this.currentCamBearing = null;
        this.aerialOrbitOffset = 35; // Aerialモードでのユーザー調整角度 (-180°〜+180°)

        // カメラパラメータ（Chase / Drone）
        this.cameraParams = {
            chase: { pitch: 68, zoom: 16.5 },
            drone: { pitch: 48, zoom: 15.0 }
        };

        this.initUI();
        this.initElevationProfile();
        this.initMap();
        this.setupEvents();
        this.setupGPXImporter();
    }

    getCameraOffset() {
        const panelWidth = 240;
        const screenWidth = window.innerWidth;
        if (screenWidth > 600) {
            return [panelWidth / 2, 0];
        }
        return [0, 0];
    }

    initMap() {
        const startState = this.course.getStateAtProgress(0.0);

        this.map = new maplibregl.Map({
            container: 'map',
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
            zoom: 16.5,
            pitch: 68,
            bearing: startState.bearing,
            maxPitch: 75
        });

        this.map.on('load', () => {
            this.map.setTerrain({
                source: 'terrain-dem',
                exaggeration: 1.15
            });

            this.updateMapCourseLayers();

            const el = document.createElement('div');
            el.className = 'rider-marker';
            el.innerHTML = `
                <div class="rider-beacon"></div>
                <div class="rider-arrow">▲</div>
            `;
            this.riderMarker = new maplibregl.Marker({ element: el })
                .setLngLat([startState.lon, startState.lat])
                .addTo(this.map);

            this.updateState(0.0);
            this.animate = this.animate.bind(this);
            requestAnimationFrame(this.animate);
        });
    }

    updateMapCourseLayers() {
        const coordinates = this.course.toGeoJSONCoordinates();
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
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
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
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 4
                }
            });
        }
    }

    initElevationProfile() {
        this.chartCanvas = document.getElementById('elevation-canvas');
        this.chartCtx = this.chartCanvas.getContext('2d');
        this.drawElevationChart();
    }

    drawElevationChart() {
        const ctx = this.chartCtx;
        const w = this.chartCanvas.width;
        const h = this.chartCanvas.height;

        ctx.clearRect(0, 0, w, h);

        const samples = 150;
        const elevations = [];
        let minAlt = Infinity, maxAlt = -Infinity;

        for (let i = 0; i <= samples; i++) {
            const u = i / samples;
            const state = this.course.getStateAtProgress(u);
            elevations.push(state.alt);
            if (state.alt < minAlt) minAlt = state.alt;
            if (state.alt > maxAlt) maxAlt = state.alt;
        }

        const altSpan = Math.max(maxAlt - minAlt, 10);
        const padY = 8;
        const getY = (alt) => h - padY - ((alt - minAlt) / altSpan) * (h - padY * 2);

        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(0, 240, 255, 0.45)');
        gradient.addColorStop(1, 'rgba(0, 240, 255, 0.05)');

        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i <= samples; i++) {
            const x = (i / samples) * w;
            const y = getY(elevations[i]);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i <= samples; i++) {
            const x = (i / samples) * w;
            const y = getY(elevations[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.stroke();

        const riderX = this.currentProgress * w;
        const riderState = this.course.getStateAtProgress(this.currentProgress);
        const riderY = getY(riderState.alt);

        ctx.beginPath();
        ctx.arc(riderX, riderY, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    initUI() {
        this.progressSlider = document.getElementById('progress-slider');
        this.progressInput = document.getElementById('progress-input');
        this.btnPlay = document.getElementById('btn-play');
        this.btnReset = document.getElementById('btn-reset');
        
        this.camChaseBtn = document.getElementById('cam-chase');
        this.camDroneBtn = document.getElementById('cam-drone');
        this.camFreeBtn = document.getElementById('cam-free');

        this.elDistance = document.getElementById('val-distance');
        this.elTotalDist = document.getElementById('val-total-distance');
        this.elAltitude = document.getElementById('val-altitude');
        this.elSlope = document.getElementById('val-slope');
        this.elSlopeWrap = document.getElementById('val-slope-wrap');
        this.elCoords = document.getElementById('val-coords');
        this.elActiveCourseName = document.getElementById('active-course-name');
        this.elProfileChartTitle = document.getElementById('profile-chart-title');

        this.speedSlider = document.getElementById('speed-slider');
        this.speedVal = document.getElementById('speed-val');

        this.camPitchSlider = document.getElementById('cam-pitch-slider');
        this.camPitchVal = document.getElementById('cam-pitch-val');
        this.camZoomSlider = document.getElementById('cam-zoom-slider');
        this.camZoomVal = document.getElementById('cam-zoom-val');
        this.camAdjustBox = document.getElementById('camera-adjust-box');

        this.aerialOrbitGroup = document.getElementById('aerial-orbit-group');
        this.camOrbitSlider = document.getElementById('cam-orbit-slider');
        this.camOrbitVal = document.getElementById('cam-orbit-val');

        this.updateTotalDistanceUI();
    }

    updateTotalDistanceUI() {
        const totalKm = (this.course.totalDistance / 1000).toFixed(2);
        this.elTotalDist.textContent = `/ ${totalKm} km`;
        if (this.elActiveCourseName) {
            this.elActiveCourseName.textContent = this.course.name;
        }
        if (this.elProfileChartTitle) {
            this.elProfileChartTitle.textContent = `${this.course.name} 標高プロファイル`;
        }
    }

    setupGPXImporter() {
        const dropZone = document.getElementById('drop-zone');
        const gpxSection = dropZone ? dropZone.closest('.gpx-section') : null;
        const fileInput = document.getElementById('gpx-file-input');
        const btnBrowse = document.getElementById('btn-browse');

        if (!dropZone || !fileInput) return;

        btnBrowse.addEventListener('click', (e) => {
            e.stopPropagation();
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this.loadGPXFile(file);
        });

        ['dragenter', 'dragover'].forEach(name => {
            gpxSection.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                gpxSection.classList.add('dragover');
            });
        });

        ['dragleave', 'drop'].forEach(name => {
            gpxSection.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                gpxSection.classList.remove('dragover');
            });
        });

        gpxSection.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const file = dt.files[0];
            if (file) {
                if (file.name.toLowerCase().endsWith('.gpx')) {
                    this.loadGPXFile(file);
                } else {
                    alert('.gpx 拡張子のファイルを選択してください。');
                }
            }
        });
    }

    loadGPXFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const gpxText = e.target.result;
                const { courseName, waypoints } = GPXParser.parse(gpxText);
                const finalName = courseName !== 'カスタムコース' ? courseName : file.name.replace(/\.gpx$/i, '');
                
                this.course = new GeoCourseManager(waypoints, finalName);
                this.updateTotalDistanceUI();

                this.isPlaying = false;
                this.btnPlay.textContent = '再生 (Auto Fly)';
                this.btnPlay.classList.remove('running');
                this.currentProgress = 0.0;
                this.currentCamBearing = null;

                this.updateMapCourseLayers();
                this.drawElevationChart();

                this.updateState(0.0);
                this.applyCameraTarget(1500);

                console.log(`GPX Loaded: ${finalName} (${waypoints.length} points)`);
            } catch (err) {
                console.error(err);
                alert(`GPX読み込みエラー: ${err.message}`);
            }
        };
        reader.readAsText(file);
    }

    setupEvents() {
        this.progressSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) / 100;
            this.updateState(val);
        });

        this.progressInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 0;
            val = Math.max(0, Math.min(100, val)) / 100;
            this.updateState(val);
        });

        this.btnPlay.addEventListener('click', () => {
            this.isPlaying = !this.isPlaying;
            this.btnPlay.textContent = this.isPlaying ? '停止 (Pause)' : '再生 (Auto Fly)';
            this.btnPlay.classList.toggle('running', this.isPlaying);
        });

        this.btnReset.addEventListener('click', () => {
            this.isPlaying = false;
            this.btnPlay.textContent = '再生 (Auto Fly)';
            this.btnPlay.classList.remove('running');
            this.updateState(0.0);
        });

        this.speedSlider.addEventListener('input', (e) => {
            this.speedKmh = parseFloat(e.target.value);
            this.speedVal.textContent = `${Math.round(this.speedKmh)} km/h`;
        });

        this.camPitchSlider.addEventListener('input', (e) => {
            const pitch = parseFloat(e.target.value);
            this.camPitchVal.textContent = `${Math.round(pitch)}°`;
            if (this.cameraMode !== 'free') {
                this.cameraParams[this.cameraMode].pitch = pitch;
                this.applyCameraTarget(0);
            }
        });

        this.camZoomSlider.addEventListener('input', (e) => {
            const zoom = parseFloat(e.target.value);
            this.camZoomVal.textContent = zoom.toFixed(1);
            if (this.cameraMode !== 'free') {
                this.cameraParams[this.cameraMode].zoom = zoom;
                this.applyCameraTarget(0);
            }
        });

        // Aerial 相対視点アングルスライダー
        this.camOrbitSlider.addEventListener('input', (e) => {
            this.aerialOrbitOffset = parseFloat(e.target.value);
            const sign = this.aerialOrbitOffset > 0 ? '+' : '';
            this.camOrbitVal.textContent = `${sign}${Math.round(this.aerialOrbitOffset)}°`;
            if (this.cameraMode === 'drone') {
                this.applyCameraTarget(0);
            }
        });

        const syncCameraSlidersToMode = (mode) => {
            if (mode === 'free') {
                if (this.camAdjustBox) this.camAdjustBox.style.opacity = '0.35';
                if (this.aerialOrbitGroup) this.aerialOrbitGroup.style.display = 'none';
                return;
            }
            if (this.camAdjustBox) this.camAdjustBox.style.opacity = '1';
            const params = this.cameraParams[mode];
            this.camPitchSlider.value = params.pitch;
            this.camPitchVal.textContent = `${Math.round(params.pitch)}°`;
            this.camZoomSlider.value = params.zoom;
            this.camZoomVal.textContent = params.zoom.toFixed(1);

            // Aerial モード時のみ視点方向（Orbit）スライダーを表示
            if (this.aerialOrbitGroup) {
                this.aerialOrbitGroup.style.display = (mode === 'drone') ? 'block' : 'none';
            }
        };

        const setCamMode = (mode) => {
            this.cameraMode = mode;
            this.camChaseBtn.classList.toggle('active', mode === 'chase');
            this.camDroneBtn.classList.toggle('active', mode === 'drone');
            this.camFreeBtn.classList.toggle('active', mode === 'free');
            syncCameraSlidersToMode(mode);

            if (mode !== 'free') {
                this.isModeTransitioning = true;
                this.applyCameraTarget(2000);
                setTimeout(() => {
                    this.isModeTransitioning = false;
                }, 2000);
            }
        };

        this.camChaseBtn.addEventListener('click', () => setCamMode('chase'));
        this.camDroneBtn.addEventListener('click', () => setCamMode('drone'));
        this.camFreeBtn.addEventListener('click', () => setCamMode('free'));

        this.chartCanvas.addEventListener('click', (e) => {
            const rect = this.chartCanvas.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const progress = Math.max(0, Math.min(1, clickX / rect.width));
            this.updateState(progress);
        });

        window.addEventListener('resize', () => {
            this.map.resize();
            if (this.cameraMode !== 'free') {
                this.applyCameraTarget(0);
            }
        });
    }

    updateState(progress) {
        this.currentProgress = ((progress % 1.0) + 1.0) % 1.0;
        const state = this.course.getStateAtProgress(this.currentProgress);

        if (this.riderMarker) {
            this.riderMarker.setLngLat([state.lon, state.lat]);
            const arrow = this.riderMarker.getElement().querySelector('.rider-arrow');
            if (arrow) {
                arrow.style.transform = `rotate(${state.bearing}deg)`;
            }
        }

        const pct100 = (this.currentProgress * 100).toFixed(1);
        if (document.activeElement !== this.progressInput) {
            this.progressInput.value = pct100;
        }
        this.progressSlider.value = (this.currentProgress * 100).toFixed(2);

        this.elDistance.textContent = (state.distance / 1000).toFixed(2);
        this.elAltitude.textContent = state.alt.toFixed(1);

        const sign = state.slope >= 0 ? '+' : '';
        this.elSlope.textContent = `${sign}${state.slope.toFixed(1)}`;
        if (state.slope > 7) {
            this.elSlopeWrap.style.color = 'var(--climb-color)';
        } else if (state.slope < 0) {
            this.elSlopeWrap.style.color = 'var(--descent-color)';
        } else {
            this.elSlopeWrap.style.color = 'var(--flat-color)';
        }

        this.elCoords.textContent = `${state.lon.toFixed(4)}, ${state.lat.toFixed(4)}`;

        this.drawElevationChart();

        if (!this.isModeTransitioning && this.cameraMode !== 'free') {
            this.applyCameraTarget(0);
        }
    }

    static lerpAngle(fromAngle, toAngle, t) {
        let diff = (toAngle - fromAngle) % 360;
        if (diff < -180) diff += 360;
        if (diff > 180) diff -= 360;
        return (fromAngle + diff * t + 360) % 360;
    }

    /**
     * カメラ位置・山との衝突判定
     * - 注視点（Center）は常にライダーの位置をキープ
     * - Aerial時はライダーの進行方向 + aerialOrbitOffset の角度から撮影
     * - カメラ位置の標高が山の地表面に接近（衝突）しそうになった場合、Pitch（仰角）を自動で引き上げて激突を防止
     */
    applyCameraTarget(duration = 0) {
        if (!this.map || this.cameraMode === 'free') return;

        const state = this.course.getStateAtProgress(this.currentProgress);
        const offset = this.getCameraOffset();

        const currentParams = this.cameraParams[this.cameraMode] || { pitch: 68, zoom: 16.5 };
        let targetPitch = currentParams.pitch;
        let targetZoom = currentParams.zoom;
        let targetBearing = state.bearing;

        if (this.cameraMode === 'drone') {
            // Aerial: 注視点はライダーのまま、指定されたカメラアングルから追従
            targetBearing = (state.bearing + this.aerialOrbitOffset + 360) % 360;
        }

        // カメラ角度の線形補間（滑らかな首振り）
        if (this.currentCamBearing === null || duration > 0) {
            this.currentCamBearing = targetBearing;
        } else {
            this.currentCamBearing = App.lerpAngle(this.currentCamBearing, targetBearing, 0.08);
        }

        // --- 山岳衝突防止ガード（Collision Avoidance） ---
        // カメラはライダーの後方上空に位置するため、背後に迫る山肌の標高をDEMからサンプリング
        // 接近している場合はピッチを安全角度（最大60°以下）に制限して地形への突入を防止
        if (this.map.queryTerrainElevation) {
            const riderAlt = state.alt;
            // カメラの概算バックワードオフセット（約60m後方）
            const rad = (this.currentCamBearing + 180) * (Math.PI / 180);
            const distMeters = 60;
            const camLon = state.lon + (distMeters * Math.sin(rad)) / (111320 * Math.cos(state.lat * Math.PI / 180));
            const camLat = state.lat + (distMeters * Math.cos(rad)) / 110574;
            const terrainAlt = this.map.queryTerrainElevation([camLon, camLat]);

            if (terrainAlt !== null && terrainAlt > riderAlt + 15) {
                // 背後に山肌が盛り上がっている場合はアングルを自動チルトアップ（衝突防止）
                targetPitch = Math.min(targetPitch, 45);
            }
        }

        const cameraOptions = {
            center: [state.lon, state.lat],
            pitch: targetPitch,
            bearing: this.currentCamBearing,
            zoom: targetZoom,
            offset: offset,
            duration: duration,
            essential: true
        };

        if (duration > 0) {
            this.map.easeTo(cameraOptions);
        } else {
            this.map.jumpTo(cameraOptions);
        }
    }

    animate(timestamp) {
        requestAnimationFrame(this.animate);

        if (this.isPlaying) {
            if (!this.lastFrameTime) this.lastFrameTime = timestamp;
            const deltaSeconds = Math.min((timestamp - this.lastFrameTime) / 1000, 0.1);
            this.lastFrameTime = timestamp;

            const metersPerSecond = (this.speedKmh * 1000) / 3600;
            const distanceMoved = metersPerSecond * deltaSeconds;
            const progressDelta = this.course.totalDistance > 0 ? (distanceMoved / this.course.totalDistance) : 0;

            const nextProgress = (this.currentProgress + progressDelta) % 1.0;
            this.updateState(nextProgress);
        } else {
            this.lastFrameTime = 0;
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new App();
});
