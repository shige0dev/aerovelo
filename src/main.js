import { GeoCourseManager, GPXParser, DEFAULT_LAKE_ROUTE } from './course.js';
import { BleTrainerManager } from './ble.js';

class App {
    constructor() {
        this.course = new GeoCourseManager(DEFAULT_LAKE_ROUTE, '読み込み中...');
        this.currentProgress = 0.0;
        this.cameraMode = 'track'; // 'track' | 'free'
        this.isPlaying = false;
        this.speedKmh = 25; // 時速 (km/h)
        this.isModeTransitioning = false;
        this.lastFrameTime = 0;

        // Bluetooth Smart Trainer Manager
        this.bleManager = new BleTrainerManager();
        this.hasBleDistance = false;
        this.baseProgressAtBleStart = 0; // BLE接続時・リセット時の基準進捗率

        // TEST / 負荷キャリブレーション機能ステート
        this.testMode = 'course'; // 'course' | 'manual'
        this.manualSlope = 0.0; // 手動指定斜度 (-3% 〜 +7%)
        this.isLfoRunning = false;
        this.lfoPeriodSeconds = 20; // LFO 周期（秒）
        this.lfoStartTime = 0;
        this.lastTargetSlopeSent = 0.0; // 画面表示用・実際にトレーナーへ指示した最新斜度

        // 滑らかな角度補間（Lerp）用の現在カメラBearing
        this.currentCamBearing = null;
        this.orbitAngleOffset = 0; // スライダー値 (-180°〜+180°)

        // カメラパラメータ（Pitch / Zoom）
        this.cameraParams = {
            pitch: 68,
            zoom: 16.5
        };

        this.initUI();
        this.initElevationProfile();
        this.initMap();
        this.setupEvents();
        this.setupGPXImporter();

        // デフォルトで更新された Hiyoshi GPX を最優先自動ロード
        this.loadDefaultGPX('gpx/hiyoshi_12.5km_D738.gpx');
    }

    /**
     * MapLibre の padding を用いて注視点の位置を決定
     * - top を増やすことで、注視点（ライダー）が確実に画面の下方へ移動します
     * - left: 左側UIパネル(240px)を避ける
     * - top: 画面高さの約35%の余白を設けることで、ライダーが画面下部（下から約18〜20%）にピタリと配置されます
     */
    getCameraPadding() {
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;

        const padLeft = (screenWidth > 600) ? 240 : 0;
        const padTop = Math.round(screenHeight * 0.35); // 画面高さの35%下に押し下げ

        return {
            left: padLeft,
            top: padTop,
            right: 0,
            bottom: 0
        };
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
                <div class="rider-dot"></div>
            `;
            this.riderMarker = new maplibregl.Marker({ element: el })
                .setLngLat([startState.lon, startState.lat])
                .addTo(this.map);

            this.updateState(0.0);
            this.animate = this.animate.bind(this);
            requestAnimationFrame(this.animate);
        });
    }

    async loadDefaultGPX(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const gpxText = await res.text();
            const { courseName, waypoints } = GPXParser.parse(gpxText);
            const finalName = courseName !== 'カスタムコース' ? courseName : url.split('/').pop().replace(/\.gpx$/i, '');
            this.applyNewCourse(waypoints, finalName);
        } catch (err) {
            console.warn(`デフォルトGPX取得エラー (${url}):`, err);
        }
    }

    applyNewCourse(waypoints, name) {
        this.course = new GeoCourseManager(waypoints, name);
        this.updateTotalDistanceUI();

        this.isPlaying = false;
        this.btnPlay.textContent = '再生 (Auto Fly)';
        this.btnPlay.classList.remove('running');
        this.currentProgress = 0.0;
        this.currentCamBearing = null;

        const updateLayersAndCamera = () => {
            this.updateMapCourseLayers();
            this.drawElevationChart();
            this.updateState(0.0);
            this.applyCameraTarget(1500);
        };

        if (this.map) {
            if (this.map.isStyleLoaded()) {
                updateLayersAndCamera();
            } else {
                this.map.once('load', () => updateLayersAndCamera());
            }
        }
    }

    updateMapCourseLayers() {
        if (!this.map || !this.map.isStyleLoaded()) return;

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
        this.camFreeBtn = document.getElementById('cam-free');

        this.elDistance = document.getElementById('val-distance');
        this.elTotalDist = document.getElementById('val-total-distance');
        this.elAltitude = document.getElementById('val-altitude');
        this.elSlope = document.getElementById('val-slope');
        this.elSlopeWrap = document.getElementById('val-slope-wrap');
        this.elSlopeCard = this.elSlopeWrap ? this.elSlopeWrap.closest('.metric-card') : null;
        this.slopeCapBadge = document.getElementById('slope-cap-badge');
        this.elTrainerSlope = document.getElementById('val-trainer-slope');
        this.elCoords = document.getElementById('val-coords');
        this.elCourseNameDisplay = document.getElementById('course-name-display');
        this.presetSelect = document.getElementById('preset-select');

        this.speedSlider = document.getElementById('speed-slider');
        this.speedVal = document.getElementById('speed-val');

        this.camPitchSlider = document.getElementById('cam-pitch-slider');
        this.camPitchVal = document.getElementById('cam-pitch-val');
        this.camZoomSlider = document.getElementById('cam-zoom-slider');
        this.camZoomVal = document.getElementById('cam-zoom-val');
        this.camAdjustBox = document.getElementById('camera-adjust-box');

        this.camOrbitSlider = document.getElementById('cam-orbit-slider');
        this.camOrbitVal = document.getElementById('cam-orbit-val');

        // GSI 5m DEM 補正ボタン
        this.btnGsiDem = document.getElementById('btn-gsi-dem');
        this.gsiBtnText = document.getElementById('gsi-btn-text');

        // BLE UI Elements
        this.btnBleConnect = document.getElementById('btn-ble-connect');
        this.btnBleDisconnect = document.getElementById('btn-ble-disconnect');
        this.bleStatusText = document.getElementById('ble-status-text');
        this.bleIndicator = document.getElementById('ble-indicator');
        this.valPower = document.getElementById('val-power');
        this.valCadence = document.getElementById('val-cadence');

        // Fullscreen Button
        this.btnFullscreen = document.getElementById('btn-fullscreen');

        // Modal Triggers & Elements (統合設定モーダル ⚙️)
        this.btnModalSettings = document.getElementById('btn-modal-settings');
        this.modalSettings = document.getElementById('modal-settings');

        // TEST / キャリブレーション UI
        this.testModeCourseBtn = document.getElementById('test-mode-course');
        this.testModeManualBtn = document.getElementById('test-mode-manual');
        this.testControlsBox = document.getElementById('test-controls-box');
        this.testSlopeSlider = document.getElementById('test-slope-slider');
        this.testSlopeVal = document.getElementById('test-slope-val');
        this.btnPresetSlopes = document.querySelectorAll('.btn-preset-slope');
        this.btnLfoToggle = document.getElementById('btn-lfo-toggle');
        this.testLfoStatus = document.getElementById('test-lfo-status');
        this.lfoPeriodSelect = document.getElementById('lfo-period-select');

        this.updateTotalDistanceUI();
    }

    updateTotalDistanceUI() {
        const totalKm = (this.course.totalDistance / 1000).toFixed(2);
        this.elTotalDist.textContent = `/ ${totalKm} km`;
        if (this.elCourseNameDisplay) {
            const statusTag = this.course.isGsiCorrected ? ' [DEM5A]' : '';
            this.elCourseNameDisplay.textContent = `${this.course.name}${statusTag}`;
            this.elCourseNameDisplay.title = `${this.course.name}${statusTag} (${totalKm} km)`;
        }
        if (this.btnGsiDem) {
            const isJapan = this.course.isWithinJapan();
            this.btnGsiDem.style.display = isJapan ? 'flex' : 'none';
            if (this.course.isGsiCorrected) {
                this.btnGsiDem.classList.add('active');
                this.btnGsiDem.classList.remove('loading');
                this.gsiBtnText.textContent = '5mメッシュ補正済 (DEM5A)';
            } else {
                this.btnGsiDem.classList.remove('active', 'loading');
                this.gsiBtnText.textContent = '5mメッシュ標高で補正';
            }
        }
    }

    setupGPXImporter() {
        const dropZone = document.getElementById('drop-zone');
        const gpxSection = dropZone ? dropZone.closest('.gpx-section') : null;
        const fileInput = document.getElementById('gpx-file-input');
        const btnBrowse = document.getElementById('btn-browse');

        if (!dropZone || !fileInput) return;

        // GSI 5m DEM 補正ボタンイベント
        if (this.btnGsiDem) {
            this.btnGsiDem.addEventListener('click', async () => {
                if (this.course.isGsiCorrected || this.btnGsiDem.classList.contains('loading')) return;
                try {
                    this.btnGsiDem.classList.add('loading');
                    this.gsiBtnText.textContent = 'DEM取得中 0%...';
                    await this.course.recalculateWithGSI5m((pct) => {
                        this.gsiBtnText.textContent = `DEM取得中 ${pct}%...`;
                    });
                    this.updateTotalDistanceUI();
                    this.drawElevationChart();
                    this.updateState(this.currentProgress);
                } catch (err) {
                    console.error('GSI DEM error:', err);
                    alert(`5mメッシュ標高の取得に失敗しました: ${err.message}`);
                    this.updateTotalDistanceUI();
                }
            });
        }

        // プリセット切替プルダウン
        if (this.presetSelect) {
            this.presetSelect.addEventListener('change', (e) => {
                this.loadDefaultGPX(e.target.value);
            });
        }

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
                this.applyNewCourse(waypoints, finalName);
                console.log(`GPX Loaded: ${finalName} (${waypoints.length} points)`);
            } catch (err) {
                console.error(err);
                alert(`GPX読み込みエラー: ${err.message}`);
            }
        };
        reader.readAsText(file);
    }

    setupEvents() {
        // BLE イベントリスナー
        if (this.btnBleConnect) {
            this.btnBleConnect.addEventListener('click', async () => {
                if (this.bleManager.isConnected) return;
                try {
                    this.bleStatusText.textContent = 'ペアリング中...';
                    const res = await this.bleManager.connect();
                    this.btnBleConnect.classList.add('connected');
                    this.bleStatusText.textContent = `🟢 ${res.deviceName}`;
                    if (this.btnBleDisconnect) this.btnBleDisconnect.style.display = 'flex';
                } catch (err) {
                    console.warn('BLE connect cancelled or failed:', err);
                    this.btnBleConnect.classList.remove('connected');
                    this.bleStatusText.textContent = '⚡ スマートトレーナー接続';
                    if (this.btnBleDisconnect) this.btnBleDisconnect.style.display = 'none';
                    if (err.name !== 'NotFoundError') {
                        alert(`Bluetooth接続エラー: ${err.message}`);
                    }
                }
            });
        }

        if (this.btnBleDisconnect) {
            this.btnBleDisconnect.addEventListener('click', (e) => {
                e.stopPropagation();
                this.bleManager.disconnect();
            });
        }

        // Modal Windows Setup (統合設定モーダル ⚙️)
        if (this.btnModalSettings && this.modalSettings) {
            this.btnModalSettings.addEventListener('click', () => {
                this.modalSettings.style.display = 'flex';
            });
        }

        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.dataset.close;
                const modal = document.getElementById(targetId);
                if (modal) modal.style.display = 'none';
            });
        });
        document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
            backdrop.addEventListener('click', (e) => {
                if (e.target === backdrop) {
                    backdrop.style.display = 'none';
                }
            });
        });

        // 全画面表示 (Fullscreen API)
        if (this.btnFullscreen) {
            this.btnFullscreen.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(err => {
                        console.warn('Fullscreen error:', err);
                    });
                } else {
                    document.exitFullscreen().catch(err => {
                        console.warn('Exit fullscreen error:', err);
                    });
                }
            });

            document.addEventListener('fullscreenchange', () => {
                const isFs = !!document.fullscreenElement;
                this.btnFullscreen.textContent = isFs ? '⤓' : '⛶';
                this.btnFullscreen.title = isFs ? '全画面解除 (Esc)' : '全画面表示 (F11)';
                if (this.map) {
                    setTimeout(() => this.map.resize(), 100);
                }
            });
        }

        // TEST / 負荷キャリブレーション イベント
        const setTestMode = (mode) => {
            this.testMode = mode;
            this.testModeCourseBtn.classList.toggle('active', mode === 'course');
            this.testModeManualBtn.classList.toggle('active', mode === 'manual');
            this.testControlsBox.style.display = (mode === 'manual') ? 'flex' : 'none';

            if (mode === 'course') {
                this.stopLFO();
            } else {
                this.applyManualSlope(this.manualSlope);
            }
            this.updateState(this.currentProgress);
        };

        if (this.testModeCourseBtn && this.testModeManualBtn) {
            this.testModeCourseBtn.addEventListener('click', () => setTestMode('course'));
            this.testModeManualBtn.addEventListener('click', () => setTestMode('manual'));
        }

        if (this.testSlopeSlider) {
            this.testSlopeSlider.addEventListener('input', (e) => {
                this.stopLFO();
                this.applyManualSlope(parseFloat(e.target.value));
            });
        }

        if (this.btnPresetSlopes) {
            this.btnPresetSlopes.forEach(btn => {
                btn.addEventListener('click', () => {
                    this.stopLFO();
                    const val = parseFloat(btn.dataset.val);
                    if (this.testSlopeSlider) this.testSlopeSlider.value = val;
                    this.applyManualSlope(val);
                });
            });
        }

        if (this.lfoPeriodSelect) {
            this.lfoPeriodSelect.addEventListener('change', (e) => {
                this.lfoPeriodSeconds = parseFloat(e.target.value) || 20;
            });
        }

        if (this.btnLfoToggle) {
            this.btnLfoToggle.addEventListener('click', () => {
                if (this.isLfoRunning) {
                    this.stopLFO();
                } else {
                    this.startLFO();
                }
            });
        }

        this.bleManager.on('connected', () => {
            this.baseProgressAtBleStart = this.currentProgress;
            this.hasBleDistance = false;
        });

        this.bleManager.on('disconnected', () => {
            if (this.btnBleConnect) {
                this.btnBleConnect.classList.remove('connected');
                this.bleStatusText.textContent = '⚡ スマートトレーナー接続';
            }
            if (this.btnBleDisconnect) {
                this.btnBleDisconnect.style.display = 'none';
            }
            if (this.valPower) this.valPower.textContent = '--';
            if (this.valCadence) this.valCadence.textContent = '--';
            this.hasBleDistance = false;
        });

        this.bleManager.on('data', (data) => {
            if (data.power !== null && this.valPower) {
                this.valPower.textContent = data.power;
            }
            if (data.cadence !== null && this.valCadence) {
                this.valCadence.textContent = data.cadence;
            }
            // スマートトレーナーから実測速度が送られてきた場合、スライダーと表示を同期
            if (data.speed !== null) {
                this.speedKmh = data.speed;
                if (this.speedSlider) this.speedSlider.value = Math.min(50, Math.round(data.speed));
                if (this.speedVal) this.speedVal.textContent = `${Math.round(data.speed)} km/h`;
            }

            // 【方法1】FTMSの Total Distance（累積走行距離）が取得できた場合、ダイレクトに進捗計算
            if (data.sessionDistanceMeters !== null && this.course.totalDistance > 0) {
                this.hasBleDistance = true;
                const progressDelta = data.sessionDistanceMeters / this.course.totalDistance;
                const directProgress = (this.baseProgressAtBleStart + progressDelta) % 1.0;
                this.updateState(directProgress);
            }
        });

        this.progressSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) / 100;
            this.setManualProgress(val);
        });

        this.progressInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 0;
            val = Math.max(0, Math.min(100, val)) / 100;
            this.setManualProgress(val);
        });

        this.btnPlay.addEventListener('click', () => {
            this.isPlaying = !this.isPlaying;
            this.btnPlay.textContent = this.isPlaying ? '❚❚' : '▶';
            this.btnPlay.title = this.isPlaying ? '一時停止 (Pause)' : '自動再生 (Auto Fly)';
            this.btnPlay.classList.toggle('running', this.isPlaying);
        });

        this.btnReset.addEventListener('click', () => {
            this.isPlaying = false;
            this.btnPlay.textContent = '▶';
            this.btnPlay.title = '自動再生 (Auto Fly)';
            this.btnPlay.classList.remove('running');
            if (this.bleManager) {
                this.bleManager.resetDistance();
            }
            this.baseProgressAtBleStart = 0.0;
            this.updateState(0.0);
        });

        this.speedSlider.addEventListener('input', (e) => {
            this.speedKmh = parseFloat(e.target.value);
            this.speedVal.textContent = `${Math.round(this.speedKmh)} km/h`;
        });

        this.camPitchSlider.addEventListener('input', (e) => {
            this.cameraParams.pitch = parseFloat(e.target.value);
            this.camPitchVal.textContent = `${Math.round(this.cameraParams.pitch)}°`;
            if (this.cameraMode !== 'free') {
                this.applyCameraTarget(0);
            }
        });

        this.camZoomSlider.addEventListener('input', (e) => {
            this.cameraParams.zoom = parseFloat(e.target.value);
            this.camZoomVal.textContent = this.cameraParams.zoom.toFixed(1);
            if (this.cameraMode !== 'free') {
                this.applyCameraTarget(0);
            }
        });

        // アングルスライダー（極性反転）
        this.camOrbitSlider.addEventListener('input', (e) => {
            this.orbitAngleOffset = parseFloat(e.target.value);
            if (this.orbitAngleOffset === 0) {
                this.camOrbitVal.textContent = '0° (真後ろ)';
            } else {
                const sign = this.orbitAngleOffset > 0 ? '+' : '';
                this.camOrbitVal.textContent = `${sign}${Math.round(this.orbitAngleOffset)}°`;
            }
            if (this.cameraMode !== 'free') {
                this.applyCameraTarget(0);
            }
        });

        const setCamMode = (mode) => {
            this.cameraMode = mode;
            this.camChaseBtn.classList.toggle('active', mode === 'track');
            this.camFreeBtn.classList.toggle('active', mode === 'free');

            if (this.camAdjustBox) {
                this.camAdjustBox.style.opacity = (mode === 'free') ? '0.35' : '1';
            }

            if (mode !== 'free') {
                this.isModeTransitioning = true;
                this.applyCameraTarget(2000);
                setTimeout(() => {
                    this.isModeTransitioning = false;
                }, 2000);
            }
        };

        this.camChaseBtn.addEventListener('click', () => setCamMode('track'));
        this.camFreeBtn.addEventListener('click', () => setCamMode('free'));

        this.chartCanvas.addEventListener('click', (e) => {
            const rect = this.chartCanvas.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const progress = Math.max(0, Math.min(1, clickX / rect.width));
            this.setManualProgress(progress);
        });

        window.addEventListener('resize', () => {
            this.map.resize();
            if (this.cameraMode !== 'free') {
                this.applyCameraTarget(0);
            }
        });
    }

    /**
     * ユーザーによる現在地（スライダー / 入力値 / 標高グラフクリック）の手動調整
     * BLE接続中であっても、この調整位置を新しい基準点（baseProgressAtBleStart）としてリセットし、
     * ここからトレーナーのペダリングが前進するように同期する
     */
    setManualProgress(progress) {
        if (this.bleManager && this.bleManager.isConnected) {
            this.bleManager.resetDistance();
        }
        this.baseProgressAtBleStart = progress;
        this.updateState(progress);
    }

    applyManualSlope(slope) {
        this.manualSlope = Math.max(-3, Math.min(7, slope));
        if (this.testSlopeVal) {
            const s = this.manualSlope >= 0 ? '+' : '';
            this.testSlopeVal.textContent = `${s}${this.manualSlope.toFixed(1)} %`;
        }
        if (this.btnPresetSlopes) {
            this.btnPresetSlopes.forEach(btn => {
                const bVal = parseFloat(btn.dataset.val);
                btn.classList.toggle('active', Math.abs(bVal - this.manualSlope) < 0.15);
            });
        }
        this.sendSlopeToTrainer(this.manualSlope);
    }

    startLFO() {
        this.isLfoRunning = true;
        this.lfoStartTime = performance.now();
        if (this.btnLfoToggle) {
            this.btnLfoToggle.textContent = 'LFO 停止';
            this.btnLfoToggle.classList.add('running');
        }
        if (this.testLfoStatus) {
            this.testLfoStatus.textContent = 'RUNNING';
            this.testLfoStatus.style.color = '#10b981';
        }
    }

    stopLFO() {
        this.isLfoRunning = false;
        if (this.btnLfoToggle) {
            this.btnLfoToggle.textContent = 'LFO 開始';
            this.btnLfoToggle.classList.remove('running');
        }
        if (this.testLfoStatus) {
            this.testLfoStatus.textContent = 'OFF';
            this.testLfoStatus.style.color = 'var(--text-muted)';
        }
    }

    /**
     * トレーナーへ指示負荷を送信し、HUDおよび画面へ常に現在指示負荷を反映
     */
    sendSlopeToTrainer(targetSlope) {
        // NEROの上限7%（安全リミット8%）でクランプ
        const clampedSlope = Math.max(-8.0, Math.min(8.0, targetSlope));
        this.lastTargetSlopeSent = clampedSlope;

        // HUDの Trainer 指示負荷表示を常に更新
        if (this.elTrainerSlope) {
            const trSign = clampedSlope >= 0 ? '+' : '';
            const modeTag = this.testMode === 'manual' ? (this.isLfoRunning ? '[LFO]' : '[TEST]') : '';
            this.elTrainerSlope.textContent = `Trainer: ${trSign}${clampedSlope.toFixed(1)}% ${modeTag}`;
            this.elTrainerSlope.classList.toggle('alert', clampedSlope >= 7.0);
        }

        if (this.bleManager && this.bleManager.isConnected) {
            this.bleManager.sendSlope(clampedSlope);
        }
    }

    updateState(progress) {
        this.currentProgress = ((progress % 1.0) + 1.0) % 1.0;
        const state = this.course.getStateAtProgress(this.currentProgress);

        if (this.riderMarker) {
            this.riderMarker.setLngLat([state.lon, state.lat]);
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

        // スマートトレーナー上限ガード（8%で頭打ち・下限は急降下防止で-8%）
        const MAX_TRAINER_SLOPE = 8.0;
        const MIN_TRAINER_SLOPE = -8.0;
        const rawSlope = state.slope;
        const cappedTrainerSlope = Math.max(MIN_TRAINER_SLOPE, Math.min(MAX_TRAINER_SLOPE, rawSlope));
        const isCapped = rawSlope > MAX_TRAINER_SLOPE;

        if (this.elSlopeCard) {
            this.elSlopeCard.classList.toggle('capped', isCapped);
        }
        if (this.slopeCapBadge) {
            this.slopeCapBadge.style.display = isCapped ? 'inline-block' : 'none';
        }

        if (state.slope > 7) {
            this.elSlopeWrap.style.color = 'var(--climb-color)';
        } else if (state.slope < 0) {
            this.elSlopeWrap.style.color = 'var(--descent-color)';
        } else {
            this.elSlopeWrap.style.color = 'var(--flat-color)';
        }

        // コース連動モードのときのみ、コース計算された勾配をトレーナーへ送信
        if (this.testMode === 'course') {
            this.sendSlopeToTrainer(cappedTrainerSlope);
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

    applyCameraTarget(duration = 0) {
        if (!this.map || this.cameraMode === 'free') return;

        const state = this.course.getStateAtProgress(this.currentProgress);
        const padding = this.getCameraPadding();

        let targetPitch = this.cameraParams.pitch;
        let targetZoom = this.cameraParams.zoom;

        // アングル極性反転: - this.orbitAngleOffset に変更
        const targetBearing = (state.bearing - this.orbitAngleOffset + 360) % 360;

        if (this.currentCamBearing === null || duration > 0) {
            this.currentCamBearing = targetBearing;
        } else {
            this.currentCamBearing = App.lerpAngle(this.currentCamBearing, targetBearing, 0.08);
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

    animate(timestamp) {
        requestAnimationFrame(this.animate);

        // LFO 自動スキャンの実行（三角波: 0% → 7% → 0% を lfoPeriodSeconds で往復）
        if (this.testMode === 'manual' && this.isLfoRunning) {
            const elapsed = (timestamp - this.lfoStartTime) / 1000;
            const period = Math.max(2, this.lfoPeriodSeconds);
            const phase = (elapsed % period) / period; // 0.0 〜 1.0
            // 三角波: 0 -> 1 -> 0
            const tri = phase < 0.5 ? (phase * 2) : ((1.0 - phase) * 2);
            // 0% から 7.0% まで線形スキャン
            const lfoSlope = Math.round((tri * 7.0) * 10) / 10;

            if (this.testSlopeSlider) {
                this.testSlopeSlider.value = lfoSlope;
            }
            this.applyManualSlope(lfoSlope);
        }

        // BLE接続中でトレーナーが回転している（速度 > 0）場合、または「再生」ボタンが押されている場合に進捗更新
        const isBleRiding = this.bleManager.isConnected && this.speedKmh > 0;

        if (this.isPlaying || isBleRiding) {
            if (!this.lastFrameTime) this.lastFrameTime = timestamp;
            const deltaSeconds = Math.min((timestamp - this.lastFrameTime) / 1000, 0.1);
            this.lastFrameTime = timestamp;

            // 【方法1】の Total Distance を受信できている場合は on('data') 側で正確に更新するためここでは二重積算しない
            // Total Distance が未サポートのトレーナーの場合のみ、速度×時間（Δt）でフォールバック積算
            if (!this.hasBleDistance) {
                const metersPerSecond = (this.speedKmh * 1000) / 3600;
                const distanceMoved = metersPerSecond * deltaSeconds;
                const progressDelta = this.course.totalDistance > 0 ? (distanceMoved / this.course.totalDistance) : 0;

                const nextProgress = (this.currentProgress + progressDelta) % 1.0;
                this.updateState(nextProgress);
            }
        } else {
            this.lastFrameTime = 0;
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new App();
});
