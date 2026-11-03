/**
 * UI & DOM Event Controller
 * Encapsulates all DOM queries, HUD/Bottom-bar updates, modals, sliders, and file controls.
 */

const $ = (id) => document.getElementById(id);
const on = (elOrId, type, fn, opts) => {
    const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
    el?.addEventListener(type, fn, opts);
    return el;
};

export class UIController {
    constructor(callbacks = {}) {
        this.cb = callbacks;
        this.currentZoom = 16.5;

        // HUD数値表示ノードマップ (hud-<metric>-val に統一)
        this.hud = {
            speed: $('hud-speed-val'),
            dist: $('hud-dist-val'),
            cadence: $('hud-cadence-val'),
            power: $('hud-power-val'),
            alt: $('hud-alt-val'),
            slope: $('hud-slope-val'),
            load: $('hud-load-val'),
            zoom: $('hud-zoom-val')
        };

        this.el = {
            btnPlay: $('btn-play'),
            canvasSpeedVal: $('canvas-speed-val'),
            autorunSpeedBox: $('autorun-speed-box'),
            totalDistTag: $('bottom-total-dist-tag'),
            rowSlopeCtrl: $('row-slope-ctrl'),
            btnManualMode: $('btn-manual-mode'),
            rowZoomCtrl: $('row-zoom-ctrl'),
            courseName: $('course-name-display'),
            btnFullscreen: $('btn-fullscreen'),
            camFreeBtn: $('cam-free'),
            camAdjustBox: $('camera-adjust-box'),
            camZoomSlider: $('cam-zoom-slider'),
            camZoomVal: $('cam-zoom-val'),
            compassBtn: $('compass-btn'),
            compassDial: $('compass-dial'),
            btnGsiDem: $('btn-gsi-dem'),
            gsiBtnText: $('gsi-btn-text'),
            btnBleConnect: $('btn-ble-connect'),
            btnBleDisconnect: $('btn-ble-disconnect'),
            bleStatusText: $('ble-status-text'),
            testSlopeSlider: $('test-slope-slider'),
            testSlopeVal: $('test-slope-val'),
            btnLfoToggle: $('btn-lfo-toggle')
        };

        this.bindEvents();
    }

    /**
     * HUDの数値を宣言的に一括更新する共通ヘルパー
     */
    setHud(values) {
        for (const [key, val] of Object.entries(values)) {
            if (val != null && this.hud[key]) {
                this.hud[key].textContent = val;
            }
        }
    }

    /**
     * 要素の上下ドラッグ（Pointer Events）＆ホイールによる汎用数値スクラバー
     * DOMからのテキスト逆読みを廃し、min/max/step/pxPerStepで疎結合に制御
     */
    bindScrubber(element, { min, max, step, pxPerStep, isEnabled = () => true, getValue, onInput }) {
        if (!element) return;
        let isDragging = false, startY = 0, startVal = 0;

        const clampRound = (val) => {
            const stepped = Math.round(val / step) * step;
            const fixed = Number(stepped.toFixed(2));
            return Math.max(min, Math.min(max, fixed));
        };

        on(element, 'pointerdown', (e) => {
            if (!isEnabled() || e.target.closest('button')) return;
            isDragging = true;
            startY = e.clientY;
            startVal = getValue();
            element.setPointerCapture?.(e.pointerId);
            document.body.style.userSelect = 'none';
        });

        on(element, 'pointermove', (e) => {
            if (!isDragging || !isEnabled()) return;
            const deltaSteps = (startY - e.clientY) / pxPerStep;
            onInput(clampRound(startVal + deltaSteps * step));
        });

        const endDrag = () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.userSelect = '';
            }
        };
        on(element, 'pointerup', endDrag);
        on(element, 'pointercancel', endDrag);

        on(element, 'wheel', (e) => {
            if (!isEnabled()) return;
            e.preventDefault();
            const dir = e.deltaY < 0 ? 1 : -1;
            onInput(clampRound(getValue() + dir * step));
        }, { passive: false });
    }

    /**
     * フローティングダイアログの開閉バインド共通ヘルパー
     */
    bindDialog(toggleBtnId, closeBtnId, dialogId) {
        const btnToggle = $(toggleBtnId), dialog = $(dialogId);
        if (!btnToggle || !dialog) return;
        on(btnToggle, 'click', () => {
            const show = dialog.style.display === 'none' || !dialog.style.display;
            dialog.style.display = show ? 'flex' : 'none';
            btnToggle.classList.toggle('active', show);
        });
        on(closeBtnId, 'click', () => {
            dialog.style.display = 'none';
            btnToggle.classList.remove('active');
        });
    }

    bindEvents() {
        const { cb, el } = this;

        // Play / Pause & Manual Mode & LFO
        on(el.btnPlay, 'click', () => cb.onTogglePlay?.());
        on(el.btnManualMode, 'click', () => cb.onToggleManualMode?.());
        on(el.testSlopeSlider, 'input', (e) => cb.onManualSlopeInput?.(parseFloat(e.target.value), true));
        on(el.btnLfoToggle, 'click', () => cb.onToggleLfo?.());
        on('lfo-period-select', 'change', (e) => cb.onLfoPeriodChange?.(parseFloat(e.target.value) || 60));

        // 1. 下部Canvas AutoRun横の再生速度スクラバー (AUTORUN時のみ有効)
        this.bindScrubber(el.autorunSpeedBox, {
            min: 1, max: 80, step: 1, pxPerStep: 4,
            isEnabled: () => !!cb.isPlaying?.(),
            getValue: () => cb.getSpeed?.() ?? 25,
            onInput: (v) => cb.onSpeedChange?.(v)
        });

        // 2. 上部HUD Load (負荷) スクラバー (常時有効・操作時にManualへ自動切替)
        this.bindScrubber(el.rowSlopeCtrl, {
            min: 0, max: 7, step: 0.1, pxPerStep: 3,
            getValue: () => cb.getManualSlope?.() ?? 0.0,
            onInput: (v) => cb.onManualSlopeInput?.(v, true)
        });

        // 3. 上部HUD Zoom スクラバー
        this.bindScrubber(el.rowZoomCtrl, {
            min: 13.0, max: 18.5, step: 0.1, pxPerStep: 4,
            getValue: () => this.currentZoom,
            onInput: (v) => {
                this.syncZoomUI(v);
                cb.onCameraParamChange?.({ zoom: v });
            }
        });

        // 4. フローティングダイアログ (カメラ / 設定) & カメラ操作
        this.bindDialog('btn-toggle-cam-dialog', 'btn-close-cam-dialog', 'camera-dialog');
        this.bindDialog('btn-modal-settings', 'btn-close-settings', 'modal-settings');
        on(el.camFreeBtn, 'click', () => cb.onToggleCameraFree?.());
        on(el.compassBtn, 'click', () => cb.onResetNorth?.());

        // 注視点 HIDE ボタン（ハイライト時＝消去中、消灯時＝表示中）
        [['btn-toggle-fwd-marker', 'fwd'], ['btn-toggle-bwd-marker', 'bwd']].forEach(([id, key]) => {
            let visible = true;
            const btn = $(id);
            on(btn, 'click', () => {
                visible = !visible;
                btn?.classList.toggle('active', !visible);
                cb.onToggleMarker?.(key, visible);
            });
        });

        // カメラ調整スライダー一括バインド
        [
            ['cam-smooth-slider', 'cam-smooth-val', (v) => v === 0 ? 'OFF' : (v === 5 ? '5 (標準)' : `${v}`), (v) => cb.onSmoothChange?.(v)],
            ['cam-fwd-mult-slider', 'cam-fwd-mult-val', (v) => `${v.toFixed(1)}x`, (v) => cb.onVectorMultiplierChange?.({ fwdMult: v })],
            ['cam-bwd-mult-slider', 'cam-bwd-mult-val', (v) => `${v.toFixed(1)}x`, (v) => cb.onVectorMultiplierChange?.({ bwdMult: v })],
            ['cam-pitch-slider', 'cam-pitch-val', (v) => `${Math.round(v)}°`, (v) => cb.onCameraParamChange?.({ pitch: v })],
            ['cam-orbit-slider', 'cam-orbit-val', (v) => v === 0 ? '0°' : `${v > 0 ? '+' : ''}${Math.round(v)}°`, (v) => cb.onCameraParamChange?.({ orbitAngleOffset: v })],
            ['cam-zoom-slider', null, null, (v) => { this.syncZoomUI(v); cb.onCameraParamChange?.({ zoom: v }); }]
        ].forEach(([sliderId, valId, fmt, handler]) => {
            const valEl = valId ? $(valId) : null;
            on(sliderId, 'input', (e) => {
                const v = parseFloat(e.target.value);
                if (valEl && fmt) valEl.textContent = fmt(v);
                handler(v);
            });
        });

        // 5. フルスクリーン
        if (el.btnFullscreen) {
            on(el.btnFullscreen, 'click', () => {
                if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
                else document.exitFullscreen().catch(() => {});
            });
            on(document, 'fullscreenchange', () => {
                const isFs = !!document.fullscreenElement;
                el.btnFullscreen.textContent = isFs ? '⤓' : '⛶';
                el.btnFullscreen.title = isFs ? '全画面解除 (Esc)' : '全画面表示 (F11)';
                cb.onFullscreenChange?.();
            });
        }

        // 6. BLE & GPX / DEM
        on(el.btnBleConnect, 'click', () => cb.onBleConnect?.());
        on(el.btnBleDisconnect, 'click', (e) => { e.stopPropagation(); cb.onBleDisconnect?.(); });
        on('preset-select', 'change', (e) => cb.onSelectPreset?.(e.target.value));
        on(el.btnGsiDem, 'click', () => cb.onRequestGsiDem?.());

        const fileInput = $('gpx-file-input');
        on('btn-browse', 'click', (e) => { e.stopPropagation(); fileInput?.click(); });
        on(fileInput, 'change', (e) => { if (e.target.files[0]) cb.onLoadGpxFile?.(e.target.files[0]); });
    }

    // --- UI Rendering / State Update Methods ---

    updateCourseMeta(course, currentProgress) {
        const { el } = this;
        const totalKm = (course.totalDistance / 1000).toFixed(2);
        if (el.totalDistTag) {
            const [intPart, decPart] = totalKm.split('.');
            el.totalDistTag.textContent = `Total ${intPart.padStart(3, '0')}.${decPart}Km`;
        }
        this.setHud({ dist: ((currentProgress * course.totalDistance) / 1000).toFixed(2) });

        if (el.courseName) {
            const title = `${course.name}${course.isGsiCorrected ? ' [DEM5A]' : ''}`;
            el.courseName.textContent = title;
            el.courseName.title = `${title} (${totalKm} km)`;
        }
        if (el.btnGsiDem) {
            el.btnGsiDem.style.display = course.isWithinJapan() ? 'flex' : 'none';
            el.btnGsiDem.classList.toggle('active', course.isGsiCorrected);
            el.btnGsiDem.classList.remove('loading');
            if (el.gsiBtnText) {
                el.gsiBtnText.textContent = course.isGsiCorrected ? '5mメッシュ補正済 (DEM5A)' : '5mメッシュ標高で補正';
            }
        }
    }

    setGsiLoading(isLoading, pct = 0) {
        const { btnGsiDem, gsiBtnText } = this.el;
        if (!btnGsiDem || !gsiBtnText) return;
        btnGsiDem.classList.toggle('loading', isLoading);
        if (isLoading) gsiBtnText.textContent = `DEM取得中 ${pct}%...`;
    }

    updatePlayState(isPlaying) {
        const { btnPlay, autorunSpeedBox } = this.el;
        if (btnPlay) {
            btnPlay.textContent = isPlaying ? 'Pause' : 'AutoRun';
            btnPlay.title = isPlaying ? '一時停止 (Pause)' : '自動走行 (AutoRun)';
            btnPlay.classList.toggle('running', isPlaying);
        }
        autorunSpeedBox?.classList.toggle('active', isPlaying);
    }

    updateManualModeState(isManual) {
        this.el.btnManualMode?.classList.toggle('active', isManual);
    }

    updateLfoState(isRunning) {
        const { btnLfoToggle } = this.el;
        if (!btnLfoToggle) return;
        btnLfoToggle.textContent = 'AUTOSCAN';
        btnLfoToggle.classList.toggle('running', isRunning);
    }

    updateTrainerSlopeDisplay(clampedSlope) {
        const { testSlopeSlider, testSlopeVal } = this.el;
        const formatted = clampedSlope.toFixed(2);
        this.setHud({ load: formatted });
        if (testSlopeSlider) testSlopeSlider.value = clampedSlope;
        if (testSlopeVal) testSlopeVal.textContent = `${clampedSlope > 0 ? '+' : ''}${formatted} %`;
    }

    setSpeedDisplay(speedKmh) {
        const spdStr = Number(speedKmh).toFixed(2);
        this.setHud({ speed: spdStr });
        if (this.el.canvasSpeedVal) this.el.canvasSpeedVal.textContent = spdStr;
    }

    updateMetrics(state, speedKmh) {
        this.setHud({
            alt: state.alt.toFixed(2),
            slope: `${state.slope >= 0 ? '+' : ''}${state.slope.toFixed(2)}`,
            dist: (state.distance / 1000).toFixed(2)
        });
        if (this.hud.slope) {
            this.hud.slope.style.color = state.slope > 7 ? 'var(--climb)' : state.slope < 0 ? 'var(--descent)' : '#f1f5f9';
        }
        this.setSpeedDisplay(speedKmh);
    }

    updateBleMetrics({ power, cadence, speed }) {
        this.setHud({
            power: power != null ? Number(power).toFixed(2) : null,
            cadence: cadence != null ? Number(cadence).toFixed(2) : null
        });
        if (speed != null) this.setSpeedDisplay(speed);
    }

    updateBleConnectionState(state, deviceName = '') {
        const { btnBleConnect, bleStatusText, btnBleDisconnect } = this.el;
        if (!btnBleConnect || !bleStatusText) return;
        const isConnected = state === 'connected';
        btnBleConnect.classList.toggle('connected', isConnected);
        if (btnBleDisconnect) btnBleDisconnect.style.display = isConnected ? 'flex' : 'none';

        if (state === 'connecting') {
            bleStatusText.textContent = 'ペアリング中...';
        } else if (isConnected) {
            bleStatusText.textContent = `🟢 ${deviceName}`;
        } else {
            bleStatusText.textContent = '⚡ トレーナー接続';
            this.setHud({ power: '--.--', cadence: '--.--' });
        }
    }

    updateCameraModeUI(isFree) {
        const { camFreeBtn, camAdjustBox } = this.el;
        camFreeBtn?.classList.toggle('active', isFree);
        if (camAdjustBox) {
            camAdjustBox.classList.toggle('disabled', isFree);
            camAdjustBox.querySelectorAll('input').forEach((input) => { input.disabled = isFree; });
        }
    }

    syncZoomUI(zoom) {
        if (typeof zoom !== 'number' || isNaN(zoom)) return;
        this.currentZoom = zoom;
        const { camZoomSlider, camZoomVal } = this.el;
        const valStr = zoom.toFixed(1);
        this.setHud({ zoom: valStr });
        if (camZoomSlider && Math.abs(parseFloat(camZoomSlider.value) - zoom) > 0.04) camZoomSlider.value = zoom;
        if (camZoomVal) camZoomVal.textContent = valStr;
    }

    syncCameraParams({ pitch, zoom, orbitAngleOffset }) {
        if (typeof pitch === 'number') {
            const slider = $('cam-pitch-slider'), val = $('cam-pitch-val');
            if (slider) slider.value = pitch;
            if (val) val.textContent = `${Math.round(pitch)}°`;
        }
        if (typeof zoom === 'number') {
            this.syncZoomUI(zoom);
        }
        if (typeof orbitAngleOffset === 'number') {
            const slider = $('cam-orbit-slider'), val = $('cam-orbit-val');
            if (slider) slider.value = orbitAngleOffset;
            if (val) val.textContent = orbitAngleOffset === 0 ? '0°' : `${orbitAngleOffset > 0 ? '+' : ''}${Math.round(orbitAngleOffset)}°`;
        }
    }

    updateCompass(bearing) {
        if (!this.el.compassDial || typeof bearing !== 'number') return;
        this.el.compassDial.style.transform = `rotate(${-bearing}deg)`;
    }
}
