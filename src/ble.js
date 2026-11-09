/**
 * Web Bluetooth API Manager for Smart Trainers & Cycling Sensors
 * Supports FTMS (0x1826), Cycling Power (0x1818), and CSC Speed/Cadence Sensors (0x1816).
 */

export class BleTrainerManager {
    static UUIDS = {
        FTMS_SERVICE: 0x1826,
        CYCLING_POWER_SERVICE: 0x1818,
        CSC_SERVICE: 0x1816,
        INDOOR_BIKE_DATA: 0x2AD2,
        FITNESS_MACHINE_CONTROL_POINT: 0x2AD9,
        CYCLING_POWER_MEASUREMENT: 0x2A63,
        CSC_MEASUREMENT: 0x2A5B
    };

    constructor() {
        this.device = null;
        this.server = null;
        this.controlPointChar = null;
        this.isConnected = false;
        this.hasControl = false;
        this.mode = 'trainer'; // 'trainer' | 'speed' | 'cadence'
        this.wheelCircumferenceMm = 2105; // 700x25C 標準周長 (mm)
        this.listeners = { data: [], connected: [], disconnected: [] };
        this.lastSentSlope = null;
        this.lastSendTime = 0;
        this.resetCscAndDistanceState();
    }

    resetCscAndDistanceState() {
        this.initialDistanceMeters = null;
        this.lastTotalDistanceMeters = null;
        this.initialWheelRevs = null;
        this.lastTotalWheelRevs = null;
        this.prevWheelRevs = null;
        this.prevWheelTime = null;
        this.lastWheelMoveTime = 0;
        this.lastCscSpeed = 0;
        this.prevCrankRevs = null;
        this.prevCrankTime = null;
        this.lastCrankMoveTime = 0;
        this.lastCscCadence = 0;
    }

    setMode(mode) {
        this.mode = mode;
    }

    setWheelCircumference(mm) {
        const val = Number(mm);
        if (!isNaN(val) && val >= 1000 && val <= 3000) {
            this.wheelCircumferenceMm = Math.round(val);
        }
    }

    on(event, callback) {
        this.listeners[event]?.push(callback);
    }

    emit(event, ...args) {
        this.listeners[event]?.forEach((cb) => {
            try { cb(...args); } catch (e) { console.error('BLE listener error:', e); }
        });
    }

    static isSupported() {
        return !!(navigator.bluetooth?.requestDevice);
    }

    async connect(mode = this.mode) {
        if (!BleTrainerManager.isSupported()) {
            throw new Error('お使いのブラウザは Web Bluetooth API に対応していません。Chrome / Edge をご利用ください。');
        }

        this.mode = mode;

        try {
            const { FTMS_SERVICE, CYCLING_POWER_SERVICE, CSC_SERVICE } = BleTrainerManager.UUIDS;
            const isCscMode = mode === 'speed' || mode === 'cadence';
            const filters = isCscMode
                ? [{ services: [CSC_SERVICE] }]
                : [{ services: [FTMS_SERVICE] }, { services: [CYCLING_POWER_SERVICE] }];
            const optionalServices = isCscMode
                ? [CSC_SERVICE]
                : [FTMS_SERVICE, CYCLING_POWER_SERVICE, CSC_SERVICE];

            this.device = await navigator.bluetooth.requestDevice({ filters, optionalServices });

            this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnection());
            this.server = await this.device.gatt.connect();
            this.isConnected = true;
            this.resetCscAndDistanceState();

            await this.setupServices(isCscMode);
            const fallbackLabel = mode === 'speed' ? 'スピードセンサー' : mode === 'cadence' ? 'ケイデンスセンサー' : 'スマートトレーナー';
            const info = { deviceName: this.device.name || fallbackLabel, hasControl: this.hasControl, mode: this.mode };
            this.emit('connected', info);
            return info;
        } catch (err) {
            this.handleDisconnection();
            throw err;
        }
    }

    async setupServices(isCscMode = false) {
        const {
            FTMS_SERVICE, INDOOR_BIKE_DATA, FITNESS_MACHINE_CONTROL_POINT,
            CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT,
            CSC_SERVICE, CSC_MEASUREMENT
        } = BleTrainerManager.UUIDS;

        // CSC (Speed / Cadence Sensor) モード時
        if (isCscMode) {
            const csc = await this.server.getPrimaryService(CSC_SERVICE);
            const cscChar = await csc.getCharacteristic(CSC_MEASUREMENT);
            await cscChar.startNotifications();
            cscChar.addEventListener('characteristicvaluechanged', (e) => this.handleCscData(e));
            this.hasControl = false;
            return;
        }

        // 1. FTMS (Fitness Machine Service)
        try {
            const ftms = await this.server.getPrimaryService(FTMS_SERVICE);
            try {
                const bikeDataChar = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
                await bikeDataChar.startNotifications();
                bikeDataChar.addEventListener('characteristicvaluechanged', (e) => this.handleIndoorBikeData(e));
            } catch (err) {
                console.warn('BLE: Could not subscribe to Indoor Bike Data:', err);
            }

            try {
                this.controlPointChar = await ftms.getCharacteristic(FITNESS_MACHINE_CONTROL_POINT);
                await this.controlPointChar.startNotifications();
                await this.controlPointChar.writeValueWithResponse(new Uint8Array([0x00])); // Request Control
                this.hasControl = true;
            } catch (err) {
                console.warn('BLE: Control Point error:', err);
                this.hasControl = false;
            }
            return;
        } catch {
            // FTMS非対応時は Cycling Power Service へフォールバック
        }

        // 2. Cycling Power Service (0x1818)
        try {
            const cps = await this.server.getPrimaryService(CYCLING_POWER_SERVICE);
            const powerChar = await cps.getCharacteristic(CYCLING_POWER_MEASUREMENT);
            await powerChar.startNotifications();
            powerChar.addEventListener('characteristicvaluechanged', (e) => this.handleCyclingPowerData(e));
        } catch (err) {
            console.warn('BLE: Cycling Power Service not found:', err);
        }
    }

    async sendSlope(slopePercent) {
        if (!this.isConnected || !this.controlPointChar) return false;

        const now = performance.now();
        const clampedSlope = Math.max(-8.0, Math.min(8.0, slopePercent));
        if (this.lastSentSlope !== null) {
            if (Math.abs(this.lastSentSlope - clampedSlope) < 0.2 && (now - this.lastSendTime) < 2500) return false;
            if ((now - this.lastSendTime) < 800) return false;
        }

        try {
            // FTMS 0x11: [OpCode=0x11, WindSpeed(int16)=0, Grade(int16, 0.01%), Crr=40(0.004), Cw=51(0.51)]
            const buffer = new ArrayBuffer(7);
            const view = new DataView(buffer);
            view.setUint8(0, 0x11);
            view.setInt16(1, 0, true);
            view.setInt16(3, Math.round(clampedSlope * 100), true);
            view.setUint8(5, 40);
            view.setUint8(6, 51);

            await this.controlPointChar.writeValueWithResponse(new Uint8Array(buffer));
            this.lastSentSlope = clampedSlope;
            this.lastSendTime = now;
            return true;
        } catch (err) {
            console.warn('BLE: Error sending target slope:', err);
            return false;
        }
    }

    handleIndoorBikeData(event) {
        const value = event.target.value;
        if (!value || value.byteLength < 4) return;

        const flags = value.getUint16(0, true);
        let offset = 2;
        let speedKmh = null, cadenceRpm = null, powerWatts = null, totalDistanceMeters = null;

        if ((flags & (1 << 0)) === 0 && value.byteLength >= offset + 2) {
            speedKmh = value.getUint16(offset, true) * 0.01;
            offset += 2;
        }
        if (flags & (1 << 1)) offset += 2; // Average Speed
        if ((flags & (1 << 2)) && value.byteLength >= offset + 2) {
            cadenceRpm = value.getUint16(offset, true); // Elite NERO raw 1 rpm
            offset += 2;
        }
        if (flags & (1 << 3)) offset += 2; // Average Cadence
        if ((flags & (1 << 4)) && value.byteLength >= offset + 3) {
            totalDistanceMeters = value.getUint8(offset) | (value.getUint8(offset + 1) << 8) | (value.getUint8(offset + 2) << 16);
            offset += 3;
            if (this.initialDistanceMeters === null) this.initialDistanceMeters = totalDistanceMeters;
            this.lastTotalDistanceMeters = totalDistanceMeters;
        }
        if (flags & (1 << 5)) offset += 2; // Resistance Level
        if ((flags & (1 << 6)) && value.byteLength >= offset + 2) {
            powerWatts = value.getInt16(offset, true);
        }

        const sessionDistanceMeters = (totalDistanceMeters !== null && this.initialDistanceMeters !== null)
            ? Math.max(0, totalDistanceMeters - this.initialDistanceMeters)
            : null;

        this.emit('data', {
            power: powerWatts !== null ? Math.max(0, powerWatts) : null,
            cadence: cadenceRpm !== null ? Math.round(cadenceRpm) : null,
            speed: speedKmh !== null ? Math.round(speedKmh * 10) / 10 : null,
            totalDistanceMeters,
            sessionDistanceMeters
        });
    }

    handleCyclingPowerData(event) {
        const value = event.target.value;
        if (!value || value.byteLength < 4) return;
        this.emit('data', { power: Math.max(0, value.getInt16(2, true)), cadence: null, speed: null, sessionDistanceMeters: null });
    }

    /**
     * CSC (0x1816 / 0x2A5B) スピードセンサー・ケイデンスセンサー計測値のデコード
     */
    handleCscData(event) {
        const value = event.target.value;
        if (!value || value.byteLength < 1) return;

        const now = performance.now();
        const flags = value.getUint8(0);
        let offset = 1;

        let speedKmh = null;
        let cadenceRpm = null;
        let sessionDistanceMeters = null;

        // Bit 0: Wheel Revolution Data Present (スピードセンサー)
        if ((flags & 0x01) && value.byteLength >= offset + 6) {
            const cumWheelRevs = value.getUint32(offset, true);
            const lastWheelTime = value.getUint16(offset + 4, true); // 1/1024秒単位
            offset += 6;

            if (this.initialWheelRevs === null) {
                this.initialWheelRevs = cumWheelRevs;
                this.prevWheelRevs = cumWheelRevs;
                this.prevWheelTime = lastWheelTime;
                this.lastWheelMoveTime = now;
            } else {
                const dRevs = cumWheelRevs - this.prevWheelRevs;
                const dTime = (lastWheelTime - this.prevWheelTime + 65536) % 65536;
                if (dTime > 0 && dRevs >= 0 && dRevs < 100) {
                    const circM = this.wheelCircumferenceMm / 1000;
                    const dtSec = dTime / 1024;
                    speedKmh = ((dRevs * circM) / dtSec) * 3.6;
                    this.lastCscSpeed = speedKmh;
                    this.lastWheelMoveTime = now;
                    this.prevWheelRevs = cumWheelRevs;
                    this.prevWheelTime = lastWheelTime;
                } else if (dTime === 0) {
                    speedKmh = (now - this.lastWheelMoveTime > 2500) ? 0 : this.lastCscSpeed;
                }
            }

            this.lastTotalWheelRevs = cumWheelRevs;
            if (this.mode === 'speed') {
                const totalRevs = Math.max(0, cumWheelRevs - this.initialWheelRevs);
                sessionDistanceMeters = totalRevs * (this.wheelCircumferenceMm / 1000);
            }
        }

        // Bit 1: Crank Revolution Data Present (ケイデンスセンサー)
        if ((flags & 0x02) && value.byteLength >= offset + 4) {
            const cumCrankRevs = value.getUint16(offset, true);
            const lastCrankTime = value.getUint16(offset + 2, true); // 1/1024秒単位

            if (this.prevCrankRevs === null) {
                this.prevCrankRevs = cumCrankRevs;
                this.prevCrankTime = lastCrankTime;
                this.lastCrankMoveTime = now;
            } else {
                const dCrank = (cumCrankRevs - this.prevCrankRevs + 65536) % 65536;
                const dTime = (lastCrankTime - this.prevCrankTime + 65536) % 65536;
                if (dTime > 0 && dCrank >= 0 && dCrank < 50) {
                    const dtSec = dTime / 1024;
                    cadenceRpm = (dCrank / dtSec) * 60;
                    this.lastCscCadence = cadenceRpm;
                    this.lastCrankMoveTime = now;
                    this.prevCrankRevs = cumCrankRevs;
                    this.prevCrankTime = lastCrankTime;
                } else if (dTime === 0) {
                    cadenceRpm = (now - this.lastCrankMoveTime > 2500) ? 0 : this.lastCscCadence;
                }
            }
        }

        // ケイデンスセンサー単体モードのときはケイデンス表示のみを更新（速度・距離は動かさない）
        if (this.mode === 'cadence') {
            speedKmh = null;
            sessionDistanceMeters = null;
        }

        this.emit('data', {
            power: null,
            cadence: cadenceRpm !== null ? Math.round(cadenceRpm) : null,
            speed: speedKmh !== null ? Math.round(speedKmh * 10) / 10 : null,
            totalDistanceMeters: sessionDistanceMeters,
            sessionDistanceMeters
        });
    }

    async disconnect() {
        if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        this.handleDisconnection();
    }

    handleDisconnection() {
        this.isConnected = false;
        this.hasControl = false;
        this.controlPointChar = null;
        this.lastSentSlope = null;
        this.resetCscAndDistanceState();
        this.emit('disconnected');
    }

    resetDistance() {
        this.initialDistanceMeters = this.lastTotalDistanceMeters ?? null;
        this.initialWheelRevs = this.lastTotalWheelRevs ?? null;
    }
}
