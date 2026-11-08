/**
 * UI & DOM Event Controller
 * Encapsulates all DOM queries, HUD/Bottom-bar updates, modals, sliders, and file controls.
 */

import { clamp, $, on } from './utils.js';

const CAM_SLIDER_FORMATTERS = {
    smooth: (v) => v === 0 ? 'OFF' : (v === 5 ? '5 (標準)' : `${v}`),
    fwdMult: (v) => `${v.toFixed(1)}x`,
    bwdMult: (v) => `${v.toFixed(1)}x`,
    pitch: (v) => `${Math.round(v)}°`,
    orbit: (v) => v === 0 ? '0°' : `${v > 0 ? '+' : ''}${Math.round(v)}°`,
    zoom: (v) => v.toFixed(1)
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

        // カメラスライダー＆数値表示の定義マップ
        this.camControls = {
            smooth: { slider: $('cam-smooth-slider'), val: $('cam-smooth-val') },
            fwdMult: { slider: $('cam-fwd-mult-slider'), val: $('cam-fwd-mult-val') },
            bwdMult: { slider: $('cam-bwd-mult-slider'), val: $('cam-bwd-mult-val') },
            orbit: { slider: $('cam-orbit-slider'), val: $('cam-orbit-val') },
            pitch: { slider: $('cam-pitch-slider'), val: $('cam-pitch-val') },
            zoom: { slider: $('cam-zoom-slider'), val: $('cam-zoom-val') }
        };

        this.el = {
            btnPlay: $('btn-play'),
            canvasSpeedVal: $('canvas-speed-val'),
            autorunSpeedBox: $('autorun-speed-box'),
            totalDistTag: $('bottom-total-dist-tag'),
            hudRowLoad: $('hud-row-load'),
            btnManualMode: $('btn-manual-mode'),
            btnSettingsManual: $('btn-settings-manual'),
            hudRowZoom: $('hud-row-zoom'),
            courseName: $('course-name-display'),
            btnFullscreen: $('btn-fullscreen'),
            camFreeBtn: $('cam-free'),
            camAdjustBox: $('camera-adjust-box'),
            compassBtn: $('compass-btn'),
            compassDial: $('compass-dial'),
            btnGsiDem: $('btn-gsi-dem'),
            gsiBtnText: $('gsi-btn-text'),
            structureSummaryRow: $('structure-summary-row'),
            structureSummaryText: $('structure-summary-text'),
            modalStructures: $('modal-structures'),
            modalStructuresBody: $('modal-structures-body'),
            btnCloseStructures: $('btn-close-structures'),
            btnOkStructures: $('btn-ok-structures'),
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
     * DOMからの文字列逆読みを廃し、min/max/step/pxPerStepで疎結合に制御
     */
    bindScrubber(element, { min, max, step, pxPerStep, isEnabled = () => true, getValue, onInput }) {
        if (!element) return;
        let isDragging = false, startY = 0, startVal = 0;

        const clampRound = (val) => {
            const stepped = Math.round(val / step) * step;
            return clamp(Number(stepped.toFixed(2)), min, max);
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
        on(el.btnSettingsManual, 'click', () => cb.onToggleManualMode?.());
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
        this.bindScrubber(el.hudRowLoad, {
            min: 0, max: 7, step: 0.1, pxPerStep: 3,
            getValue: () => cb.getManualSlope?.() ?? 0.0,
            onInput: (v) => cb.onManualSlopeInput?.(v, true)
        });

        // 3. 上部HUD Zoom スクラバー
        this.bindScrubber(el.hudRowZoom, {
            min: 13.0, max: 18.0, step: 0.1, pxPerStep: 4,
            getValue: () => this.currentZoom,
            onInput: (v) => {
                this.syncCameraParams({ zoom: v });
                cb.onCameraParamChange?.({ zoom: v });
            }
        });

        // 4. フローティングダイアログ (カメラ / 設定) & カメラ操作
        this.bindDialog('btn-toggle-cam-dialog', 'btn-close-cam-dialog', 'camera-dialog');
        this.bindDialog('btn-modal-settings', 'btn-close-settings', 'modal-settings');
        on(el.camFreeBtn, 'click', () => cb.onToggleCameraFree?.());
        on(el.compassBtn, 'click', () => cb.onResetNorth?.());

        // 等高線・注視点 SHOW ボタン（初期非表示、押すと点灯して表示）
        [
            ['btn-toggle-contour', 'contour'],
            ['btn-toggle-fwd-marker', 'fwd'],
            ['btn-toggle-bwd-marker', 'bwd']
        ].forEach(([id, key]) => {
            const btn = $(id);
            let visible = btn?.classList.contains('active') ?? false;
            on(btn, 'click', () => {
                visible = !visible;
                btn?.classList.toggle('active', visible);
                cb.onToggleMarker?.(key, visible);
            });
        });

        // カメラ調整スライダー一括バインド (camControls と CAM_SLIDER_FORMATTERS を共有)
        for (const [key, ctrl] of Object.entries(this.camControls)) {
            on(ctrl.slider, 'input', (e) => {
                const v = parseFloat(e.target.value);
                this.syncCameraParams({ [key]: v });
                if (key === 'fwdMult' || key === 'bwdMult') {
                    cb.onVectorMultiplierChange?.({ [key]: v });
                } else {
                    cb.onCameraParamChange?.({ [key]: v });
                }
            });
        }

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
        on(el.structureSummaryRow, 'click', () => cb.onShowStructures?.());

        const closeStructModal = () => {
            if (el.modalStructures) el.modalStructures.style.display = 'none';
        };
        on(el.btnCloseStructures, 'click', closeStructModal);
        on(el.btnOkStructures, 'click', closeStructModal);
        on(el.modalStructures, 'click', (e) => {
            if (e.target === el.modalStructures) closeStructModal();
        });

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

        const summary = course.getStructureSummary?.() || { bridgeCount: 0, tunnelCount: 0, osmStatus: 'pending' };

        if (el.courseName) {
            const structTag = (summary.bridgeCount || summary.tunnelCount)
                ? ` [B:${summary.bridgeCount} T:${summary.tunnelCount}]`
                : '';
            const title = `${course.name}${course.isGsiCorrected ? ' [DEM10B]' : ''}${structTag}`;
            el.courseName.textContent = title;
            el.courseName.title = `${title} (${totalKm} km)`;
        }
        if (el.btnGsiDem) {
            el.btnGsiDem.style.display = course.isWithinJapan() ? 'flex' : 'none';
            el.btnGsiDem.classList.toggle('active', course.isGsiCorrected);
            el.btnGsiDem.classList.remove('loading');
            if (el.gsiBtnText) {
                el.gsiBtnText.textContent = course.isGsiCorrected ? '10mメッシュ＋構造物で再補正' : '10mメッシュ標高で補正';
            }
        }
        if (el.structureSummaryText) {
            const statusIcon = summary.osmStatus === 'ok' ? '🟢 OSM済' : summary.osmStatus === 'error' ? '🔴 OSM失敗' : '⏳ OSM照合中';
            el.structureSummaryText.textContent = `🌉 BRIDGE: ${summary.bridgeCount}箇所 / 🚇 TUNNEL: ${summary.tunnelCount}箇所 (${statusIcon})`;
        }
    }

    /**
     * 高度補正時またはサマリークリック時に BRIDGE / TUNNEL の検出数と詳細区間をダイアログ表示
     */
    showStructureDialog(course) {
        const { modalStructures, modalStructuresBody } = this.el;
        if (!modalStructures || !modalStructuresBody || !course) return;

        const s = course.getStructureSummary();
        const osmBadge = s.osmStatus === 'ok'
            ? `<span style="color:#4ade80;font-weight:700;">🟢 接続成功 (${s.osmSource || 'OSM API v0.6'})</span>`
            : s.osmStatus === 'error'
                ? `<span style="color:#f87171;font-weight:700;">🔴 OSM接続失敗</span>`
                : `<span style="color:#fbbf24;font-weight:700;">⏳ OSM照合中...</span>`;

        const formatList = (items, color) => {
            if (!items.length) {
                return `<div style="color:#64748b;font-size:11px;padding:2px 0 6px 6px;">該当なし (0箇所)</div>`;
            }
            const rows = items.map((r, i) => {
                const km0 = (r.d0 / 1000).toFixed(2);
                const km1 = (r.d1 / 1000).toFixed(2);
                const lenM = Math.round(r.d1 - r.d0);
                const alt0 = Math.round(course.sampleAtDist(r.d0).alt);
                const alt1 = Math.round(course.sampleAtDist(r.d1).alt);
                const nameLabel = r.name ? ` <span style="color:#cbd5e1;">[${r.name}]</span>` : '';
                return `<div style="display:flex;justify-content:space-between;padding:2px 6px;border-left:3px solid ${color};margin:2px 0;background:rgba(30,41,59,0.55);border-radius:0 4px 4px 0;font-size:11px;">
                    <span>#${i + 1} ${km0}〜${km1}km (${lenM}m)${nameLabel}</span>
                    <span style="color:#94a3b8;font-family:monospace;">${alt0}m→${alt1}m</span>
                </div>`;
            }).join('');
            return `<div style="margin:2px 0 6px 0;">${rows}</div>`;
        };

        modalStructuresBody.innerHTML = `
            <div style="margin-bottom:8px;padding:6px 8px;background:rgba(15,23,42,0.8);border-radius:6px;border:1px solid rgba(148,163,184,0.2);font-size:11px;line-height:1.4;">
                <div><strong>コース:</strong> ${course.name} (${(course.totalDistance / 1000).toFixed(2)} km)</div>
                <div><strong>OSM:</strong> ${osmBadge}</div>
                <div><strong>高度:</strong> ${course.isGsiCorrected ? '国土地理院 10m' : 'コース標高'} ＋ 端部直線維持</div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
                <div style="padding:6px;border-radius:6px;background:rgba(245,158,11,0.15);border:1px solid #f59e0b;text-align:center;">
                    <div style="font-size:10px;color:#fbbf24;font-weight:700;">🌉 BRIDGE (橋)</div>
                    <div style="font-size:18px;font-weight:800;color:#ffffff;">${s.bridgeCount} <span style="font-size:11px;font-weight:400;">箇所</span></div>
                </div>
                <div style="padding:6px;border-radius:6px;background:rgba(168,85,247,0.15);border:1px solid #a855f7;text-align:center;">
                    <div style="font-size:10px;color:#c084fc;font-weight:700;">🚇 TUNNEL (トンネル)</div>
                    <div style="font-size:18px;font-weight:800;color:#ffffff;">${s.tunnelCount} <span style="font-size:11px;font-weight:400;">箇所</span></div>
                </div>
            </div>
            <div style="font-weight:700;color:#fbbf24;font-size:11px;">🌉 BRIDGE (オレンジ / 端部直線維持)</div>
            ${formatList(s.bridges, '#f59e0b')}
            <div style="font-weight:700;color:#c084fc;font-size:11px;margin-top:4px;">🚇 TUNNEL (パープル / 端部直線維持)</div>
            ${formatList(s.tunnels, '#a855f7')}
        `;
        modalStructures.style.display = 'flex';
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
        this.el.btnSettingsManual?.classList.toggle('active', isManual);
    }

    updateLfoState(isRunning) {
        const { btnLfoToggle } = this.el;
        if (!btnLfoToggle) return;
        btnLfoToggle.textContent = 'AUTOSWEEP';
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

    /**
     * カメラパラメータ表示・スライダー・HUD・コンパスの同期を一元化
     */
    syncCameraParams(params = {}) {
        for (const [key, val] of Object.entries(params)) {
            if (typeof val !== 'number' || isNaN(val)) continue;
            if (key === 'bearing') {
                if (this.el.compassDial) this.el.compassDial.style.transform = `rotate(${-val}deg)`;
                continue;
            }
            if (key === 'zoom') {
                this.currentZoom = val;
                this.setHud({ zoom: CAM_SLIDER_FORMATTERS.zoom(val) });
            }
            const ctrl = this.camControls[key];
            const fmt = CAM_SLIDER_FORMATTERS[key];
            if (ctrl?.slider && Math.abs(parseFloat(ctrl.slider.value) - val) > 0.04) {
                ctrl.slider.value = val;
            }
            if (ctrl?.val && fmt) {
                ctrl.val.textContent = fmt(val);
            }
        }
    }
}
