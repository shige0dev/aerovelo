/**
 * GeoCourseManager
 * 3D Route Interpolation, Distance, Bearing, and Road-Grade Calculation Engine
 */

import { clamp, lerp, haversineDistance, calcBearing } from './utils.js';
import { fetchGsiDem10mElevations, fetchTerrainDemElevations } from './dem-service.js';
import { fetchOsmStructures } from './osm-structures.js';

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
        this.structureRanges = [];
        this.osmStructuresChecked = false;
        this.osmStatus = 'pending';
        this.osmSource = '';
        this.rawSamples = [];
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
        this.applyRoadGradeSmoothing(this.rawSamples);
        this.isGsiCorrected = isGsi;
        return true;
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
            const maxLen = cur.type === 'bridge' ? 1500 : 5000;
            const candidateEnd = Math.max(prev.d1, cur.d1);
            // 前後30m（計60m）の直線化範囲が重複・隣接する同種構造物は1つの区間に結合（最大長上限内）
            if (cur.type === prev.type && cur.d0 <= prev.d1 + 60 && (candidateEnd - prev.d0) <= maxLen) {
                prev.d1 = candidateEnd;
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
     * 高度データ自体の平滑化（ガウシアン加重移動平均、全幅 300m）
     * 10mメッシュ特有の法面・崖ノイズを除去し、高度グラフと道路メッシュの高さを滑らかに均す
     */
    smoothElevations(samples, alts, halfWindowMeters = 150) {
        const n = samples.length;
        const orig = Float64Array.from(alts);
        const sigma = halfWindowMeters / 3.0; // 3σ = 150m (全幅 300m)
        const twoSigmaSq = 2.0 * sigma * sigma;

        for (let i = 0; i < n; i++) {
            const curDist = samples[i].dist;
            let weightSum = 0.0;
            let valSum = 0.0;

            // 手前方向
            for (let j = i; j >= 0; j--) {
                const diff = curDist - samples[j].dist;
                if (diff > halfWindowMeters) break;
                const w = Math.exp(-(diff * diff) / twoSigmaSq);
                valSum += orig[j] * w;
                weightSum += w;
            }

            // 先方向
            for (let j = i + 1; j < n; j++) {
                const diff = samples[j].dist - curDist;
                if (diff > halfWindowMeters) break;
                const w = Math.exp(-(diff * diff) / twoSigmaSq);
                valSum += orig[j] * w;
                weightSum += w;
            }

            alts[i] = weightSum > 0 ? valSum / weightSum : orig[i];
        }
    }

    /**
     * 補正された高度算出
     * 10mメッシュから計算した標高を全幅300mで平滑化し、橋・トンネル区間を端部直線で結ぶ
     */
    applyRoadGradeSmoothing(samples) {
        const count = samples.length - 1;
        if (count < 2) {
            this.interpolatedPoints = samples.slice();
            return;
        }

        const alts = Float64Array.from(samples, (s) => s.alt);

        // 1. 高度データ自体の平滑化（全幅300m、ガウシアン加重移動平均）
        this.smoothElevations(samples, alts, 150);

        // 2. 橋・トンネル区間のみ、入口〜出口の端部路面標高（前後30m外側含む）を記録して直線で結ぶ
        this.linearizeStructures(samples, alts);

        for (let i = 0; i <= count; i++) {
            samples[i].alt = alts[i];
        }

        this.interpolatedPoints = samples.map((s, idx) => ({
            dist: s.dist,
            lon: s.lon,
            lat: s.lat,
            alt: alts[idx]
        }));
    }

    /**
     * 橋・トンネル区間の標高を、端点よりも前後30m外側の地点の高さに合わせ、その間を直線で結ぶ
     */
    linearizeStructures(samples, alts) {
        const ranges = this.structureRanges || [];
        if (!ranges.length) return;
        const n = samples.length;
        const orig = Float64Array.from(alts);
        const OFFSET = 30; // 端点よりも前後30m外まで含める

        const sampleAltAt = (targetD) => {
            let closestIdx = 0;
            let minDiff = Infinity;
            for (let i = 0; i < n; i++) {
                const diff = Math.abs(samples[i].dist - targetD);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestIdx = i;
                }
            }
            return orig[closestIdx];
        };

        for (const r of ranges) {
            const { d0, d1 } = r;
            const maxAllowedLen = r.type === 'bridge' ? 1500 : 5000;
            // 異常に長い構造物（またはコース全長の25%超）は直線化補正をスキップ
            if ((d1 - d0) > maxAllowedLen || (d1 - d0) > this.totalDistance * 0.25) {
                console.warn(`[linearizeStructures] Structure length ${Math.round(d1 - d0)}m exceeds limit (${maxAllowedLen}m), skipping.`, r);
                continue;
            }

            const extD0 = Math.max(0, d0 - OFFSET);
            const extD1 = Math.min(this.totalDistance, d1 + OFFSET);
            if (extD1 <= extD0) continue;

            // 前後30m外側の端の高さ
            const a0 = sampleAltAt(extD0);
            const a1 = sampleAltAt(extD1);
            r.alt0 = a0;
            r.alt1 = a1;
            r.extD0 = extD0;
            r.extD1 = extD1;

            // 前後30m外まで含めた全区間を端部直線で上書き
            for (let i = 0; i < n; i++) {
                const d = samples[i].dist;
                if (d >= extD0 && d <= extD1) {
                    const t = (d - extD0) / (extD1 - extD0);
                    alts[i] = a0 + (a1 - a0) * clamp(t, 0, 1);
                }
            }
        }
    }

    /**
     * 指定距離の補間点（lon, lat, alt）を取得
     * 構造物区間（前後30m外側含む）では端部直線高度を返し、通常区間では平滑化DEM標高を返す
     */
    sampleAtDist(targetDist) {
        const clampedDist = clamp(targetDist, 0, this.totalDistance);
        const pts = this.interpolatedPoints;
        const sampleCount = pts.length - 1;
        const exactIdx = (clampedDist / (this.totalDistance || 1)) * sampleCount;
        const idx = clamp(Math.floor(exactIdx), 0, sampleCount - 1);
        const r = exactIdx - idx;
        const pA = pts[idx], pB = pts[idx + 1];

        // 橋・トンネル区間内であれば、前後30m外側の高さを維持した直線標高を返す
        const struct = this.getStructureAtDist(clampedDist);
        let alt;
        if (struct && struct.alt0 != null && struct.alt1 != null) {
            const d0 = struct.extD0 ?? struct.d0;
            const d1 = struct.extD1 ?? struct.d1;
            if (d1 > d0) {
                const t = clamp((clampedDist - d0) / (d1 - d0), 0, 1);
                alt = struct.alt0 + (struct.alt1 - struct.alt0) * t;
            } else {
                alt = lerp(pA.alt, pB.alt, r);
            }
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

    /**
     * 指定距離地点における勾配（%）を算出
     * 平均範囲300m（前後150m、30m刻み、計11点）の高度から均等重み線形回帰トレンド勾配を計算
     * 大局的な標高トレンドを捉え、局所的な起伏や走行ラインのブレを完全に吸収
     */
    getSlopeAtDist(targetDist) {
        const clampedDist = clamp(targetDist, 0, this.totalDistance);
        const struct = this.getStructureAtDist(clampedDist);
        if (struct && struct.d1 - struct.d0 > 2) {
            const s0 = this.sampleAtDist(struct.d0);
            const s1 = this.sampleAtDist(struct.d1);
            return Math.round(((s1.alt - s0.alt) / (struct.d1 - struct.d0)) * 1000) / 10;
        }

        // 平均範囲300m（前後150m、30m刻み計11点）の均等重み最小二乗線形回帰トレンド
        // 相対距離: ±30m, ±60m, ±90m, ±120m, ±150m の標高差から大局的な勾配を導出
        const d = clampedDist;
        const h_m150 = this.sampleAtDist(d - 150).alt;
        const h_m120 = this.sampleAtDist(d - 120).alt;
        const h_m90  = this.sampleAtDist(d - 90).alt;
        const h_m60  = this.sampleAtDist(d - 60).alt;
        const h_m30  = this.sampleAtDist(d - 30).alt;
        const h_p30  = this.sampleAtDist(d + 30).alt;
        const h_p60  = this.sampleAtDist(d + 60).alt;
        const h_p90  = this.sampleAtDist(d + 90).alt;
        const h_p120 = this.sampleAtDist(d + 120).alt;
        const h_p150 = this.sampleAtDist(d + 150).alt;

        const num = 1.0 * (h_p30  - h_m30) +
                    2.0 * (h_p60  - h_m60) +
                    3.0 * (h_p90  - h_m90) +
                    4.0 * (h_p120 - h_m120) +
                    5.0 * (h_p150 - h_m150);

        // 分母定数 33.0 (99,000 / (100 * 30)) により数学的に 100% 正確な傾き（%）を導出
        return Math.round((num / 33.0) * 10) / 10;
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

        const slope = this.getSlopeAtDist(dist);

        return {
            u,
            distance: dist,
            lon: cur.lon,
            lat: cur.lat,
            alt: cur.alt,
            bearing: calcBearing(b0.lon, b0.lat, b1.lon, b1.lat),
            slope,
            structure: this.getStructureAtDist(dist),
            fwdPoint: { lon: p1.lon, lat: p1.lat },
            bwdPoint: { lon: p0.lon, lat: p0.lat }
        };
    }

    getStructureAtDist(dist) {
        const ranges = this.structureRanges;
        if (!ranges || !ranges.length) return null;
        for (const r of ranges) {
            const d0 = r.extD0 ?? r.d0;
            const d1 = r.extD1 ?? r.d1;
            if (dist >= d0 && dist <= d1) return r;
        }
        return null;
    }

    /**
     * 勾配（-20% ~ +20%）を 0.2% 刻みで色相変化させた RGB [r, g, b] (各 0.0 ~ 1.0) に変換
     * -20% : 青 (Hue 240°) - 下り坂
     *   0% : 緑 (Hue 120°) - 平坦
     * +20% : 赤 (Hue 0°)   - 激坂
     */
    static slopeToRgb(slope) {
        const clamped = clamp(slope, -20.0, 20.0);
        // 0.2% 刻みにステップ化（201段階）
        const stepped = Math.round(clamped / 0.2) * 0.2;
        // -20% -> 0.0, +20% -> 1.0
        const t = (stepped - (-20.0)) / 40.0;
        // 色相: -20% で 240度（青）、0% で 120度（緑）、+20% で 0度（赤）
        const hue = (1.0 - t) * 240.0;

        // HSL to RGB (Saturation: 0.9, Lightness: 0.5)
        const c = 0.9;
        const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
        const m = 0.5 - c / 2;
        let r = 0, g = 0, b = 0;
        if (hue >= 0 && hue < 60) {
            r = c; g = x; b = 0;
        } else if (hue >= 60 && hue < 120) {
            r = x; g = c; b = 0;
        } else if (hue >= 120 && hue < 180) {
            r = 0; g = c; b = x;
        } else if (hue >= 180 && hue < 240) {
            r = 0; g = x; b = c;
        } else {
            r = x; g = 0; b = c;
        }
        return [r + m, g + m, b + m];
    }
}
