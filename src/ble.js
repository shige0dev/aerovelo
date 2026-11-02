/**
 * Web Bluetooth API Manager for Smart Trainers & Cycling Sensors
 * Supports:
 * - FTMS (Fitness Machine Service: 0x1826) for Smart Trainers (Elite NERO, KICKR, Tacx, etc.)
 *   - Indoor Bike Data (0x2AD2): Power, Cadence, Speed
 *   - Fitness Machine Control Point (0x2AD9): Target Grade/Slope Simulation
 * - Cycling Power Service (0x1818): Fallback for Power Meters
 * - Cycling Speed & Cadence (0x1816): Fallback for Cadence Sensors
 */

export class BleTrainerManager {
    // Bluetooth GATT UUIDs (16-bit short aliases)
    static UUIDS = {
        // Services
        FTMS_SERVICE: 0x1826,
        CYCLING_POWER_SERVICE: 0x1818,
        CSC_SERVICE: 0x1816,

        // Characteristics
        INDOOR_BIKE_DATA: 0x2AD2,
        FITNESS_MACHINE_CONTROL_POINT: 0x2AD9,
        FITNESS_MACHINE_STATUS: 0x2ADA,
        CYCLING_POWER_MEASUREMENT: 0x2A63,
        CSC_MEASUREMENT: 0x2A5B
    };

    constructor() {
        this.device = null;
        this.server = null;
        this.controlPointChar = null;
        this.isConnected = false;
        this.hasControl = false;

        // リスナー（EventEmitter風）
        this.listeners = {
            data: [],
            connected: [],
            disconnected: [],
            error: []
        };

        // 最後に送信した斜度（過剰送信防止キャッシュ）
        this.lastSentSlope = null;
        this.lastSendTime = 0;

        // 累積距離（Total Distance）の初期オフセット管理
        this.initialDistanceMeters = null;
        this.lastTotalDistanceMeters = null;
    }

    on(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event].push(callback);
        }
    }

    emit(event, ...args) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => {
                try { cb(...args); } catch (e) { console.error('BLE listener error:', e); }
            });
        }
    }

    static isSupported() {
        return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
    }

    /**
     * Web Bluetooth デバイス選択ダイアログを開きペアリング
     */
    async connect() {
        if (!BleTrainerManager.isSupported()) {
            throw new Error('お使いのブラウザは Web Bluetooth API に対応していません。Chrome / Edge をご利用ください。');
        }

        try {
            console.log('BLE: Requesting device scan...');
            this.device = await navigator.bluetooth.requestDevice({
                filters: [
                    { services: [BleTrainerManager.UUIDS.FTMS_SERVICE] },
                    { services: [BleTrainerManager.UUIDS.CYCLING_POWER_SERVICE] },
                    { services: [BleTrainerManager.UUIDS.CSC_SERVICE] }
                ],
                optionalServices: [
                    BleTrainerManager.UUIDS.FTMS_SERVICE,
                    BleTrainerManager.UUIDS.CYCLING_POWER_SERVICE,
                    BleTrainerManager.UUIDS.CSC_SERVICE
                ]
            });

            this.device.addEventListener('gattserverdisconnected', () => {
                this.handleDisconnection();
            });

            console.log(`BLE: Connecting to GATT server on ${this.device.name}...`);
            this.server = await this.device.gatt.connect();
            this.isConnected = true;

            // FTMS または CPS のセットアップ
            await this.setupServices();

            this.emit('connected', {
                deviceName: this.device.name || 'スマートトレーナー',
                hasControl: this.hasControl
            });

            return {
                deviceName: this.device.name || 'スマートトレーナー',
                hasControl: this.hasControl
            };
        } catch (err) {
            this.handleDisconnection();
            throw err;
        }
    }

    async setupServices() {
        // 1. FTMS (Fitness Machine Service) 探索
        try {
            const ftms = await this.server.getPrimaryService(BleTrainerManager.UUIDS.FTMS_SERVICE);
            console.log('BLE: Found FTMS Service (0x1826)');

            // Indoor Bike Data (0x2AD2)
            try {
                const bikeDataChar = await ftms.getCharacteristic(BleTrainerManager.UUIDS.INDOOR_BIKE_DATA);
                await bikeDataChar.startNotifications();
                bikeDataChar.addEventListener('characteristicvaluechanged', (e) => this.handleIndoorBikeData(e));
                console.log('BLE: Subscribed to Indoor Bike Data (0x2AD2)');
            } catch (err) {
                console.warn('BLE: Could not subscribe to Indoor Bike Data:', err);
            }

            // Control Point (0x2AD9)
            try {
                this.controlPointChar = await ftms.getCharacteristic(BleTrainerManager.UUIDS.FITNESS_MACHINE_CONTROL_POINT);
                await this.controlPointChar.startNotifications();
                this.controlPointChar.addEventListener('characteristicvaluechanged', (e) => this.handleControlPointResponse(e));
                
                // Request Control コマンド送信 (OpCode: 0x00)
                await this.requestControl();
                this.hasControl = true;
                console.log('BLE: FTMS Control Point ready (0x2AD9)');
            } catch (err) {
                console.warn('BLE: Control Point not available or error requesting control:', err);
                this.hasControl = false;
            }
            return;
        } catch (err) {
            console.log('BLE: FTMS not found, trying Cycling Power Service...');
        }

        // 2. Cycling Power Service (0x1818) フォールバック
        try {
            const cps = await this.server.getPrimaryService(BleTrainerManager.UUIDS.CYCLING_POWER_SERVICE);
            const powerChar = await cps.getCharacteristic(BleTrainerManager.UUIDS.CYCLING_POWER_MEASUREMENT);
            await powerChar.startNotifications();
            powerChar.addEventListener('characteristicvaluechanged', (e) => this.handleCyclingPowerData(e));
            console.log('BLE: Subscribed to Cycling Power Service (0x1818)');
        } catch (err) {
            console.warn('BLE: Cycling Power Service not found:', err);
        }
    }

    /**
     * FTMS Request Control (OpCode 0x00)
     */
    async requestControl() {
        if (!this.controlPointChar) return;
        try {
            const cmd = new Uint8Array([0x00]);
            await this.controlPointChar.writeValueWithResponse(cmd);
            console.log('BLE: Sent Request Control (0x00)');
        } catch (err) {
            console.warn('BLE: Request Control error (may already be granted):', err);
        }
    }

    /**
     * FTMS Set Indoor Bike Simulation Parameters (OpCode: 0x11)
     * 風速0、転がり抵抗係数0.004、指定斜度を送信
     * @param {number} slopePercent 斜度（-8.0 〜 +8.0%）
     */
    async sendSlope(slopePercent) {
        if (!this.isConnected || !this.controlPointChar) return false;

        // 送信間隔の間引き（最低 800ms 間隔、かつ値変化 0.2% 以上の時のみ送信してBluetooth負荷軽減）
        const now = performance.now();
        const clampedSlope = Math.max(-8.0, Math.min(8.0, slopePercent));
        if (this.lastSentSlope !== null) {
            if (Math.abs(this.lastSentSlope - clampedSlope) < 0.2 && (now - this.lastSendTime) < 2500) {
                return false;
            }
            if ((now - this.lastSendTime) < 800) {
                return false;
            }
        }

        try {
            // FTMS 0x11 (Set Indoor Bike Simulation)
            // Format:
            // Byte 0: OpCode (0x11)
            // Byte 1-2: Wind Speed (int16, 0.001 m/s) -> 0
            // Byte 3-4: Grade (int16, 0.01 % resolution) -> slope * 100
            // Byte 5: Crr (uint8, 0.0001) -> 40 (0.004)
            // Byte 6: Cw (uint8, 0.01 kg/m) -> 51 (0.51 kg/m)
            const buffer = new ArrayBuffer(7);
            const view = new DataView(buffer);
            view.setUint8(0, 0x11); // OpCode: Simulation Parameters
            view.setInt16(1, 0, true); // Wind Speed = 0
            view.setInt16(3, Math.round(clampedSlope * 100), true); // Grade in 0.01%
            view.setUint8(5, 40); // Crr: 0.0040
            view.setUint8(6, 51); // Cw: 0.51

            await this.controlPointChar.writeValueWithResponse(new Uint8Array(buffer));
            this.lastSentSlope = clampedSlope;
            this.lastSendTime = now;
            console.log(`BLE: Target Slope sent -> ${clampedSlope.toFixed(1)}%`);
            return true;
        } catch (err) {
            console.warn('BLE: Error sending target slope:', err);
            return false;
        }
    }

    /**
     * FTMS Indoor Bike Data (0x2AD2) のデコード
     */
    handleIndoorBikeData(event) {
        const value = event.target.value;
        if (!value || value.byteLength < 4) return;

        const flags = value.getUint16(0, true);
        let offset = 2;

        let speedKmh = null;
        let cadenceRpm = null;
        let powerWatts = null;

        // Flag bit 0: More Data (0 = Instantaneous Speed present)
        const hasInstantSpeed = (flags & (1 << 0)) === 0;
        if (hasInstantSpeed && value.byteLength >= offset + 2) {
            speedKmh = value.getUint16(offset, true) * 0.01; // 0.01 km/h
            offset += 2;
        }

        // Flag bit 1: Average Speed present (skip if present)
        if (flags & (1 << 1)) offset += 2;

        // Flag bit 2: Instantaneous Cadence present
        // Eliteスマートトレーナー(NERO等)は標準0.5rpmではなく1rpm整数の生値を送信するためそのまま採用
        if (flags & (1 << 2)) {
            if (value.byteLength >= offset + 2) {
                cadenceRpm = value.getUint16(offset, true); // 1 rpm
                offset += 2;
            }
        }

        // Flag bit 3: Average Cadence
        if (flags & (1 << 3)) offset += 2;

        // Flag bit 4: Total Distance (uint24, 3 bytes, resolution: 1 meter)
        let totalDistanceMeters = null;
        if (flags & (1 << 4)) {
            if (value.byteLength >= offset + 3) {
                const b0 = value.getUint8(offset);
                const b1 = value.getUint8(offset + 1);
                const b2 = value.getUint8(offset + 2);
                totalDistanceMeters = b0 | (b1 << 8) | (b2 << 16);
                offset += 3;

                // セッション開始時の初期オフセットを記録し、今回のライドでの増分（delta）を計算
                if (this.initialDistanceMeters === null) {
                    this.initialDistanceMeters = totalDistanceMeters;
                }
                this.lastTotalDistanceMeters = totalDistanceMeters;
            }
        }

        // Flag bit 5: Resistance Level
        if (flags & (1 << 5)) offset += 2;

        // Flag bit 6: Instantaneous Power
        if (flags & (1 << 6)) {
            if (value.byteLength >= offset + 2) {
                powerWatts = value.getInt16(offset, true); // 1 Watt
                offset += 2;
            }
        }

        // 今回のセッションでの累積走行距離（増分）
        const sessionDistanceMeters = (totalDistanceMeters !== null && this.initialDistanceMeters !== null)
            ? Math.max(0, totalDistanceMeters - this.initialDistanceMeters)
            : null;

        this.emit('data', {
            power: powerWatts !== null ? Math.max(0, powerWatts) : null,
            cadence: cadenceRpm !== null ? Math.round(cadenceRpm) : null,
            speed: speedKmh !== null ? Math.round(speedKmh * 10) / 10 : null,
            totalDistanceMeters: totalDistanceMeters,
            sessionDistanceMeters: sessionDistanceMeters
        });
    }

    /**
     * Cycling Power Measurement (0x2A63) のデコード（フォールバック用）
     */
    handleCyclingPowerData(event) {
        const value = event.target.value;
        if (!value || value.byteLength < 4) return;
        const flags = value.getUint16(0, true);
        const powerWatts = value.getInt16(2, true);

        this.emit('data', {
            power: Math.max(0, powerWatts),
            cadence: null,
            speed: null
        });
    }

    handleControlPointResponse(event) {
        const value = event.target.value;
        if (value && value.byteLength >= 3) {
            const opCode = value.getUint8(0);
            const reqOpCode = value.getUint8(1);
            const resultCode = value.getUint8(2);
            // 0x80 = Response Code, resultCode: 0x01 = Success
            if (opCode === 0x80 && resultCode === 0x01) {
                // Successful control point execution
            }
        }
    }

    async disconnect() {
        if (this.device && this.device.gatt.connected) {
            console.log('BLE: Disconnecting...');
            this.device.gatt.disconnect();
        }
        this.handleDisconnection();
    }

    handleDisconnection() {
        this.isConnected = false;
        this.hasControl = false;
        this.controlPointChar = null;
        this.lastSentSlope = null;
        this.initialDistanceMeters = null;
        this.lastTotalDistanceMeters = null;
        this.emit('disconnected');
        console.log('BLE: Disconnected');
    }

    /**
     * セッションの累積距離カウンターを0リセット
     */
    resetDistance() {
        if (this.lastTotalDistanceMeters !== null) {
            this.initialDistanceMeters = this.lastTotalDistanceMeters;
        } else {
            this.initialDistanceMeters = null;
        }
    }
}

