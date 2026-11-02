/**
 * GeoCourseManager
 * 3D Route Interpolation, Distance, Bearing, and Road-Grade Calculation Engine
 */

import { GPXParser, fetchGsi5mWaypoints } from './gpx-gsi.js';
export { GPXParser };

const DEG_TO_RAD = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;

export const DEFAULT_LAKE_ROUTE = [
    { lon: 138.5830, lat: 35.4740, alt: 902 },
    { lon: 138.5885, lat: 35.4785, alt: 905 },
    { lon: 138.5950, lat: 35.4815, alt: 908 },
    { lon: 138.6015, lat: 35.4800, alt: 914 },
    { lon: 138.6070, lat: 35.4755, alt: 922 },
    { lon: 138.6095, lat: 35.4690, alt: 918 },
    { lon: 138.6065, lat: 35.4625, alt: 912 },
    { lon: 138.5990, lat: 35.4590, alt: 907 },
    { lon: 138.5910, lat: 35.4600, alt: 904 },
    { lon: 138.5845, lat: 35.4645, alt: 903 },
    { lon: 138.5815, lat: 35.4700, alt: 902 },
    { lon: 138.5830, lat: 35.4740, alt: 902 }
];

export class GeoCourseManager {
    constructor(waypoints = DEFAULT_LAKE_ROUTE, name = 'コース') {
        this.name = name;
        this.rawWaypoints = waypoints;
        this.interpolatedPoints = [];
        this.totalDistance = 0;
        this.cumDistances = [];
        this.isGsiCorrected = false;
        this.initInterpolation();
    }

    isWithinJapan() {
        const p0 = this.rawWaypoints?.[0];
        return !!p0 && p0.lat >= 20 && p0.lat <= 46 && p0.lon >= 122 && p0.lon <= 154;
    }

    async recalculateWithGSI5m(onProgress = null) {
        if (!this.isWithinJapan()) {
            throw new Error('国土地理院の標高メッシュは日本国内のコースのみ対応しています。');
        }
        this.rawWaypoints = await fetchGsi5mWaypoints(this.rawWaypoints, this.totalDistance, onProgress);
        this.isGsiCorrected = true;
        this.initInterpolation();
        return true;
    }

    static haversineDistance(lon1, lat1, lon2, lat2) {
        const dLat = (lat2 - lat1) * DEG_TO_RAD;
        const dLon = (lon2 - lon1) * DEG_TO_RAD;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    static calcBearing(lon1, lat1, lon2, lat2) {
        const dLon = (lon2 - lon1) * DEG_TO_RAD;
        const rLat1 = lat1 * DEG_TO_RAD, rLat2 = lat2 * DEG_TO_RAD;
        const y = Math.sin(dLon) * Math.cos(rLat2);
        const x = Math.cos(rLat1) * Math.sin(rLat2) - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
        return (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360;
    }

    initInterpolation() {
        this.cumDistances = [0];
        let total = 0;
        for (let i = 0; i < this.rawWaypoints.length - 1; i++) {
            const p1 = this.rawWaypoints[i], p2 = this.rawWaypoints[i + 1];
            total += GeoCourseManager.haversineDistance(p1.lon, p1.lat, p2.lon, p2.lat);
            this.cumDistances.push(total);
        }
        this.totalDistance = total;

        const SAMPLES = Math.min(4000, Math.max(1000, Math.round(total / 5)));
        const rawSamples = [];
        let segIdx = 0;

        for (let i = 0; i <= SAMPLES; i++) {
            const targetDist = (i / SAMPLES) * total;
            while (segIdx < this.cumDistances.length - 2 && targetDist > this.cumDistances[segIdx + 1]) {
                segIdx++;
            }
            const d0 = this.cumDistances[segIdx], d1 = this.cumDistances[segIdx + 1];
            const r = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
            const p0 = this.rawWaypoints[segIdx], p1 = this.rawWaypoints[segIdx + 1];
            rawSamples.push({
                dist: targetDist,
                lon: lerp(p0.lon, p1.lon, r),
                lat: lerp(p0.lat, p1.lat, r),
                alt: lerp(p0.alt, p1.alt, r)
            });
        }

        // 約60m区間の移動平均フィルター（GPS標高スパイクノイズ除去）
        const stepDist = total / SAMPLES;
        const halfWin = Math.max(3, Math.round(30 / (stepDist || 1)));

        this.interpolatedPoints = rawSamples.map((s, idx) => {
            const start = Math.max(0, idx - halfWin), end = Math.min(SAMPLES, idx + halfWin);
            let sumAlt = 0;
            for (let k = start; k <= end; k++) sumAlt += rawSamples[k].alt;
            return { dist: s.dist, lon: s.lon, lat: s.lat, alt: sumAlt / (end - start + 1) };
        });
    }

    sampleAtDist(targetDist) {
        const pts = this.interpolatedPoints;
        const sampleCount = pts.length - 1;
        const clampedDist = Math.max(0, Math.min(this.totalDistance, targetDist));
        const exactIdx = (clampedDist / (this.totalDistance || 1)) * sampleCount;
        const idx = Math.min(sampleCount - 1, Math.max(0, Math.floor(exactIdx)));
        const r = exactIdx - idx;
        const pA = pts[idx], pB = pts[idx + 1];
        return {
            dist: clampedDist,
            lon: lerp(pA.lon, pB.lon, r),
            lat: lerp(pA.lat, pB.lat, r),
            alt: lerp(pA.alt, pB.alt, r)
        };
    }

    getStateAtProgress(progress, speedKmh = 25, fwdMult = 1.0, bwdMult = 0.5) {
        const u = Math.max(0, Math.min(1, progress));
        const dist = u * this.totalDistance;
        const cur = this.sampleAtDist(dist);

        // 方位角（Bearing）: 速度 (m) × 個別倍率に応じた前後ベクトル
        const v = Math.max(1, speedKmh);
        const fwdDist = v * Math.max(0, fwdMult);
        const bwdDist = v * Math.max(0, bwdMult);

        let p0, p1;
        if (fwdDist === 0 && bwdDist === 0) {
            // 両方0の場合は微小前方を参照してゼロ除算防止
            p0 = cur;
            p1 = this.sampleAtDist(dist + 1);
        } else if (bwdDist === 0) {
            // 後方0: 現在地（走行点）〜 前方
            p0 = cur;
            p1 = this.sampleAtDist(dist + fwdDist);
            if (dist + fwdDist > this.totalDistance) {
                p0 = this.sampleAtDist(Math.max(0, this.totalDistance - fwdDist));
                p1 = this.sampleAtDist(this.totalDistance);
            }
        } else if (fwdDist === 0) {
            // 前方0: 後方 〜 現在地（走行点）
            p0 = this.sampleAtDist(dist - bwdDist);
            p1 = cur;
        } else {
            // 前後指定: 後方 〜 前方
            p0 = this.sampleAtDist(dist - bwdDist);
            p1 = this.sampleAtDist(dist + fwdDist);
        }

        // 斜度（Slope）は前後25mの連続標高差から算出
        const bwdSlope = this.sampleAtDist(dist - 25);
        const fwdSlope = this.sampleAtDist(dist + 25);
        const roadDist = fwdSlope.dist - bwdSlope.dist;
        const slope = roadDist > 5 ? Math.round(((fwdSlope.alt - bwdSlope.alt) / roadDist) * 1000) / 10 : 0;

        return {
            u,
            distance: dist,
            lon: cur.lon,
            lat: cur.lat,
            alt: cur.alt,
            bearing: GeoCourseManager.calcBearing(p0.lon, p0.lat, p1.lon, p1.lat),
            slope,
            fwdPoint: { lon: p1.lon, lat: p1.lat },
            bwdPoint: { lon: p0.lon, lat: p0.lat }
        };
    }

    toGeoJSONCoordinates() {
        return this.interpolatedPoints.map((p) => [p.lon, p.lat, p.alt]);
    }
}
