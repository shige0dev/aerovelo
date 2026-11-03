/**
 * GeoCourseManager
 * 3D Route Interpolation, Distance, Bearing, and Road-Grade Calculation Engine
 */

import { fetchGsiDem10mElevations, fetchTerrainDemElevations } from './gpx-gsi.js';

const DEG_TO_RAD = Math.PI / 180;
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const lerp = (a, b, t) => a + (b - a) * t;

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
        this.rawSamples = [];
        this.interpolatedPoints = [];
        this.totalDistance = 0;
        this.cumDistances = [];
        this.isGsiCorrected = false;
        this.isTerrainSynced = false;
        this.initInterpolation();
    }

    isWithinJapan() {
        const p0 = this.rawWaypoints?.[0];
        return !!p0 && p0.lat >= 20 && p0.lat <= 46 && p0.lon >= 122 && p0.lon <= 154;
    }

    /**
     * GPXファイル自体に有効な標高データ (<ele>) が含まれているかを判定
     */
    hasElevationData() {
        return Array.isArray(this.rawWaypoints) && this.rawWaypoints.some((p) => Math.abs(p.alt) > 0.01);
    }

    /**
     * 標高データを持たない空GPX用の自動フォールバック同期
     */
    async syncWithTerrainDem() {
        if (this.isGsiCorrected || this.hasElevationData()) return false;

        let elevations = null;
        let isGsi = false;

        if (this.isWithinJapan()) {
            const res = await fetchGsiDem10mElevations(this.rawSamples);
            if (res && res.elevations) {
                elevations = res.elevations;
                isGsi = true;
            }
        }

        if (!elevations) {
            elevations = await fetchTerrainDemElevations(this.rawSamples);
        }

        if (!elevations || this.isGsiCorrected) return false;

        this.rawSamples = this.rawSamples.map((s, i) => ({ ...s, alt: elevations[i] }));
        this.applyElevationFilter(this.rawSamples, true);
        this.isTerrainSynced = true;
        this.isGsiCorrected = isGsi;
        return true;
    }

    /**
     * 「10mメッシュ標高で補正」ボタン押下時：
     * 国土地理院 10mメッシュ（dem_png / DEM10B）＋ 5mコンター・クロスポイント方式で標高・斜度を再計算
     */
    async recalculateWithGSI10m(onProgress = null) {
        if (!this.isWithinJapan()) {
            throw new Error('国土地理院の標高メッシュは日本国内のコースのみ対応しています。');
        }
        const res = await fetchGsiDem10mElevations(this.rawSamples, onProgress);
        if (!res || !res.elevations) {
            throw new Error('国土地理院 10mメッシュの取得に失敗しました。');
        }
        this.rawSamples = this.rawSamples.map((s, i) => ({ ...s, alt: res.elevations[i] }));
        this.applyElevationFilter(this.rawSamples, true);
        this.isGsiCorrected = true;
        this.isTerrainSynced = true;
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
        this.rawSamples = [];
        let segIdx = 0;

        for (let i = 0; i <= SAMPLES; i++) {
            const targetDist = (i / SAMPLES) * total;
            while (segIdx < this.cumDistances.length - 2 && targetDist > this.cumDistances[segIdx + 1]) {
                segIdx++;
            }
            const d0 = this.cumDistances[segIdx], d1 = this.cumDistances[segIdx + 1];
            const r = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
            const p0 = this.rawWaypoints[segIdx], p1 = this.rawWaypoints[segIdx + 1];
            this.rawSamples.push({
                dist: targetDist,
                lon: lerp(p0.lon, p1.lon, r),
                lat: lerp(p0.lat, p1.lat, r),
                alt: lerp(p0.alt, p1.alt, r)
            });
        }

        this.applyElevationFilter(this.rawSamples);
    }

    /**
     * 5mコンターライン（等高線）とのクロスポイント（交点）を抽出し、交点間を一定勾配で直線補間する
     * 同一5mコンター帯内での山肌・法面・トンネル上の局所的なうねり（<5m）を排除し、目視のコンター間隔と斜度を一致させる
     */
    buildContourCrossingSamples(points) {
        const n = points.length;
        if (n < 2) return points;

        const STEP = 5;
        const anchors = [{ idx: 0, alt: points[0].alt }];
        let lastLevel = Math.round(points[0].alt / STEP) * STEP;
        let dir = 0;
        let maxAlt = points[0].alt, maxIdx = 0;
        let minAlt = points[0].alt, minIdx = 0;

        for (let i = 1; i < n - 1; i++) {
            const alt = points[i].alt;
            if (alt > maxAlt) { maxAlt = alt; maxIdx = i; }
            if (alt < minAlt) { minAlt = alt; minIdx = i; }

            if (alt >= lastLevel + STEP) {
                if (dir === -1 && minIdx > anchors[anchors.length - 1].idx && (lastLevel - minAlt) >= 3.5) {
                    anchors.push({ idx: minIdx, alt: minAlt });
                }
                while (lastLevel + STEP <= alt) {
                    lastLevel += STEP;
                }
                anchors.push({ idx: i, alt: lastLevel });
                dir = 1;
                maxAlt = alt; maxIdx = i;
                minAlt = alt; minIdx = i;
            } else if (alt <= lastLevel - STEP) {
                if (dir === 1 && maxIdx > anchors[anchors.length - 1].idx && (maxAlt - lastLevel) >= 3.5) {
                    anchors.push({ idx: maxIdx, alt: maxAlt });
                }
                while (lastLevel - STEP >= alt) {
                    lastLevel -= STEP;
                }
                anchors.push({ idx: i, alt: lastLevel });
                dir = -1;
                maxAlt = alt; maxIdx = i;
                minAlt = alt; minIdx = i;
            }
        }

        anchors.push({ idx: n - 1, alt: points[n - 1].alt });

        const result = points.map((p) => ({ ...p }));
        for (let k = 0; k < anchors.length - 1; k++) {
            const a0 = anchors[k], a1 = anchors[k + 1];
            const d0 = points[a0.idx].dist, d1 = points[a1.idx].dist;
            const span = d1 - d0;
            for (let i = a0.idx; i <= a1.idx; i++) {
                const t = span > 0 ? (points[i].dist - d0) / span : 0;
                result[i].alt = lerp(a0.alt, a1.alt, t);
            }
        }
        return result;
    }

    applyElevationFilter(samples, useContourCrossing = false) {
        const count = samples.length - 1;
        const stepDist = this.totalDistance / (count || 1);

        // 1段目: メディアンフィルター（前後12m・スパイクノイズ除去）
        const medHalfWin = Math.max(1, Math.round(12 / (stepDist || 1)));
        const medianFiltered = samples.map((s, idx) => {
            const start = Math.max(0, idx - medHalfWin), end = Math.min(count, idx + medHalfWin);
            const windowAlts = [];
            for (let k = start; k <= end; k++) windowAlts.push(samples[k].alt);
            windowAlts.sort((a, b) => a - b);
            const mid = Math.floor(windowAlts.length / 2);
            const medAlt = (windowAlts.length % 2 === 1)
                ? windowAlts[mid]
                : (windowAlts[mid - 1] + windowAlts[mid]) / 2;
            return { dist: s.dist, lon: s.lon, lat: s.lat, alt: medAlt };
        });

        // 10mメッシュ補正時は 5mコンターラインとのクロスポイント補間を適用
        const basePoints = useContourCrossing
            ? this.buildContourCrossingSamples(medianFiltered)
            : medianFiltered;

        // 2段目: 前後15m（計30m区間）の移動平均フィルター（段差を均し、実走感のある滑らかな道路勾配を生成）
        const halfWin = Math.max(1, Math.round(15 / (stepDist || 1)));
        this.interpolatedPoints = basePoints.map((s, idx) => {
            const start = Math.max(0, idx - halfWin), end = Math.min(count, idx + halfWin);
            let sumAlt = 0;
            for (let k = start; k <= end; k++) sumAlt += basePoints[k].alt;
            return { dist: s.dist, lon: s.lon, lat: s.lat, alt: sumAlt / (end - start + 1) };
        });
    }

    sampleAtDist(targetDist) {
        const pts = this.interpolatedPoints;
        const sampleCount = pts.length - 1;
        const clampedDist = clamp(targetDist, 0, this.totalDistance);
        const exactIdx = (clampedDist / (this.totalDistance || 1)) * sampleCount;
        const idx = clamp(Math.floor(exactIdx), 0, sampleCount - 1);
        const r = exactIdx - idx;
        const pA = pts[idx], pB = pts[idx + 1];
        return {
            dist: clampedDist,
            lon: lerp(pA.lon, pB.lon, r),
            lat: lerp(pA.lat, pB.lat, r),
            alt: lerp(pA.alt, pB.alt, r)
        };
    }

    getStateAtProgress(progress, speedKmh = 25, fwdMult = 2.0, bwdMult = 1.0) {
        const u = clamp(progress, 0, 1);
        const dist = u * this.totalDistance;
        const cur = this.sampleAtDist(dist);

        // 方位角（Bearing）: 速度 (m) × 個別倍率に応じた前後ベクトル（0の場合は現在地に一致）
        const v = Math.max(1, speedKmh);
        const fwdDist = v * Math.max(0, fwdMult);
        const bwdDist = v * Math.max(0, bwdMult);

        let p0 = bwdDist === 0 ? cur : this.sampleAtDist(dist - bwdDist);
        let p1 = fwdDist === 0 ? cur : this.sampleAtDist(dist + fwdDist);
        let b0 = p0, b1 = p1;

        if (b1.dist <= b0.dist) {
            const span = Math.max(1, fwdDist || bwdDist);
            b0 = this.sampleAtDist(Math.max(0, dist - span * 0.5));
            b1 = this.sampleAtDist(Math.min(this.totalDistance, b0.dist + span));
        }

        // 斜度（Slope）: 後方10m〜前方20m（計30m・目の前の道路勾配）の標高差から目視地形と完全に一致させて算出
        const bwdSlope = this.sampleAtDist(dist - 10);
        const fwdSlope = this.sampleAtDist(dist + 20);
        const roadDist = fwdSlope.dist - bwdSlope.dist;
        const slope = roadDist > 5 ? Math.round(((fwdSlope.alt - bwdSlope.alt) / roadDist) * 1000) / 10 : 0;

        return {
            u,
            distance: dist,
            lon: cur.lon,
            lat: cur.lat,
            alt: cur.alt,
            bearing: GeoCourseManager.calcBearing(b0.lon, b0.lat, b1.lon, b1.lat),
            slope,
            fwdPoint: { lon: p1.lon, lat: p1.lat },
            bwdPoint: { lon: p0.lon, lat: p0.lat }
        };
    }

    toGeoJSONCoordinates() {
        return this.interpolatedPoints.map((p) => [p.lon, p.lat, p.alt]);
    }
}
