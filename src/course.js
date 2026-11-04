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
    constructor(waypoints = DEFAULT_LAKE_ROUTE, name = 'コース', isWebEditor = false, structures = []) {
        this.name = name;
        this.rawWaypoints = waypoints;
        this.isWebEditor = isWebEditor;
        // 橋・トンネル区間 [{ type, startIdx, endIdx }]（waypoint インデックス）
        this.structures = structures;
        this.structureRanges = [];
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
     * Webエディタ製や標高なし等、10mメッシュ自動補正をかけるべきコースかを判定
     */
    needsAutoDemCorrection() {
        return !this.hasElevationData() || this.isWebEditor || /hiyoshi|shimanami|kashida/i.test(this.name);
    }

    /**
     * 3D地形DEM（日本国内: 国土地理院 10mメッシュ dem_png、海外: AWS 30m DEM）からコース標高を自動同期
     */
    async syncWithTerrainDem() {
        if (this.isGsiCorrected) return false;

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
        this.applyRoadGradeSmoothing(this.rawSamples);
        this.isTerrainSynced = true;
        this.isGsiCorrected = isGsi;
        return true;
    }

    /**
     * 「10mメッシュ標高で補正」ボタン押下時：
     * 国土地理院 10mメッシュ（dem_png / DEM10B）＋ 道路勾配制約フィルタで標高・斜度を再計算
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
        this.applyRoadGradeSmoothing(this.rawSamples);
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

        // 橋・トンネル区間を距離範囲 (m) に変換
        this.structureRanges = (this.structures || [])
            .map((s) => ({ type: s.type, d0: this.cumDistances[s.startIdx], d1: this.cumDistances[s.endIdx] }))
            .filter((r) => r.d0 !== undefined && r.d1 !== undefined && r.d1 > r.d0);

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

        this.applyRoadGradeSmoothing(this.rawSamples);
    }

    /**
     * 道路工学設計に基づく標高・勾配スムージング
     * 1. メディアンフィルター (前後15m): 崖沿い・法面の外れ値をカット
     * 2. 道路最大勾配制限 (12%双方向パス): トンネル上の山頂や橋の下の谷底等の非道路スパイクを前後の路面標高で自動架橋
     * 3. 移動平均フィルター (前後20m): 道路設計に即した滑らかでリアルな縦断勾配を生成
     */
    applyRoadGradeSmoothing(samples) {
        const count = samples.length - 1;
        if (count < 2) {
            this.interpolatedPoints = samples.slice();
            return;
        }
        const stepDist = this.totalDistance / (count || 1);

        // 0. 橋・トンネル区間は地表面(谷底・山頂)ではなく、入口〜出口を直線で結んだ路面標高に置き換える
        const srcAlts = Float64Array.from(samples, (s) => s.alt);
        this.linearizeStructures(samples, srcAlts);

        // 1. メディアンフィルター (前後15m)
        const medHalf = Math.max(1, Math.round(15 / (stepDist || 1)));
        const medAlts = new Float64Array(count + 1);
        for (let i = 0; i <= count; i++) {
            const start = Math.max(0, i - medHalf);
            const end = Math.min(count, i + medHalf);
            const w = [];
            for (let k = start; k <= end; k++) w.push(srcAlts[k]);
            w.sort((a, b) => a - b);
            medAlts[i] = w[Math.floor(w.length / 2)];
        }

        // 2. 道路物理勾配制限パス (前後双方向で最大許容勾配 12% に制約)
        const MAX_GRADE = 0.12;
        const forward = new Float64Array(count + 1);
        forward[0] = medAlts[0];
        for (let i = 1; i <= count; i++) {
            const dx = samples[i].dist - samples[i - 1].dist;
            const maxDelta = MAX_GRADE * dx;
            forward[i] = Math.max(forward[i - 1] - maxDelta, Math.min(forward[i - 1] + maxDelta, medAlts[i]));
        }

        const backward = new Float64Array(count + 1);
        backward[count] = forward[count];
        for (let i = count - 1; i >= 0; i--) {
            const dx = samples[i + 1].dist - samples[i].dist;
            const maxDelta = MAX_GRADE * dx;
            backward[i] = Math.max(backward[i + 1] - maxDelta, Math.min(backward[i + 1] + maxDelta, forward[i]));
        }

        // 3. 移動平均フィルター (前後20m)
        const avgHalf = Math.max(1, Math.round(20 / (stepDist || 1)));
        this.interpolatedPoints = samples.map((s, idx) => {
            const start = Math.max(0, idx - avgHalf);
            const end = Math.min(count, idx + avgHalf);
            let sum = 0;
            for (let k = start; k <= end; k++) sum += backward[k];
            return { dist: s.dist, lon: s.lon, lat: s.lat, alt: sum / (end - start + 1) };
        });
    }

    /**
     * 橋・トンネル区間の標高を、入口・出口の路面標高（区間の外側15mの中央値）を結ぶ直線に置き換える
     * DEM は橋の下の谷底やトンネル上の山頂を拾うため、路面とは大きく異なる
     */
    linearizeStructures(samples, alts) {
        const ranges = this.structureRanges || [];
        if (!ranges.length) return;
        const n = samples.length;
        const orig = Float64Array.from(alts);
        const WINDOW = 15;

        const medianIn = (from, to, fallbackIdx) => {
            const w = [];
            for (let i = 0; i < n; i++) {
                const d = samples[i].dist;
                if (d >= from && d <= to) w.push(orig[i]);
            }
            if (!w.length) return orig[clamp(fallbackIdx, 0, n - 1)];
            w.sort((a, b) => a - b);
            return w[Math.floor(w.length / 2)];
        };

        for (const { d0, d1 } of ranges) {
            let i0 = -1, i1 = -1;
            for (let i = 0; i < n; i++) {
                const d = samples[i].dist;
                if (i0 < 0 && d >= d0) i0 = i;
                if (d <= d1) i1 = i;
            }
            if (i0 < 0 || i1 < i0) continue;

            const a0 = medianIn(d0 - WINDOW, d0 - 1e-6, i0 - 1);
            const a1 = medianIn(d1 + 1e-6, d1 + WINDOW, i1 + 1);
            for (let i = i0; i <= i1; i++) {
                const t = (samples[i].dist - d0) / (d1 - d0);
                alts[i] = a0 + (a1 - a0) * clamp(t, 0, 1);
            }
        }
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

        // 斜度（Slope）: 前後15m（計30mスパン）の標高差から安定かつ遅れなく算出
        // コンターに平行な平坦路では確実に±1.5%以内に収まり、10mメッシュの微小段差ノイズを完全に除去
        const bwdSlope = this.sampleAtDist(dist - 15);
        const fwdSlope = this.sampleAtDist(dist + 15);
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

    /**
     * MapLibre line-gradient 用の勾配カラーストップ配列を生成
     * 進行度 0.0〜1.0 の各地点の斜度に応じた明度・彩度カラーをマッピング
     */
    getRouteColorStops() {
        const STOPS = clamp(Math.round(this.totalDistance / 20), 64, 1000);
        const stops = [];
        for (let i = 0; i <= STOPS; i++) {
            const progress = i / STOPS;
            const state = this.getStateAtProgress(progress);
            const color = GeoCourseManager.slopeToColor(state.slope);
            stops.push([progress, color]);
        }
        return stops;
    }

    /**
     * 勾配（Slope %）→ 走行ラインカラー（彩度・明度で表現）
     * - 平坦 (0%): 白（彩度 0%・明度 100%）
     * - 上り: 赤系の色相固定で、勾配が増すほど彩度↑・明度↓（10%以上で最大）
     * - 下り: 青系の色相固定で、勾配が増すほど彩度↑・明度↓（-10%以下で最大）
     */
    static slopeToColor(slope) {
        const t = clamp(Math.abs(slope) / 10, 0, 1);
        const hue = slope >= 0 ? 0 : 210;
        const sat = Math.round(t * 100);
        const light = Math.round(100 - t * 50);
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    }

    toGeoJSONCoordinates() {
        return this.interpolatedPoints.map((p) => [p.lon, p.lat, p.alt]);
    }
}
