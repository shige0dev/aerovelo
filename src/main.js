import { GeoCourseManager, YABITSU_PASS_ROUTE } from './course.js';

class App {
    constructor() {
        this.course = new GeoCourseManager(YABITSU_PASS_ROUTE);
        this.currentProgress = 0.0;
        this.cameraMode = 'chase'; // 'chase' | 'drone' | 'free'
        this.isPlaying = false;
        this.playSpeed = 0.0006; // progress step per frame
        this.isModeTransitioning = false;

        this.initUI();
        this.initElevationProfile();
        this.initMap();
        this.setupEvents();
    }

    // 左パネル(380px)を避けて、ユーザーの目線の中央（右側エリアの中心）にライダーを置くピクセルオフセット
    getCameraOffset() {
        const panelWidth = 380;
        const screenWidth = window.innerWidth;
        if (screenWidth > 800) {
            // パネルの半分だけ右にシフトしてライダーを空き領域のど真ん中に配置
            return [panelWidth / 2, 0];
        }
        return [0, 0];
    }

    initMap() {
        const startState = this.course.getStateAtProgress(0.0);

        this.map = new maplibregl.Map({
            container: 'map',
            style: {
                version: 8,
                sources: {
                    // 高精細 衛星写真タイル (ESRI World Imagery)
                    'satellite': {
                        type: 'raster',
                        tiles: [
                            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                        ],
                        tileSize: 256,
                        attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics'
                    },
                    // 標高 DEM 3D地形 (AWS Open Terrain RGB)
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
            zoom: 16.0,
            pitch: 75,
            bearing: startState.bearing,
            maxPitch: 85
        });

        this.map.on('load', () => {
            // 3D 地形有効化
            this.map.setTerrain({
                source: 'terrain-dem',
                exaggeration: 1.25
            });

            // コース全体の高精度3Dライン
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

            // コース発光ライン
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

            // コース実線
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

            // ライダーマーカー
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

        const samples = 200;
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

        // グラデーション塗りつぶし
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

        // ライダー現在地インジケータ
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

        // カメラモード切り替え（2秒間のスムーズ飛行）
        const setCamMode = (mode) => {
            this.cameraMode = mode;
            this.camChaseBtn.classList.toggle('active', mode === 'chase');
            this.camDroneBtn.classList.toggle('active', mode === 'drone');
            this.camFreeBtn.classList.toggle('active', mode === 'free');

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
            if (this.cameraMode !== 'free') {
                this.applyCameraTarget(0);
            }
        });
    }

    updateState(progress) {
        this.currentProgress = ((progress % 1.0) + 1.0) % 1.0;
        const state = this.course.getStateAtProgress(this.currentProgress);

        // ライダーマーカーの位置・方位角
        if (this.riderMarker) {
            this.riderMarker.setLngLat([state.lon, state.lat]);
            const arrow = this.riderMarker.getElement().querySelector('.rider-arrow');
            if (arrow) {
                arrow.style.transform = `rotate(${state.bearing}deg)`;
            }
        }

        // 数値・スライダー更新
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
        } else if (state.slope < -2) {
            this.elSlopeWrap.style.color = 'var(--descent-color)';
        } else {
            this.elSlopeWrap.style.color = 'var(--flat-color)';
        }

        this.elCoords.textContent = `${state.lon.toFixed(4)}, ${state.lat.toFixed(4)}`;

        // 標高チャートの現在地ポインタ更新
        this.drawElevationChart();

        // カメラ同期（モード切り替えアニメーション中以外）
        if (!this.isModeTransitioning && this.cameraMode !== 'free') {
            this.applyCameraTarget(0); // リアルタイム追従（即座にターゲット位置を固定）
        }
    }

    /**
     * カメラの視界設定
     * - chase: ライダー直後方・低高度・高い仰角で臨場感ある追従
     * - drone: 斜め上空・中高度・広角でコース全体と山並みを見渡す
     */
    applyCameraTarget(duration = 0) {
        if (!this.map || this.cameraMode === 'free') return;

        const state = this.course.getStateAtProgress(this.currentProgress);
        const offset = this.getCameraOffset();

        let targetPitch = 76;
        let targetBearing = state.bearing;
        let targetZoom = 16.2;

        if (this.cameraMode === 'drone') {
            // ドローン空撮: 斜め上空から見下ろし（Zoom 14.5, 仰角 48度, 方位は少し斜め前方）
            targetPitch = 48;
            targetBearing = (state.bearing + 35) % 360;
            targetZoom = 14.6;
        }

        const cameraOptions = {
            center: [state.lon, state.lat],
            pitch: targetPitch,
            bearing: targetBearing,
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
