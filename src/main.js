import { GeoCourseManager, GPXParser, DEFAULT_LAKE_ROUTE } from './course.js';
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

        // 負荷制御ステート ('auto': コース連動, 'manual': 手動指定, 'lfo': 連続スキャン)
        this.loadMode = 'auto';
        this.manualSlope = 0.0;
        this.lfoPeriodSeconds = 60;
        this.lfoStartTime = 0;

        // Bluetooth Smart Trainer
        this.bleManager = new BleTrainerManager();
        this.hasBleDistance = false;
        this.baseProgressAtBleStart = 0;

        // 1. UI Controller 初期化
        this.ui = new UIController({
            onTogglePlay: () => this.setPlayState(!this.isPlaying),
            onToggleManualMode: () => this.toggleManualMode(),
            onManualSlopeInput: (val, forceManual) => this.setManualSlope(val, forceManual),
            onToggleLfo: () => this.toggleLfo(),
            onLfoPeriodChange: (sec) => { this.lfoPeriodSeconds = sec; },
            isManualMode: () => this.loadMode !== 'auto',
            getManualSlope: () => this.manualSlope,
            isPlaying: () => this.isPlaying,
            getSpeed: () => this.speedKmh,
            onSpeedChange: (spd) => {
                this.speedKmh = spd;
                this.ui.updateMetrics(this.course.getStateAtProgress(this.currentProgress), this.speedKmh);
            },
            onToggleCameraFree: () => this.toggleCameraFree(),
            onCameraParamChange: (params) => {
                const state = this.course.getStateAtProgress(this.currentProgress);
                this.mapView.setCameraParams(params, state);
            },
            onFullscreenChange: () => {
                setTimeout(() => {
                    const state = this.course.getStateAtProgress(this.currentProgress);
                    this.mapView.resize(state);
                    this.chart.resize();
                    this.chart.draw();
                }, 100);
            },
            onBleConnect: () => this.connectBle(),
            onBleDisconnect: () => this.bleManager.disconnect(),
            onSelectPreset: (url) => this.loadDefaultGPX(url),
            onLoadGpxFile: (file) => this.loadGPXFile(file),
            onRequestGsiDem: () => this.applyGsiDem()
        });

        // 2. 標高プロファイル Canvas 初期化
        this.chart = new ElevationChart('elevation-canvas', (progress) => {
            this.setManualProgress(progress);
        });
        this.chart.setCourse(this.course);

        // 3. 3D マップ＆カメラ 初期化
        const startState = this.course.getStateAtProgress(0.0);
        this.mapView = new MapViewController('map', startState);
        this.mapView.setCourse(this.course, startState);

        // 4. イベント配線 (BLE & Window Resize)
        this.setupBleEvents();
        window.addEventListener('resize', () => {
            const state = this.course.getStateAtProgress(this.currentProgress);
            this.mapView.resize(state);
            this.chart.resize();
            this.chart.draw();
        });

        // 5. 初回UI同期とアニメーションループ起動
        this.ui.updateCourseMeta(this.course, this.currentProgress);
        this.updateState(0.0);

        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);

        // デフォルトコース（Hiyoshi）自動ロード
        this.loadDefaultGPX('gpx/hiyoshi_12.5km_D738.gpx');
    }

    // --- Course & GPX Management ---

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

    loadGPXFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const { courseName, waypoints } = GPXParser.parse(e.target.result);
                const finalName = courseName !== 'カスタムコース' ? courseName : file.name.replace(/\.gpx$/i, '');
                this.applyNewCourse(waypoints, finalName);
            } catch (err) {
                console.error(err);
                alert(`GPX読み込みエラー: ${err.message}`);
            }
        };
        reader.readAsText(file);
    }

    applyNewCourse(waypoints, name) {
        this.course = new GeoCourseManager(waypoints, name);
        this.setPlayState(false);
        this.currentProgress = 0.0;

        this.ui.updateCourseMeta(this.course, 0.0);
        this.chart.setCourse(this.course);

        const startState = this.course.getStateAtProgress(0.0);
        this.mapView.setCourse(this.course, startState);
        this.updateState(0.0);
    }

    async applyGsiDem() {
        if (this.course.isGsiCorrected) return;
        try {
            this.ui.setGsiLoading(true, 0);
            await this.course.recalculateWithGSI5m((pct) => {
                this.ui.setGsiLoading(true, pct);
            });
            this.ui.updateCourseMeta(this.course, this.currentProgress);
            this.chart.setCourse(this.course);
            this.updateState(this.currentProgress);
        } catch (err) {
            console.error('GSI DEM error:', err);
            alert(`5mメッシュ標高の取得に失敗しました: ${err.message}`);
            this.ui.updateCourseMeta(this.course, this.currentProgress);
        }
    }

    // --- State & Load Control (Unified State Machine) ---

    setPlayState(playing) {
        this.isPlaying = playing;
        this.ui.updatePlayState(this.isPlaying);
    }

    toggleCameraFree() {
        const nextMode = (this.mapView.cameraMode === 'free') ? 'track' : 'free';
        this.ui.updateCameraModeUI(nextMode === 'free');
        const state = this.course.getStateAtProgress(this.currentProgress);
        this.mapView.setCameraMode(nextMode, state);
    }

    toggleManualMode() {
        if (this.loadMode === 'auto') {
            this.loadMode = 'manual';
            this.ui.updateManualModeState(true);
            this.sendSlopeToTrainer(this.manualSlope);
        } else {
            this.loadMode = 'auto';
            this.ui.updateLfoState(false);
            this.ui.updateManualModeState(false);
            const state = this.course.getStateAtProgress(this.currentProgress);
            this.sendSlopeToTrainer(state.slope);
        }
    }

    setManualSlope(slope, switchToManual = true) {
        if (this.loadMode === 'lfo' && switchToManual) {
            this.loadMode = 'manual';
            this.ui.updateLfoState(false);
        } else if (switchToManual && this.loadMode === 'auto') {
            this.loadMode = 'manual';
        }
        this.ui.updateManualModeState(this.loadMode !== 'auto');

        this.manualSlope = Math.max(0.0, Math.min(7.0, slope));
        this.sendSlopeToTrainer(this.manualSlope);
    }

    toggleLfo() {
        if (this.loadMode === 'lfo') {
            this.loadMode = 'manual';
            this.ui.updateLfoState(false);
        } else {
            this.loadMode = 'lfo';
            this.lfoStartTime = performance.now();
            this.ui.updateManualModeState(true);
            this.ui.updateLfoState(true);
        }
    }

    sendSlopeToTrainer(targetSlope) {
        const clampedSlope = Math.max(0.0, Math.min(7.0, targetSlope));
        this.ui.updateTrainerSlopeDisplay(clampedSlope);
        if (this.bleManager.isConnected) {
            this.bleManager.sendSlope(clampedSlope);
        }
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
            if (err.name !== 'NotFoundError') {
                alert(`Bluetooth接続エラー: ${err.message}`);
            }
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
            if (data.speed !== null) {
                this.speedKmh = data.speed;
            }
            this.ui.updateBleMetrics(data);

            if (data.sessionDistanceMeters !== null && this.course.totalDistance > 0) {
                this.hasBleDistance = true;
                const progressDelta = data.sessionDistanceMeters / this.course.totalDistance;
                const directProgress = Math.min(1.0, this.baseProgressAtBleStart + progressDelta);
                this.updateState(directProgress);
            }
        });
    }

    // --- Progress & Main Loop ---

    setManualProgress(progress) {
        if (this.bleManager.isConnected) {
            this.bleManager.resetDistance();
        }
        this.baseProgressAtBleStart = progress;
        this.updateState(progress);
    }

    updateState(progress) {
        if (progress >= 1.0) {
            this.currentProgress = 1.0;
        } else if (progress <= 0.0 || isNaN(progress)) {
            this.currentProgress = 0.0;
        } else {
            this.currentProgress = progress;
        }

        const state = this.course.getStateAtProgress(this.currentProgress);

        // 1. UI 表示更新
        this.ui.updateMetrics(state, this.speedKmh);

        // 2. トレーナー負荷反映 (Auto時はコース斜度、Manual/LFO時は manualSlope)
        const targetTrainerSlope = (this.loadMode === 'auto') ? state.slope : this.manualSlope;
        this.sendSlopeToTrainer(targetTrainerSlope);

        // 3. 標高プロファイル進捗線更新
        this.chart.setProgress(this.currentProgress);

        // 4. 3Dマップ・マーカー＆カメラ更新
        this.mapView.updateRiderAndCamera(state, 0);
    }

    animate(timestamp) {
        requestAnimationFrame(this.animate);

        // LFO スキャン実行（三角波: 0% ⇄ 7%）
        if (this.loadMode === 'lfo') {
            const elapsed = (timestamp - this.lfoStartTime) / 1000;
            const period = Math.max(2, this.lfoPeriodSeconds);
            const phase = (elapsed % period) / period;
            const tri = phase < 0.5 ? (phase * 2) : ((1.0 - phase) * 2);
            const lfoSlope = Math.round((tri * 7.0) * 10) / 10;
            this.setManualSlope(lfoSlope, false);
        }

        // 自動再生またはBLE実走中の進捗更新
        const isBleRiding = this.bleManager.isConnected && this.speedKmh > 0;
        if (this.isPlaying || isBleRiding) {
            if (!this.lastFrameTime) this.lastFrameTime = timestamp;
            const deltaSeconds = Math.min((timestamp - this.lastFrameTime) / 1000, 0.1);
            this.lastFrameTime = timestamp;

            if (!this.hasBleDistance) {
                const metersPerSecond = (this.speedKmh * 1000) / 3600;
                const distanceMoved = metersPerSecond * deltaSeconds;
                const progressDelta = this.course.totalDistance > 0 ? (distanceMoved / this.course.totalDistance) : 0;

                const nextProgress = this.currentProgress + progressDelta;
                if (nextProgress >= 1.0) {
                    this.updateState(1.0);
                    if (this.isPlaying) this.setPlayState(false);
                } else {
                    this.updateState(nextProgress);
                }
            }
        } else {
            this.lastFrameTime = 0;
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new App();
});
