/**
 * UI & DOM Event Controller
 * Encapsulates all DOM queries, HUD/Bottom-bar updates, modals, sliders, and GPX drag-and-drop.
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
        this.el = {
            btnPlay: $('btn-play'),
            speedVal: $('speed-val'),
            canvasSpeedVal: $('canvas-speed-val'),
            autorunSpeedBox: $('autorun-speed-box'),
            altVal: $('bottom-alt-display'),
            slopeVal: $('bottom-slope-display'),
            distVal: $('bottom-dist-display'),
            totalDistTag: $('bottom-total-dist-tag'),
            valPower: $('val-power'),
            valCadence: $('val-cadence'),
            vSlopeVal: $('v-slope-val'),
            rowSlopeCtrl: $('row-slope-ctrl'),
            btnManualMode: $('btn-manual-mode'),
            courseName: $('course-name-display'),
            btnFullscreen: $('btn-fullscreen'),
            camFreeBtn: $('cam-free'),
            camAdjustBox: $('camera-adjust-box'),
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
     * 要素の上下ドラッグ（Pointer Events統合）＆ホイール操作を登録
     */
    setupVerticalDrag(element, { isEnabled, getInitialValue, onDragChange, onWheelDelta }) {
        if (!element) return;
        let isDragging = false, startY = 0, startVal = 0;

        on(element, 'pointerdown', (e) => {
            if (!isEnabled() || e.target.closest('button')) return;
            isDragging = true;
            startY = e.clientY;
            startVal = getInitialValue();
            element.setPointerCapture?.(e.pointerId);
            document.body.style.userSelect = 'none';
        });

        on(element, 'pointermove', (e) => {
            if (isDragging && isEnabled()) onDragChange(startVal, startY - e.clientY);
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
            onWheelDelta(e.deltaY < 0 ? 1 : -1);
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

        // 1. 下部Canvas AutoRun横の再生速度スライド (AUTORUN時のみ有効)
        this.setupVerticalDrag(el.autorunSpeedBox, {
            isEnabled: () => !!cb.isPlaying?.(),
            getInitialValue: () => cb.getSpeed ? cb.getSpeed() : 25,
            onDragChange: (start, dy) => cb.onSpeedChange?.(Math.max(1, Math.min(80, start + Math.round(dy / 4)))),
            onWheelDelta: (dir) => cb.onSpeedChange?.(Math.max(1, Math.min(80, (cb.getSpeed?.() ?? 25) + dir)))
        });

        // 2. 上部HUD Load (負荷) スライド (常時有効・操作時にManualへ自動切替)
        this.setupVerticalDrag(el.rowSlopeCtrl, {
            isEnabled: () => true,
            getInitialValue: () => cb.getManualSlope ? cb.getManualSlope() : 0.0,
            onDragChange: (start, dy) => cb.onManualSlopeInput?.(Math.max(0, Math.min(7, Math.round((start + dy / 25) * 10) / 10)), true),
            onWheelDelta: (dir) => cb.onManualSlopeInput?.(Math.max(0, Math.min(7, Math.round(((cb.getManualSlope?.() ?? 0) + dir * 0.1) * 10) / 10)), true)
        });

        // 3. フローティングダイアログ (カメラ / 設定) & カメラスライダー
        this.bindDialog('btn-toggle-cam-dialog', 'btn-close-cam-dialog', 'camera-dialog');
        this.bindDialog('btn-modal-settings', 'btn-close-settings', 'modal-settings');
        on(el.camFreeBtn, 'click', () => cb.onToggleCameraFree?.());

        [
            ['cam-pitch-slider', 'cam-pitch-val', 'pitch', (v) => `${Math.round(v)}°`],
            ['cam-zoom-slider', 'cam-zoom-val', 'zoom', (v) => v.toFixed(1)],
            ['cam-orbit-slider', 'cam-orbit-val', 'orbitAngleOffset', (v) => v === 0 ? '0°' : `${v > 0 ? '+' : ''}${Math.round(v)}°`]
        ].forEach(([sliderId, valId, key, fmt]) => {
            const valEl = $(valId);
            on(sliderId, 'input', (e) => {
                const v = parseFloat(e.target.value);
                if (valEl) valEl.textContent = fmt(v);
                cb.onCameraParamChange?.({ [key]: v });
            });
        });

        // 4. フルスクリーン
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

        // 5. BLE & GPX / DEM
        on(el.btnBleConnect, 'click', () => cb.onBleConnect?.());
        on(el.btnBleDisconnect, 'click', (e) => { e.stopPropagation(); cb.onBleDisconnect?.(); });
        on('preset-select', 'change', (e) => cb.onSelectPreset?.(e.target.value));
        on(el.btnGsiDem, 'click', () => cb.onRequestGsiDem?.());

        const fileInput = $('gpx-file-input');
        on('btn-browse', 'click', (e) => { e.stopPropagation(); fileInput?.click(); });
        on(fileInput, 'change', (e) => { if (e.target.files[0]) cb.onLoadGpxFile?.(e.target.files[0]); });

        const gpxSection = $('drop-zone')?.closest('.gpx-section-frameless');
        if (gpxSection) {
            const setDrag = (active) => (e) => { e.preventDefault(); e.stopPropagation(); gpxSection.classList.toggle('dragover', active); };
            ['dragenter', 'dragover'].forEach((t) => on(gpxSection, t, setDrag(true)));
            ['dragleave', 'drop'].forEach((t) => on(gpxSection, t, setDrag(false)));
            on(gpxSection, 'drop', (e) => {
                const file = e.dataTransfer?.files?.[0];
                if (!file) return;
                if (file.name.toLowerCase().endsWith('.gpx')) cb.onLoadGpxFile?.(file);
                else alert('.gpx 拡張子のファイルを選択してください。');
            });
        }
    }

    // --- UI Rendering / State Update Methods ---

    updateCourseMeta(course, currentProgress) {
        const { el } = this;
        const totalKm = (course.totalDistance / 1000).toFixed(2);
        if (el.totalDistTag) {
            const [intPart, decPart] = totalKm.split('.');
            el.totalDistTag.textContent = `Total ${intPart.padStart(3, '0')}.${decPart}Km`;
        }
        if (el.distVal) el.distVal.textContent = ((currentProgress * course.totalDistance) / 1000).toFixed(2);
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
        this.el.rowSlopeCtrl?.classList.toggle('editable', isManual);
    }

    updateLfoState(isRunning) {
        const { btnLfoToggle } = this.el;
        if (!btnLfoToggle) return;
        btnLfoToggle.textContent = isRunning ? 'スキャン停止' : '連続スキャン';
        btnLfoToggle.classList.toggle('running', isRunning);
    }

    updateTrainerSlopeDisplay(clampedSlope) {
        const { vSlopeVal, testSlopeSlider, testSlopeVal } = this.el;
        const formatted = clampedSlope.toFixed(2);
        if (vSlopeVal) vSlopeVal.textContent = formatted;
        if (testSlopeSlider) testSlopeSlider.value = clampedSlope;
        if (testSlopeVal) testSlopeVal.textContent = `${clampedSlope > 0 ? '+' : ''}${formatted} %`;
    }

    updateMetrics(state, speedKmh) {
        const { altVal, slopeVal, distVal, speedVal, canvasSpeedVal } = this.el;
        if (altVal) altVal.textContent = state.alt.toFixed(2);
        if (slopeVal) {
            slopeVal.textContent = `${state.slope >= 0 ? '+' : ''}${state.slope.toFixed(2)}`;
            slopeVal.style.color = state.slope > 7 ? 'var(--climb)' : state.slope < 0 ? 'var(--descent)' : '#f1f5f9';
        }
        if (distVal) distVal.textContent = (state.distance / 1000).toFixed(2);
        const spdStr = speedKmh.toFixed(2);
        if (speedVal) speedVal.textContent = spdStr;
        if (canvasSpeedVal) canvasSpeedVal.textContent = spdStr;
    }

    updateBleMetrics({ power, cadence, speed }) {
        const { valPower, valCadence, speedVal, canvasSpeedVal } = this.el;
        if (power != null && valPower) valPower.textContent = Number(power).toFixed(2);
        if (cadence != null && valCadence) valCadence.textContent = Number(cadence).toFixed(2);
        if (speed != null) {
            const spdStr = Number(speed).toFixed(2);
            if (speedVal) speedVal.textContent = spdStr;
            if (canvasSpeedVal) canvasSpeedVal.textContent = spdStr;
        }
    }

    updateBleConnectionState(state, deviceName = '') {
        const { btnBleConnect, bleStatusText, btnBleDisconnect, valPower, valCadence } = this.el;
        if (!btnBleConnect || !bleStatusText) return;
        const isConnected = state === 'connected';
        btnBleConnect.classList.toggle('connected', isConnected);
        if (btnBleDisconnect) btnBleDisconnect.style.display = isConnected ? 'flex' : 'none';

        if (state === 'connecting') {
            bleStatusText.textContent = 'ペアリング中...';
        } else if (isConnected) {
            bleStatusText.textContent = `🟢 ${deviceName}`;
        } else {
            bleStatusText.textContent = '⚡ スマートトレーナー接続';
            if (valPower) valPower.textContent = '--.--';
            if (valCadence) valCadence.textContent = '--.--';
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
}
