import { GeoCourseManager, YABITSU_PASS_ROUTE } from './course.js';

class App {
    constructor() {
        this.course = new GeoCourseManager(YABITSU_PASS_ROUTE);
        this.currentProgress = 0.0;
        this.cameraMode = 'chase'; // 'chase' | 'drone' | 'free'
        this.isPlaying = false;
        this.playSpeed = 0.0007; // progress step per frame

        this.initUI();
        this.initElevationProfile();
        this.initMap();
        this.setupEvents();
    }

    initMap() {
        // MapLibre GL JS with ESRI World Imagery (High-res Satellite) + AWS Open Terrain RGB (3D Dem)
        // Completely Free & No API Key Required
        this.map = new maplibregl.Map({
            container: 'map',
            style: {
                version: 8,
                sources: {
                    // 1. 高精細 衛星写真タイル (ESRI World Imagery - Free & No Key)
                    'satellite': {
                        type: 'raster',
                        tiles: [
                            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                        ],
                        tileSize: 256,
                        attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics'
                    },
                    // 2. 標高 DEM 3D地形 (AWS Open Terrain RGB - Free & Global 3D)
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
                    'sky-color': '#199EF3',
                    'sky-horizon-blend': 0.5,
                    'horizon-color': '#ffffff',
                    'horizon-fog-blend': 0.5,
                    'fog-color': '#0000ff',
                    'fog-ground-blend': 0.5
                }
            },
            center: [139.2248, 35.3721],
            zoom: 14.5,
            pitch: 65,     // 傾斜角（3D地形が見えるアングル）
            bearing: 15,   // 方位角
            maxPitch: 85
        });

        // 3D地形（起伏）と陰影を追加
        this.map.on('load', () => {
            // Enable 3D Terrain
            this.map.setTerrain({
                source: 'terrain-dem',
                exaggeration: 1.25 // 起伏感を強調
            });

            // コース全体の3Dラインを追加
            const coordinates = this.course.toGeoJSONCoordinates();
            this.map.addSource('route', {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: coordinates
                    }
                }
            });

            // コースのグローライン（発光下地）
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
                    'line-opacity': 0.5,
                    'line-blur': 3
                }
            });

            // コースメインライン
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

            // ライダー（現在地）のカスタムDOMマーカー作成
            const el = document.createElement('div');
            el.className = 'rider-marker';
            el.innerHTML = `
                <div class="rider-beacon"></div>
                <div class="rider-arrow">▲</div>
            `;
            this.riderMarker = new maplibregl.Marker({ element: el })
                .setLngLat([coordinates[0][0], coordinates[0][1]])
                .addTo(this.map);

            this.updateState(0.0);
            this.animate = this.animate.bind(this);
            requestAnimationFrame(this.animate);
        });
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

        // 背景グラデーション
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

        // コースライン
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

        // ライダーインジケータ
        const riderX = this.currentProgress * w;
        const riderState = this.course.getStateAtProgress(this.currentProgress);
        const riderY = getY(riderState.alt);

        ctx.beginPath();
        ctx.arc(riderX, riderY, 4.5, 0, Math.PI * 2);
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

        const totalKm = (this.course.totalDistance / 1000).toFixed(2);
        this.elTotalDist.textContent = `/ ${totalKm} km`;
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

        const setCamMode = (mode) => {
            this.cameraMode = mode;
            this.camChaseBtn.classList.toggle('active', mode === 'chase');
            this.camDroneBtn.classList.toggle('active', mode === 'drone');
            this.camFreeBtn.classList.toggle('active', mode === 'free');
            this.updateCamera();
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
    }

    updateState(progress) {
        this.currentProgress = ((progress % 1.0) + 1.0) % 1.0;
        const state = this.course.getStateAtProgress(this.currentProgress);

        // Update Rider Marker
        if (this.riderMarker) {
            this.riderMarker.setLngLat([state.lon, state.lat]);
            const arrow = this.riderMarker.getElement().querySelector('.rider-arrow');
            if (arrow) {
                arrow.style.transform = `rotate(${state.bearing}deg)`;
            }
        }

        // Update UI
        const pct100 = (this.currentProgress * 100).toFixed(1);
        if (document.activeElement !== this.progressInput) {
            this.progressInput.value = pct100;
        }
        this.progressSlider.value = (this.currentProgress * 100).toFixed(2);

        this.elDistance.textContent = (state.distance / 1000).toFixed(2);
        this.elAltitude.textContent = state.alt.toFixed(1);

        const sign = state.slope >= 0 ? '+' : '';
        this.elSlope.textContent = `${sign}${state.slope.toFixed(1)}`;
        if (state.slope > 5) {
            this.elSlopeWrap.style.color = 'var(--climb-color)';
        } else if (state.slope < -2) {
            this.elSlopeWrap.style.color = 'var(--descent-color)';
        } else {
            this.elSlopeWrap.style.color = 'var(--flat-color)';
        }

        this.elCoords.textContent = `${state.lon.toFixed(4)}, ${state.lat.toFixed(4)}`;

        // Chart dot
        this.drawElevationChart();

        // Camera sync
        this.updateCamera();
    }

    updateCamera() {
        if (!this.map || this.cameraMode === 'free') return;

        const state = this.course.getStateAtProgress(this.currentProgress);

        if (this.cameraMode === 'chase') {
            // ライダー後方からのダイナミック追従
            this.map.easeTo({
                center: [state.lon, state.lat],
                pitch: 75,
                bearing: state.bearing,
                zoom: 15.8,
                duration: 100
            });
        } else if (this.cameraMode === 'drone') {
            // 上空からのドローン空撮視点
            this.map.easeTo({
                center: [state.lon, state.lat],
                pitch: 45,
                bearing: (state.bearing + 40) % 360,
                zoom: 14.5,
                duration: 100
            });
        }
    }

    animate() {
        requestAnimationFrame(this.animate);

        if (this.isPlaying) {
            const nextProgress = (this.currentProgress + this.playSpeed) % 1.0;
            this.updateState(nextProgress);
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new App();
});
