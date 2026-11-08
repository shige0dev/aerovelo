import { GeoCourseManager, DEFAULT_LAKE_ROUTE } from './course.js';
import { clamp } from './utils.js';
import { GPXParser } from './gpx-parser.js';
import { BleTrainerManager } from './ble.js';
import { ElevationChart } from './elevation-chart.js';
import { MapViewController } from './map-view.js';
import { UIController } from './ui-controller.js';

class App {
    constructor() {
        this.course = new GeoCourseManager(DEFAULT_LAKE_ROUTE, '読み込み中...');
        this.currentProgress = 0.0;
        this.isPlaying = false;
        this.speedKmh = 25;
        this.lastFrameTime = 0;

        // 負荷制御ステート ('auto': コース連動, 'manual': 手動固定, 'lfo': 連続スキャン)
        this.loadMode = 'auto';
        this.manualSlope = 0.0;
        this.lfoPeriodSeconds = 60;
        this.lfoStartTime = 0;
        this.camFwdMult = 2.0;
        this.camBwdMult = 1.0;

        // Bluetooth Smart Trainer
        this.bleManager = new BleTrainerManager();
        this.hasBleDistance = false;
        this.baseProgressAtBleStart = 0;

        // 1. UI Controller
        this.ui = new UIController({
            onTogglePlay: () => this.setPlayState(!this.isPlaying),
            onToggleManualMode: () => this.setLoadMode(this.loadMode === 'auto' ? 'manual' : 'auto'),
            onManualSlopeInput: (val, forceManual) => this.setManualSlope(val, forceManual),
            onToggleLfo: () => this.setLoadMode(this.loadMode === 'lfo' ? 'manual' : 'lfo'),
            onLfoPeriodChange: (sec) => { this.lfoPeriodSeconds = sec; },
            getManualSlope: () => this.manualSlope,
            isPlaying: () => this.isPlaying,
            getSpeed: () => this.speedKmh,
            onSpeedChange: (spd) => {
                this.speedKmh = spd;
                this.ui.updateMetrics(this.currentState(), this.speedKmh);
            },
            onToggleCameraFree: () => this.toggleCameraFree(),
            onVectorMultiplierChange: ({ fwdMult, bwdMult }) => {
                if (fwdMult !== undefined) this.camFwdMult = fwdMult;
                if (bwdMult !== undefined) this.camBwdMult = bwdMult;
                this.updateState(this.currentProgress, true);
            },
            onToggleMarker: (type, isVisible) => this.mapView.setMarkerVisibility({ [type]: isVisible }),
            onResetNorth: () => {
                this.mapView.setCameraParams({ orbit: 0 }, this.currentState());
                this.ui.syncCameraParams({ orbit: 0 });
            },
            onCameraParamChange: (params) => this.mapView.setCameraParams(params, this.currentState()),
            onFullscreenChange: () => setTimeout(() => this.handleResize(), 100),
            onBleConnect: () => this.connectBle(),
            onBleDisconnect: () => this.bleManager.disconnect(),
            onSelectPreset: (url) => this.loadDefaultGPX(url, true),
            onLoadGpxFile: (file) => this.loadGPXFile(file),
            onRequestGsiDem: () => this.applyGsiDem(),
            onShowStructures: () => this.ui.showStructureDialog(this.course)
        });

        // 2. 標高プロファイル Canvas & 3D マップ
        this.chart = new ElevationChart('elevation-canvas', (p) => this.setManualProgress(p));
        this.chart.setCourse(this.course);

        const startState = this.currentState();
        this.mapView = new MapViewController(
            'map',
            startState,
            (params) => this.ui.syncCameraParams(params),
            (syncedCourse) => {
                if (this.course === syncedCourse) {
                    this.chart.setCourse(this.course);
                    this.ui.updateCourseMeta(this.course, this.currentProgress);
                    this.updateState(this.currentProgress);
                }
            }
        );
        this.mapView.setCourse(this.course, startState);

        // 3. イベント配線 & メインループ開始
        this.setupBleEvents();
        window.addEventListener('resize', () => this.handleResize());

        this.ui.updateCourseMeta(this.course, this.currentProgress);
        this.updateState(0.0);

        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
        this.loadDefaultGPX('gpx/hiyoshi_12.5km_D738.gpx');
    }

    currentState() {
        return this.course.getStateAtProgress(this.currentProgress, this.speedKmh, this.camFwdMult, this.camBwdMult);
    }

    handleResize() {
        this.mapView.resize(this.currentState());
        this.chart.resize();
        this.chart.draw();
    }

    // --- Course & GPX Management ---

    parseAndApplyGPX(gpxText, fallbackName, showDialog = false) {
        const { courseName, waypoints, isWebEditor } = GPXParser.parse(gpxText);
        const finalName = courseName !== 'カスタムコース' ? courseName : fallbackName.replace(/\.gpx$/i, '');
        const activeCourse = new GeoCourseManager(waypoints, finalName, isWebEditor);
        this.course = activeCourse;
        this.setPlayState(false);
        this.currentProgress = 0.0;

        this.ui.updateCourseMeta(this.course, 0.0);
        this.chart.setCourse(this.course);
        this.mapView.setCourse(this.course, this.currentState());
        this.updateState(0.0);

        // 橋・トンネル認識と標高DEM同期を実行（端部直線高度維持を含む）
        (async () => {
            try {
                await activeCourse.syncElevations();
            } catch (err) {
                console.warn('Elevation sync skipped:', err);
            }
        })().then(() => {
            if (this.course !== activeCourse) return;
            this.ui.updateCourseMeta(this.course, this.currentProgress);
            this.chart.setCourse(this.course);
            this.mapView.setCourse(this.course, null);
            this.updateState(this.currentProgress);
            if (showDialog) {
                this.ui.showStructureDialog(this.course);
            }
        });
    }

    async loadDefaultGPX(url, showDialog = false) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.parseAndApplyGPX(await res.text(), url.split('/').pop(), showDialog);
        } catch (err) {
            console.warn(`デフォルトGPX取得エラー (${url}):`, err);
        }
    }

    loadGPXFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                this.parseAndApplyGPX(e.target.result, file.name, true);
            } catch (err) {
                console.error(err);
                alert(`GPX読み込みエラー: ${err.message}`);
            }
        };
        reader.readAsText(file);
    }

    async applyGsiDem() {
        try {
            this.ui.setGsiLoading(true, 0);
            await this.course.recalculateWithGSI10m((pct) => this.ui.setGsiLoading(true, pct));
            this.ui.updateCourseMeta(this.course, this.currentProgress);
            this.chart.setCourse(this.course);
            this.mapView.setCourse(this.course, null);
            this.updateState(this.currentProgress);
            this.ui.showStructureDialog(this.course);
        } catch (err) {
            console.error('GSI DEM error:', err);
            alert(`10mメッシュ標高の取得に失敗しました: ${err.message}`);
            this.ui.updateCourseMeta(this.course, this.currentProgress);
        }
    }

    // --- State & Load Control ---

    setPlayState(playing) {
        this.isPlaying = playing;
        this.ui.updatePlayState(playing);
    }

    toggleCameraFree() {
        const nextMode = this.mapView.cameraMode === 'free' ? 'track' : 'free';
        this.ui.updateCameraModeUI(nextMode === 'free');
        this.mapView.setCameraMode(nextMode, this.currentState());
    }

    setLoadMode(mode) {
        this.loadMode = mode;
        if (mode === 'lfo') this.lfoStartTime = performance.now();
        this.ui.updateLfoState(mode === 'lfo');
        this.ui.updateManualModeState(mode !== 'auto');
        this.sendSlopeToTrainer(mode === 'auto' ? this.currentState().slope : this.manualSlope);
    }

    setManualSlope(slope, switchToManual = true) {
        this.manualSlope = clamp(slope, 0.0, 7.0);
        if (switchToManual && this.loadMode !== 'manual') {
            this.setLoadMode('manual');
        } else {
            this.sendSlopeToTrainer(this.manualSlope);
        }
    }

    sendSlopeToTrainer(targetSlope) {
        const clampedSlope = clamp(targetSlope, 0.0, 7.0);
        this.ui.updateTrainerSlopeDisplay(clampedSlope);
        if (this.bleManager.isConnected) this.bleManager.sendSlope(clampedSlope);
    }

    // --- BLE Smart Trainer Integration ---

    async connectBle() {
        if (this.bleManager.isConnected) return;
        try {
            this.ui.updateBleConnectionState('connecting');
            const res = await this.bleManager.connect();
            this.ui.updateBleConnectionState('connected', res.deviceName);
        } catch (err) {
            console.warn('BLE connect cancelled or failed:', err);
            this.ui.updateBleConnectionState('disconnected');
            if (err.name !== 'NotFoundError') alert(`Bluetooth接続エラー: ${err.message}`);
        }
    }

    setupBleEvents() {
        this.bleManager.on('connected', () => {
            this.baseProgressAtBleStart = this.currentProgress;
            this.hasBleDistance = false;
        });

        this.bleManager.on('disconnected', () => {
            this.ui.updateBleConnectionState('disconnected');
            this.hasBleDistance = false;
        });

        this.bleManager.on('data', (data) => {
            if (data.speed !== null) this.speedKmh = data.speed;
            this.ui.updateBleMetrics(data);

            if (data.sessionDistanceMeters !== null && this.course.totalDistance > 0) {
                this.hasBleDistance = true;
                const progressDelta = data.sessionDistanceMeters / this.course.totalDistance;
                this.updateState(Math.min(1.0, this.baseProgressAtBleStart + progressDelta));
            }
        });
    }

    // --- Progress & Main Loop ---

    setManualProgress(progress) {
        if (this.bleManager.isConnected) this.bleManager.resetDistance();
        this.baseProgressAtBleStart = progress;
        this.updateState(progress, true);
    }

    updateState(progress, forceInstant = false) {
        this.currentProgress = isNaN(progress) ? 0.0 : clamp(progress, 0.0, 1.0);
        const state = this.currentState();

        this.ui.updateMetrics(state, this.speedKmh);
        this.sendSlopeToTrainer(this.loadMode === 'auto' ? state.slope : this.manualSlope);
        this.chart.setProgress(this.currentProgress);

        const isMoving = !forceInstant && (this.isPlaying || (this.bleManager.isConnected && this.speedKmh > 0));
        this.mapView.updateRiderAndCamera(state, forceInstant ? 300 : 0, isMoving);
    }

    animate(timestamp) {
        requestAnimationFrame(this.animate);

        // LFO スキャン実行（三角波: 0% ⇄ 7%）
        if (this.loadMode === 'lfo') {
            const period = Math.max(2, this.lfoPeriodSeconds);
            const phase = (((timestamp - this.lfoStartTime) / 1000) % period) / period;
            const tri = phase < 0.5 ? phase * 2 : (1.0 - phase) * 2;
            this.setManualSlope(Math.round(tri * 70) / 10, false);
        }

        const isBleRiding = this.bleManager.isConnected && this.speedKmh > 0;
        if (this.isPlaying || isBleRiding) {
            if (!this.lastFrameTime) this.lastFrameTime = timestamp;
            const dt = Math.min((timestamp - this.lastFrameTime) / 1000, 0.1);
            this.lastFrameTime = timestamp;

            if (!this.hasBleDistance && this.course.totalDistance > 0) {
                const distMoved = ((this.speedKmh * 1000) / 3600) * dt;
                const nextProgress = this.currentProgress + distMoved / this.course.totalDistance;
                if (nextProgress >= 1.0) {
                    if (this.isPlaying) {
                        this.setPlayState(false);
                        this.updateState(1.0);
                        setTimeout(() => {
                            if (!this.isPlaying) this.setManualProgress(0.0);
                        }, 500);
                    } else {
                        this.updateState(1.0);
                    }
                } else {
                    this.updateState(nextProgress);
                }
            }
        } else {
            this.lastFrameTime = 0;
        }
    }
}

window.addEventListener('DOMContentLoaded', () => new App());
