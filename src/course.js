/**
 * GeoCourseManager
 * 3D Route Interpolation, Distance, Bearing, and Road-Grade Calculation Engine
 */

import { clamp, lerp, haversineDistance, calcBearing } from './utils.js';
import { fetchGsiDem10mElevations, fetchTerrainDemElevations } from './dem-service.js';
import { fetchOsmStructures } from './osm-structures.js';

export { clamp, lerp };

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
    constructor(waypoints = DEFAULT_LAKE_ROUTE, name = 'コース', isWebEditor = false) {
        this.name = name;
        this.rawWaypoints = waypoints;
        this.isWebEditor = isWebEditor;
        this.structureRanges = [];
        this.osmStructuresChecked = false;
        this.osmStatus = 'pending';
        this.osmSource = '';
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
     * 3D地形DEM（日本: 国土地理院 10m、海外: AWS 30m）とコース標高を同期
     */
    async syncElevations({ forceGsi = false, onProgress = null } = {}) {
        if (this.isGsiCorrected && !forceGsi) return false;
        if (forceGsi && !this.isWithinJapan()) {
            throw new Error('国土地理院の標高メッシュは日本国内のコースのみ対応しています。');
        }

        // 1. 先に橋・トンネルを取得し、完了を確認する
        await this.loadOsmStructures();

        // 2. DEM 標高を取得
        let elevations = null;
        let isGsi = false;

        if (this.isWithinJapan()) {
            const res = await fetchGsiDem10mElevations(this.rawSamples, onProgress);
            if (res && res.elevations) {
                elevations = res.elevations;
                isGsi = true;
            }
        }

        if (!elevations && !forceGsi) {
            elevations = await fetchTerrainDemElevations(this.rawSamples);
        }

        if (!elevations) {
            if (forceGsi) throw new Error('国土地理院 10mメッシュの取得に失敗しました。');
            return false;
        }

        // 3. 橋・トンネル範囲の端部直線化を含む高度補正を実行
        this.rawSamples = this.rawSamples.map((s, i) => ({ ...s, alt: elevations[i] }));
        this.isTerrainSynced = true;
        this.applyRoadGradeSmoothing(this.rawSamples);
        this.isGsiCorrected = isGsi;
        return true;
    }

    syncWithTerrainDem() {
        return this.syncElevations();
    }

    recalculateWithGSI10m(onProgress = null) {
        return this.syncElevations({ forceGsi: true, onProgress });
    }

    /**
     * OpenStreetMap 公式 API から橋・トンネル区間を取得する
     */
    async loadOsmStructures() {
        if (this.osmStructuresChecked) return true;
        this.osmStructuresChecked = true;
        const res = await fetchOsmStructures(this.rawSamples);
        if (!res) {
            this.osmStructuresChecked = false;
            this.osmStatus = 'error';
            return false;
        }
        this.osmStatus = 'ok';
        this.osmSource = res.source || 'OSM API v0.6';

        this.structureRanges = GeoCourseManager.mergeStructureRanges(res.ranges || []);
        this.applyRoadGradeSmoothing(this.rawSamples);
        return true;
    }

    /**
     * 橋・トンネル区間リストを距離順に整列し、重複・近接する同種区間を結合する
     */
    static mergeStructureRanges(ranges) {
        const valid = (ranges || []).filter((r) => r && r.d1 > r.d0);
        if (!valid.length) return [];
        valid.sort((a, b) => a.d0 - b.d0 || a.d1 - b.d1);
        const merged = [{ ...valid[0] }];
        for (let i = 1; i < valid.length; i++) {
            const cur = valid[i];
            const prev = merged[merged.length - 1];
            if (cur.type === prev.type && cur.d0 <= prev.d1 + 12) {
                prev.d1 = Math.max(prev.d1, cur.d1);
                if (!prev.name && cur.name) prev.name = cur.name;
            } else {
                merged.push({ ...cur });
            }
        }
        return merged;
    }

    /**
     * 検出された BRIDGE / TUNNEL の集計情報を返す
     */
    getStructureSummary() {
        const bridges = (this.structureRanges || []).filter((r) => r.type === 'bridge');
        const tunnels = (this.structureRanges || []).filter((r) => r.type === 'tunnel');
        return {
            bridges,
            tunnels,
            bridgeCount: bridges.length,
            tunnelCount: tunnels.length,
            osmStatus: this.osmStatus,
            osmSource: this.osmSource
        };
    }

    initInterpolation() {
        this.cumDistances = [0];
        let total = 0;
        for (let i = 0; i < this.rawWaypoints.length - 1; i++) {
            const p1 = this.rawWaypoints[i], p2 = this.rawWaypoints[i + 1];
            total += haversineDistance(p1.lon, p1.lat, p2.lon, p2.lat);
            this.cumDistances.push(total);
        }
        this.totalDistance = total;
        this.structureRanges = [];

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
     */
    applyRoadGradeSmoothing(samples) {
        const count = samples.length - 1;
        if (count < 2) {
            this.interpolatedPoints = samples.slice();
            return;
        }
        const stepDist = this.totalDistance / (count || 1);

        // 0. 橋・トンネル区間は入口〜出口を直線で結んだ路面標高に置き換える
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
        const smoothedAlts = new Float64Array(count + 1);
        for (let idx = 0; idx <= count; idx++) {
            const start = Math.max(0, idx - avgHalf);
            const end = Math.min(count, idx + avgHalf);
            let sum = 0;
            for (let k = start; k <= end; k++) sum += backward[k];
            smoothedAlts[idx] = sum / (end - start + 1);
        }

        // 4. 橋・トンネル区間は端部高度と端部高度を厳密な直線で結ぶ
        this.linearizeStructuresExact(samples, smoothedAlts);

        for (let i = 0; i <= count; i++) {
            samples[i].alt = smoothedAlts[i];
        }

        this.interpolatedPoints = samples.map((s, idx) => ({
            dist: s.dist,
            lon: s.lon,
            lat: s.lat,
            alt: smoothedAlts[idx]
        }));
    }

    /**
     * 橋・トンネル区間の標高を、入口・出口の路面標高（外側15mの中央値）を結ぶ直線に置き換える
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

        for (const r of ranges) {
            const { d0, d1 } = r;
            let i0 = -1, i1 = -1;
            for (let i = 0; i < n; i++) {
                const d = samples[i].dist;
                if (i0 < 0 && d >= d0) i0 = i;
                if (d <= d1) i1 = i;
            }
            if (i0 < 0 || i1 < i0) continue;

            const a0 = medianIn(d0 - WINDOW, d0 - 1e-6, i0 - 1);
            const a1 = medianIn(d1 + 1e-6, d1 + WINDOW, i1 + 1);
            r.alt0 = a0;
            r.alt1 = a1;

            for (let i = i0; i <= i1; i++) {
                const t = (samples[i].dist - d0) / (d1 - d0);
                alts[i] = a0 + (a1 - a0) * clamp(t, 0, 1);
            }
        }
    }

    /**
     * 橋・トンネル区間を端部標高 (alt0, alt1) を結ぶ厳密な直線高度で上書きする
     */
    linearizeStructuresExact(samples, alts) {
        const ranges = this.structureRanges || [];
        if (!ranges.length) return;
        const n = samples.length;

        for (const r of ranges) {
            const { d0, d1, alt0, alt1 } = r;
            if (d1 <= d0 || alt0 == null || alt1 == null) continue;

            for (let i = 0; i < n; i++) {
                const d = samples[i].dist;
                if (d >= d0 && d <= d1) {
                    const t = clamp((d - d0) / (d1 - d0), 0, 1);
                    alts[i] = alt0 + (alt1 - alt0) * t;
                }
            }
        }
    }

    /**
     * 指定距離の補間点（lon, lat, alt）を取得
     * 構造物区間では端部直線高度を返し、通常区間では平滑化DEM標高を返す
     */
    sampleAtDist(targetDist) {
        const clampedDist = clamp(targetDist, 0, this.totalDistance);
        const pts = this.interpolatedPoints;
        const sampleCount = pts.length - 1;
        const exactIdx = (clampedDist / (this.totalDistance || 1)) * sampleCount;
        const idx = clamp(Math.floor(exactIdx), 0, sampleCount - 1);
        const r = exactIdx - idx;
        const pA = pts[idx], pB = pts[idx + 1];

        // 橋・トンネル区間内であれば、端部の高さを維持した直線標高を返す
        const struct = this.getStructureAtDist(clampedDist);
        let alt;
        if (struct && struct.d1 > struct.d0 && struct.alt0 != null && struct.alt1 != null) {
            const t = clamp((clampedDist - struct.d0) / (struct.d1 - struct.d0), 0, 1);
            alt = struct.alt0 + (struct.alt1 - struct.alt0) * t;
        } else {
            alt = lerp(pA.alt, pB.alt, r);
        }

        return {
            dist: clampedDist,
            lon: lerp(pA.lon, pB.lon, r),
            lat: lerp(pA.lat, pB.lat, r),
            alt
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

        // 橋・トンネル範囲内であれば端部の高度を結ぶ直線勾配、それ以外は前後15m（計30mスパン）の標高差から算出
        const struct = this.getStructureAtDist(dist);
        let slope = 0;
        if (struct && struct.d1 - struct.d0 > 2) {
            const s0 = this.sampleAtDist(struct.d0);
            const s1 = this.sampleAtDist(struct.d1);
            slope = Math.round(((s1.alt - s0.alt) / (struct.d1 - struct.d0)) * 1000) / 10;
        } else {
            const bwdSlope = this.sampleAtDist(dist - 15);
            const fwdSlope = this.sampleAtDist(dist + 15);
            const roadDist = fwdSlope.dist - bwdSlope.dist;
            slope = roadDist > 5 ? Math.round(((fwdSlope.alt - bwdSlope.alt) / roadDist) * 1000) / 10 : 0;
        }

        return {
            u,
            distance: dist,
            lon: cur.lon,
            lat: cur.lat,
            alt: cur.alt,
            bearing: calcBearing(b0.lon, b0.lat, b1.lon, b1.lat),
            slope,
            structure: struct,
            fwdPoint: { lon: p1.lon, lat: p1.lat },
            bwdPoint: { lon: p0.lon, lat: p0.lat }
        };
    }

    static STRUCTURE_COLORS = {
        bridge: '#f59e0b', // 橋: アンバーオレンジ
        tunnel: '#a855f7'  // トンネル: バイオレットパープル
    };

    getStructureAtDist(dist) {
        const ranges = this.structureRanges;
        if (!ranges || !ranges.length) return null;
        for (const r of ranges) {
            if (dist >= r.d0 && dist <= r.d1) return r;
        }
        return null;
    }

    getRouteColorStops() {
        const total = this.totalDistance || 1;
        const STOPS = clamp(Math.round(total / 20), 64, 800);
        const rawProgress = [];
        for (let i = 0; i <= STOPS; i++) {
            rawProgress.push(i / STOPS);
        }

        const eps = Math.max(0.0001, 0.5 / total);
        for (const r of (this.structureRanges || [])) {
            const p0 = clamp(r.d0 / total, 0, 1);
            const p1 = clamp(r.d1 / total, 0, 1);
            if (p0 > eps) rawProgress.push(p0 - eps);
            rawProgress.push(p0);
            rawProgress.push(p1);
            if (p1 + eps < 1) rawProgress.push(p1 + eps);
        }

        rawProgress.sort((a, b) => a - b);

        const stops = [];
        let lastP = -1;
        for (const p of rawProgress) {
            if (p - lastP < 0.00005) continue;
            const dist = p * total;
            const struct = this.getStructureAtDist(dist);
            const color = struct
                ? (GeoCourseManager.STRUCTURE_COLORS[struct.type] || '#f59e0b')
                : GeoCourseManager.slopeToColor(this.getStateAtProgress(p).slope);
            stops.push([p, color]);
            lastP = p;
        }
        return stops;
    }

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
