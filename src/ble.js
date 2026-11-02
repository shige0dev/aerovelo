/**
 * Web Bluetooth API Manager for Smart Trainers & Cycling Sensors
 * Supports FTMS (0x1826: Indoor Bike Data 0x2AD2, Control Point 0x2AD9) and Cycling Power (0x1818).
 */

export class BleTrainerManager {
    static UUIDS = {
        FTMS_SERVICE: 0x1826,
        CYCLING_POWER_SERVICE: 0x1818,
        INDOOR_BIKE_DATA: 0x2AD2,
        FITNESS_MACHINE_CONTROL_POINT: 0x2AD9,
        CYCLING_POWER_MEASUREMENT: 0x2A63
    };

    constructor() {
        this.device = null;
        this.server = null;
        this.controlPointChar = null;
        this.isConnected = false;
        this.hasControl = false;
        this.listeners = { data: [], connected: [], disconnected: [] };
        this.lastSentSlope = null;
        this.lastSendTime = 0;
        this.initialDistanceMeters = null;
        this.lastTotalDistanceMeters = null;
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

    async connect() {
        if (!BleTrainerManager.isSupported()) {
            throw new Error('お使いのブラウザは Web Bluetooth API に対応していません。Chrome / Edge をご利用ください。');
        }

        try {
            const { FTMS_SERVICE, CYCLING_POWER_SERVICE } = BleTrainerManager.UUIDS;
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [FTMS_SERVICE] }, { services: [CYCLING_POWER_SERVICE] }],
                optionalServices: [FTMS_SERVICE, CYCLING_POWER_SERVICE]
            });

            this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnection());
            this.server = await this.device.gatt.connect();
            this.isConnected = true;

            await this.setupServices();
            const info = { deviceName: this.device.name || 'スマートトレーナー', hasControl: this.hasControl };
            this.emit('connected', info);
            return info;
        } catch (err) {
            this.handleDisconnection();
            throw err;
        }
    }

    async setupServices() {
        const { FTMS_SERVICE, INDOOR_BIKE_DATA, FITNESS_MACHINE_CONTROL_POINT, CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT } = BleTrainerManager.UUIDS;

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
        this.emit('data', { power: Math.max(0, value.getInt16(2, true)), cadence: null, speed: null });
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
        this.initialDistanceMeters = null;
        this.lastTotalDistanceMeters = null;
        this.emit('disconnected');
    }

    resetDistance() {
        this.initialDistanceMeters = this.lastTotalDistanceMeters ?? null;
    }
}
