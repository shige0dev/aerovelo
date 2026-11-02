/**
 * GPX Parser & GeoCourseManager
 * Reads standard GPX XML and creates smooth routes with robust grade calculation.
 */

export class GPXParser {
    static parse(gpxText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(gpxText, 'application/xml');

        let points = Array.from(xmlDoc.querySelectorAll('trkpt'));
        if (points.length === 0) {
            points = Array.from(xmlDoc.querySelectorAll('rtept'));
        }

        if (points.length === 0) {
            throw new Error('GPXファイル内に有効なポイント (<trkpt> または <rtept>) が見つかりませんでした。');
        }

        const waypoints = [];
        for (const pt of points) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            const eleNode = pt.querySelector('ele');
            const alt = eleNode ? parseFloat(eleNode.textContent) : 0;

            if (!isNaN(lat) && !isNaN(lon)) {
                waypoints.push({ lon, lat, alt: isNaN(alt) ? 0 : alt });
            }
        }

        if (waypoints.length < 2) {
            throw new Error('コース作成には最低2点以上の座標が必要です。');
        }

        const nameNode = xmlDoc.querySelector('trk > name') || xmlDoc.querySelector('gpx > metadata > name');
        const courseName = nameNode ? nameNode.textContent.trim() : 'カスタムコース';

        return { courseName, waypoints };
    }
}

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
        this.initInterpolation();
    }

    static haversineDistance(lon1, lat1, lon2, lat2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    static calcBearing(lon1, lat1, lon2, lat2) {
        const y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
        const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
                  Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
        let bearing = Math.atan2(y, x) * 180 / Math.PI;
        return (bearing + 360) % 360;
    }

    initInterpolation() {
        this.interpolatedPoints = [];
        this.cumDistances = [0];
        let total = 0;

        for (let i = 0; i < this.rawWaypoints.length - 1; i++) {
            const p1 = this.rawWaypoints[i];
            const p2 = this.rawWaypoints[i + 1];
            const d = GeoCourseManager.haversineDistance(p1.lon, p1.lat, p2.lon, p2.lat);
            total += d;
            this.cumDistances.push(total);
        }
        this.totalDistance = total;

        // サンプリング（約5m間隔、最小1000点）
        const SAMPLES = Math.min(4000, Math.max(1000, Math.round(this.totalDistance / 5)));
        const rawSamples = [];
        for (let i = 0; i <= SAMPLES; i++) {
            const targetDist = (i / SAMPLES) * this.totalDistance;
            rawSamples.push({
                dist: targetDist,
                ...this.getRawPointByDistance(targetDist)
            });
        }

        // 標高のロバストな移動平均フィルター（約60m区間）
        // GPSの標高スパイクノイズを除去し、実際の道路の設計縦断勾配を抽出
        const SMOOTH_WINDOW_METERS = 60;
        const stepDist = this.totalDistance / SAMPLES;
        const windowHalfCount = Math.max(3, Math.round((SMOOTH_WINDOW_METERS / 2) / stepDist));

        this.interpolatedPoints = rawSamples.map((sample, idx) => {
            let sumAlt = 0;
            let count = 0;
            for (let offset = -windowHalfCount; offset <= windowHalfCount; offset++) {
                const targetIdx = idx + offset;
                if (targetIdx >= 0 && targetIdx <= SAMPLES) {
                    sumAlt += rawSamples[targetIdx].alt;
                    count++;
                }
            }
            return {
                dist: sample.dist,
                lon: sample.lon,
                lat: sample.lat,
                alt: count > 0 ? (sumAlt / count) : sample.alt
            };
        });
    }

    getRawPointByDistance(targetDist) {
        if (targetDist <= 0) return { ...this.rawWaypoints[0] };
        if (targetDist >= this.totalDistance) return { ...this.rawWaypoints[this.rawWaypoints.length - 1] };

        let segIdx = 0;
        for (let i = 0; i < this.cumDistances.length - 1; i++) {
            if (targetDist >= this.cumDistances[i] && targetDist <= this.cumDistances[i + 1]) {
                segIdx = i;
                break;
            }
        }

        const d0 = this.cumDistances[segIdx];
        const d1 = this.cumDistances[segIdx + 1];
        const ratio = (d1 - d0) > 0 ? (targetDist - d0) / (d1 - d0) : 0;

        const p0 = this.rawWaypoints[segIdx];
        const p1 = this.rawWaypoints[segIdx + 1];

        return {
            lon: p0.lon + (p1.lon - p0.lon) * ratio,
            lat: p0.lat + (p1.lat - p0.lat) * ratio,
            alt: p0.alt + (p1.alt - p0.alt) * ratio
        };
    }

    /**
     * 高精度ステート取得
     * - 方位角（Bearing）: 前後 25m の接線から算出
     * - 斜度（Slope %）: 道路沿い（走行距離基準）の標高差（Δh / Δd * 100）で算出
     *   ※ヘアピンカーブでも直線距離で割らないため、山岳地で斜度が急上昇するバグを根本解決
     */
    getStateAtProgress(progress) {
        const u = Math.max(0, Math.min(1, progress));
        const dist = u * this.totalDistance;

        if (this.interpolatedPoints.length === 0) {
            this.initInterpolation();
        }

        const sampleCount = this.interpolatedPoints.length - 1;
        const approxIdx = Math.min(sampleCount - 1, Math.max(0, Math.floor(u * sampleCount)));
        const pA = this.interpolatedPoints[approxIdx];
        const pB = this.interpolatedPoints[approxIdx + 1];
        const segRatio = (pB.dist - pA.dist) > 0 ? (dist - pA.dist) / (pB.dist - pA.dist) : 0;

        const currentLon = pA.lon + (pB.lon - pA.lon) * segRatio;
        const currentLat = pA.lat + (pB.lat - pA.lat) * segRatio;
        const currentAlt = pA.alt + (pB.alt - pA.alt) * segRatio;

        // 接線 Bearing 計算用の前後インデックス
        const windowDist = Math.min(30, Math.max(15, this.totalDistance * 0.003));
        const forwardDist = Math.min(this.totalDistance, dist + windowDist);
        const backwardDist = Math.max(0, dist - windowDist);

        const fwdIdx = Math.min(sampleCount, Math.round((forwardDist / this.totalDistance) * sampleCount));
        const bwdIdx = Math.max(0, Math.round((backwardDist / this.totalDistance) * sampleCount));

        const fwdPt = this.interpolatedPoints[fwdIdx];
        const bwdPt = this.interpolatedPoints[bwdIdx];

        const bearing = GeoCourseManager.calcBearing(bwdPt.lon, bwdPt.lat, fwdPt.lon, fwdPt.lat);

        // 斜度計算（道路に沿った走行距離基準 Δd）
        const roadDistance = fwdPt.dist - bwdPt.dist;
        let slope = 0;
        if (roadDistance > 5) {
            slope = ((fwdPt.alt - bwdPt.alt) / roadDistance) * 100;
        }

        // 小数点第1位に丸め
        slope = Math.round(slope * 10) / 10;

        return {
            u,
            distance: dist,
            lon: currentLon,
            lat: currentLat,
            alt: currentAlt,
            bearing,
            slope
        };
    }

    toGeoJSONCoordinates() {
        return this.interpolatedPoints.map(p => [p.lon, p.lat, p.alt]);
    }
}
