/**
 * UI & DOM Event Controller
 * Encapsulates all DOM queries, HUD/Bottom-bar updates, modals, sliders, and GPX drag-and-drop.
 */

export class UIController {
    constructor(callbacks = {}) {
        this.cb = callbacks;
        this.initElements();
        this.bindEvents();
    }

    initElements() {
        // Bottom Bar Elements
        this.btnPlay = document.getElementById('btn-play');
        this.rowSpeed = document.getElementById('row-speed');
        this.speedVal = document.getElementById('speed-val');
        this.speedEditHint = document.getElementById('speed-edit-hint');

        this.valPower = document.getElementById('val-power');
        this.valCadence = document.getElementById('val-cadence');

        this.elCourseNameDisplay = document.getElementById('course-name-display');
        this.btnModalSettings = document.getElementById('btn-modal-settings');
        this.btnFullscreen = document.getElementById('btn-fullscreen');
        this.btnToggleCamDialog = document.getElementById('btn-toggle-cam-dialog');

        this.bottomAltDisplay = document.getElementById('bottom-alt-display');
        this.bottomSlopeDisplay = document.getElementById('bottom-slope-display');
        this.bottomDistDisplay = document.getElementById('bottom-dist-display');
        this.bottomTotalDistTag = document.getElementById('bottom-total-dist-tag');

        this.vSlopeSlider = document.getElementById('v-slope-slider');
        this.vSlopeVal = document.getElementById('v-slope-val');

        // Camera Dialog
        this.cameraDialog = document.getElementById('camera-dialog');
        this.btnCloseCamDialog = document.getElementById('btn-close-cam-dialog');
        this.camFreeBtn = document.getElementById('cam-free');
        this.camAdjustBox = document.getElementById('camera-adjust-box');
        this.camOrbitSlider = document.getElementById('cam-orbit-slider');
        this.camOrbitVal = document.getElementById('cam-orbit-val');
        this.camPitchSlider = document.getElementById('cam-pitch-slider');
        this.camPitchVal = document.getElementById('cam-pitch-val');
        this.camZoomSlider = document.getElementById('cam-zoom-slider');
        this.camZoomVal = document.getElementById('cam-zoom-val');

        // Settings Floating Dialog
        this.modalSettings = document.getElementById('modal-settings');
        this.btnCloseSettings = document.getElementById('btn-close-settings');
        this.presetSelect = document.getElementById('preset-select');
        this.dropZone = document.getElementById('drop-zone');
        this.fileInput = document.getElementById('gpx-file-input');
        this.btnBrowse = document.getElementById('btn-browse');
        this.btnGsiDem = document.getElementById('btn-gsi-dem');
        this.gsiBtnText = document.getElementById('gsi-btn-text');

        this.btnBleConnect = document.getElementById('btn-ble-connect');
        this.btnBleDisconnect = document.getElementById('btn-ble-disconnect');
        this.bleStatusText = document.getElementById('ble-status-text');

        this.testSlopeSlider = document.getElementById('test-slope-slider');
        this.testSlopeVal = document.getElementById('test-slope-val');
        this.btnLfoToggle = document.getElementById('btn-lfo-toggle');
        this.lfoPeriodSelect = document.getElementById('lfo-period-select');
    }

    /**
     * 行要素の上下ドラッグ＆ホイール操作を汎用登録するヘルパー
     */
    setupVerticalDrag(element, { isEnabled, getInitialValue, onDragChange, onWheelDelta, ignoreTarget }) {
        if (!element) return;
        let isDragging = false;
        let startY = 0;
        let startVal = 0;

        const onPointerDown = (clientY) => {
            if (!isEnabled()) return;
            isDragging = true;
            startY = clientY;
            startVal = getInitialValue();
            document.body.style.userSelect = 'none';
        };

        const onPointerMove = (clientY) => {
            if (!isDragging || !isEnabled()) return;
            const deltaY = startY - clientY;
            onDragChange(startVal, deltaY);
        };

        const onPointerUp = () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.userSelect = '';
            }
        };

        element.addEventListener('mousedown', (e) => {
            if (ignoreTarget && e.target === ignoreTarget) return;
            onPointerDown(e.clientY);
            const moveHandler = (moveEvent) => onPointerMove(moveEvent.clientY);
            const upHandler = () => {
                onPointerUp();
                window.removeEventListener('mousemove', moveHandler);
                window.removeEventListener('mouseup', upHandler);
            };
            window.addEventListener('mousemove', moveHandler);
            window.addEventListener('mouseup', upHandler);
        });

        element.addEventListener('touchstart', (e) => {
            if (e.touches.length > 0 && (!ignoreTarget || e.target !== ignoreTarget)) {
                onPointerDown(e.touches[0].clientY);
            }
        }, { passive: true });

        element.addEventListener('touchmove', (e) => {
            if (isDragging && e.touches.length > 0) {
                onPointerMove(e.touches[0].clientY);
            }
        }, { passive: true });

        element.addEventListener('touchend', onPointerUp);
        element.addEventListener('touchcancel', onPointerUp);

        element.addEventListener('wheel', (e) => {
            if (!isEnabled()) return;
            e.preventDefault();
            onWheelDelta(e.deltaY < 0 ? 1 : -1);
        }, { passive: false });
    }

    bindEvents() {
        // Play / Pause
        if (this.btnPlay) {
            this.btnPlay.addEventListener('click', () => {
                if (this.cb.onTogglePlay) this.cb.onTogglePlay();
            });
        }

        if (this.vSlopeSlider) {
            this.vSlopeSlider.addEventListener('input', (e) => {
                if (this.cb.onManualSlopeInput) {
                    this.cb.onManualSlopeInput(parseFloat(e.target.value), true);
                }
            });
        }

        if (this.testSlopeSlider) {
            this.testSlopeSlider.addEventListener('input', (e) => {
                if (this.cb.onManualSlopeInput) {
                    this.cb.onManualSlopeInput(parseFloat(e.target.value), true);
                }
            });
        }

        // LFO Scan Controls
        if (this.btnLfoToggle) {
            this.btnLfoToggle.addEventListener('click', () => {
                if (this.cb.onToggleLfo) this.cb.onToggleLfo();
            });
        }

        if (this.lfoPeriodSelect) {
            this.lfoPeriodSelect.addEventListener('change', (e) => {
                if (this.cb.onLfoPeriodChange) {
                    this.cb.onLfoPeriodChange(parseFloat(e.target.value) || 60);
                }
            });
        }

        // Vertical Drag on Speed item (AUTOPLAY時のみ有効)
        this.setupVerticalDrag(this.rowSpeed, {
            isEnabled: () => this.cb.isPlaying ? this.cb.isPlaying() : false,
            getInitialValue: () => this.cb.getSpeed ? this.cb.getSpeed() : 25,
            onDragChange: (startSpeed, deltaY) => {
                const nextSpeed = Math.max(1, Math.min(80, startSpeed + Math.round(deltaY / 4)));
                if (this.cb.onSpeedChange) this.cb.onSpeedChange(nextSpeed);
            },
            onWheelDelta: (dir) => {
                const cur = this.cb.getSpeed ? this.cb.getSpeed() : 25;
                const nextSpeed = Math.max(1, Math.min(80, cur + dir));
                if (this.cb.onSpeedChange) this.cb.onSpeedChange(nextSpeed);
            },
            ignoreTarget: this.btnPlay
        });

        // Camera Dialog & Sliders
        if (this.btnToggleCamDialog && this.cameraDialog) {
            this.btnToggleCamDialog.addEventListener('click', () => {
                const isHidden = (this.cameraDialog.style.display === 'none' || !this.cameraDialog.style.display);
                this.cameraDialog.style.display = isHidden ? 'flex' : 'none';
                this.btnToggleCamDialog.classList.toggle('active', isHidden);
            });
        }

        if (this.btnCloseCamDialog && this.cameraDialog) {
            this.btnCloseCamDialog.addEventListener('click', () => {
                this.cameraDialog.style.display = 'none';
                if (this.btnToggleCamDialog) this.btnToggleCamDialog.classList.remove('active');
            });
        }

        if (this.camFreeBtn) {
            this.camFreeBtn.addEventListener('click', () => {
                if (this.cb.onToggleCameraFree) this.cb.onToggleCameraFree();
            });
        }

        if (this.camPitchSlider) {
            this.camPitchSlider.addEventListener('input', (e) => {
                const pitch = parseFloat(e.target.value);
                if (this.camPitchVal) this.camPitchVal.textContent = `${Math.round(pitch)}°`;
                if (this.cb.onCameraParamChange) this.cb.onCameraParamChange({ pitch });
            });
        }

        if (this.camZoomSlider) {
            this.camZoomSlider.addEventListener('input', (e) => {
                const zoom = parseFloat(e.target.value);
                if (this.camZoomVal) this.camZoomVal.textContent = zoom.toFixed(1);
                if (this.cb.onCameraParamChange) this.cb.onCameraParamChange({ zoom });
            });
        }

        if (this.camOrbitSlider) {
            this.camOrbitSlider.addEventListener('input', (e) => {
                const orbitAngleOffset = parseFloat(e.target.value);
                if (this.camOrbitVal) {
                    const sign = orbitAngleOffset > 0 ? '+' : '';
                    this.camOrbitVal.textContent = orbitAngleOffset === 0 ? '0°' : `${sign}${Math.round(orbitAngleOffset)}°`;
                }
                if (this.cb.onCameraParamChange) this.cb.onCameraParamChange({ orbitAngleOffset });
            });
        }

        // Settings Floating Dialog
        if (this.btnModalSettings && this.modalSettings) {
            this.btnModalSettings.addEventListener('click', () => {
                const isHidden = (this.modalSettings.style.display === 'none' || !this.modalSettings.style.display);
                this.modalSettings.style.display = isHidden ? 'flex' : 'none';
                this.btnModalSettings.classList.toggle('active', isHidden);
            });
        }

        if (this.btnCloseSettings && this.modalSettings) {
            this.btnCloseSettings.addEventListener('click', () => {
                this.modalSettings.style.display = 'none';
                if (this.btnModalSettings) this.btnModalSettings.classList.remove('active');
            });
        }

        if (this.btnFullscreen) {
            this.btnFullscreen.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(err => console.warn('Fullscreen error:', err));
                } else {
                    document.exitFullscreen().catch(err => console.warn('Exit fullscreen error:', err));
                }
            });

            document.addEventListener('fullscreenchange', () => {
                const isFs = !!document.fullscreenElement;
                this.btnFullscreen.textContent = isFs ? '⤓' : '⛶';
                this.btnFullscreen.title = isFs ? '全画面解除 (Esc)' : '全画面表示 (F11)';
                if (this.cb.onFullscreenChange) this.cb.onFullscreenChange();
            });
        }

        // BLE Connect / Disconnect
        if (this.btnBleConnect) {
            this.btnBleConnect.addEventListener('click', () => {
                if (this.cb.onBleConnect) this.cb.onBleConnect();
            });
        }

        if (this.btnBleDisconnect) {
            this.btnBleDisconnect.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.cb.onBleDisconnect) this.cb.onBleDisconnect();
            });
        }

        // GPX Importer & GSI 5m DEM
        if (this.presetSelect) {
            this.presetSelect.addEventListener('change', (e) => {
                if (this.cb.onSelectPreset) this.cb.onSelectPreset(e.target.value);
            });
        }

        if (this.btnBrowse && this.fileInput) {
            this.btnBrowse.addEventListener('click', (e) => {
                e.stopPropagation();
                this.fileInput.click();
            });
            this.fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file && this.cb.onLoadGpxFile) this.cb.onLoadGpxFile(file);
            });
        }

        const gpxSection = this.dropZone ? this.dropZone.closest('.gpx-section-frameless') : null;
        if (gpxSection) {
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
                const file = e.dataTransfer?.files?.[0];
                if (file) {
                    if (file.name.toLowerCase().endsWith('.gpx')) {
                        if (this.cb.onLoadGpxFile) this.cb.onLoadGpxFile(file);
                    } else {
                        alert('.gpx 拡張子のファイルを選択してください。');
                    }
                }
            });
        }

        if (this.btnGsiDem) {
            this.btnGsiDem.addEventListener('click', () => {
                if (this.cb.onRequestGsiDem) this.cb.onRequestGsiDem();
            });
        }
    }

    // --- UI Rendering / State Update Methods ---

    updateCourseMeta(course, currentProgress) {
        const totalKm = (course.totalDistance / 1000).toFixed(2);
        if (this.bottomTotalDistTag) {
            this.bottomTotalDistTag.textContent = `全長 ${totalKm}km`;
        }
        if (this.bottomDistDisplay) {
            const curDistKm = ((currentProgress * course.totalDistance) / 1000).toFixed(2);
            this.bottomDistDisplay.textContent = `${curDistKm}km`;
        }
        if (this.elCourseNameDisplay) {
            const statusTag = course.isGsiCorrected ? ' [DEM5A]' : '';
            this.elCourseNameDisplay.textContent = `${course.name}${statusTag}`;
            this.elCourseNameDisplay.title = `${course.name}${statusTag} (${totalKm} km)`;
        }
        if (this.btnGsiDem) {
            const isJapan = course.isWithinJapan();
            this.btnGsiDem.style.display = isJapan ? 'flex' : 'none';
            if (course.isGsiCorrected) {
                this.btnGsiDem.classList.add('active');
                this.btnGsiDem.classList.remove('loading');
                this.gsiBtnText.textContent = '5mメッシュ補正済 (DEM5A)';
            } else {
                this.btnGsiDem.classList.remove('active', 'loading');
                this.gsiBtnText.textContent = '5mメッシュ標高で補正';
            }
        }
    }

    setGsiLoading(isLoading, pct = 0) {
        if (!this.btnGsiDem || !this.gsiBtnText) return;
        this.btnGsiDem.classList.toggle('loading', isLoading);
        if (isLoading) {
            this.gsiBtnText.textContent = `DEM取得中 ${pct}%...`;
        }
    }

    updatePlayState(isPlaying) {
        if (this.btnPlay) {
            this.btnPlay.textContent = isPlaying ? '❚❚' : '▶';
            this.btnPlay.title = isPlaying ? '一時停止 (Pause)' : '自動再生 (Auto Fly)';
            this.btnPlay.classList.toggle('running', isPlaying);
        }
        if (this.rowSpeed) {
            this.rowSpeed.classList.toggle('editable', isPlaying);
            if (this.speedEditHint) {
                this.speedEditHint.style.display = isPlaying ? 'inline' : 'none';
            }
        }
    }

    updateManualModeState(isManual) {
        // メインメニューからの負荷行は消去済み
    }

    updateManualSlopeControls(slope) {
        if (this.testSlopeSlider) this.testSlopeSlider.value = slope;
        if (this.testSlopeVal) {
            const s = slope > 0 ? '+' : '';
            this.testSlopeVal.textContent = `${s}${slope.toFixed(1)} %`;
        }
        if (this.vSlopeSlider) this.vSlopeSlider.value = slope;
        if (this.vSlopeVal) this.vSlopeVal.textContent = `${slope.toFixed(1)}%`;
    }

    updateLfoState(isRunning) {
        if (this.btnLfoToggle) {
            this.btnLfoToggle.textContent = isRunning ? 'スキャン停止' : '連続スキャン';
            this.btnLfoToggle.classList.toggle('running', isRunning);
        }
    }

    updateTrainerSlopeDisplay(clampedSlope) {
        if (this.vSlopeSlider) this.vSlopeSlider.value = clampedSlope;
        if (this.vSlopeVal) this.vSlopeVal.textContent = `${clampedSlope.toFixed(1)}%`;
        if (this.testSlopeSlider) this.testSlopeSlider.value = clampedSlope;
        if (this.testSlopeVal) {
            const s = clampedSlope > 0 ? '+' : '';
            this.testSlopeVal.textContent = `${s}${clampedSlope.toFixed(1)} %`;
        }
    }

    updateMetrics(state, speedKmh) {
        const distKm = (state.distance / 1000).toFixed(2);
        const sign = state.slope >= 0 ? '+' : '';
        const slopeFormatted = `${sign}${state.slope.toFixed(1)}`;

        if (this.bottomAltDisplay) {
            this.bottomAltDisplay.textContent = `${state.alt.toFixed(1)}`;
        }
        if (this.bottomSlopeDisplay) {
            this.bottomSlopeDisplay.textContent = slopeFormatted;
            if (state.slope > 7) {
                this.bottomSlopeDisplay.style.color = 'var(--climb-color)';
            } else if (state.slope < 0) {
                this.bottomSlopeDisplay.style.color = 'var(--descent-color)';
            } else {
                this.bottomSlopeDisplay.style.color = '#cbd5e1';
            }
        }
        if (this.bottomDistDisplay) {
            this.bottomDistDisplay.textContent = distKm;
        }
        if (this.speedVal) {
            this.speedVal.textContent = `${speedKmh.toFixed(1)}`;
        }
    }

    updateBleMetrics({ power, cadence, speed }) {
        if (power !== null && power !== undefined && this.valPower) {
            this.valPower.textContent = `${Math.round(power)}`;
        }
        if (cadence !== null && cadence !== undefined && this.valCadence) {
            this.valCadence.textContent = `${Math.round(cadence)}`;
        }
        if (speed !== null && speed !== undefined && this.speedVal) {
            this.speedVal.textContent = `${Number(speed).toFixed(1)}`;
        }
    }

    updateBleConnectionState(state, deviceName = '') {
        if (!this.btnBleConnect || !this.bleStatusText) return;
        if (state === 'connecting') {
            this.bleStatusText.textContent = 'ペアリング中...';
        } else if (state === 'connected') {
            this.btnBleConnect.classList.add('connected');
            this.bleStatusText.textContent = `🟢 ${deviceName}`;
            if (this.btnBleDisconnect) this.btnBleDisconnect.style.display = 'flex';
        } else {
            this.btnBleConnect.classList.remove('connected');
            this.bleStatusText.textContent = '⚡ スマートトレーナー接続';
            if (this.btnBleDisconnect) this.btnBleDisconnect.style.display = 'none';
            if (this.valPower) this.valPower.textContent = '---';
            if (this.valCadence) this.valCadence.textContent = '---';
        }
    }

    updateCameraModeUI(isFree) {
        if (this.camFreeBtn) {
            this.camFreeBtn.classList.toggle('active', isFree);
        }
        if (this.camAdjustBox) {
            this.camAdjustBox.classList.toggle('disabled', isFree);
            this.camAdjustBox.querySelectorAll('input').forEach(input => {
                input.disabled = isFree;
            });
        }
    }
}
