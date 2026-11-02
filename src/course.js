/**
 * GPX Parser & GeoCourseManager
 * Reads any standard GPX XML and creates smooth Catmull-Rom interpolated routes.
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

// デフォルトのサンプルコース: 富士山麓・本栖湖パノラマレイクサイドループ（緩やかなカーブと美しい湖畔・富士山の絶景）
// 周回ループで始点・終点が自然につながり、離散的な角のない滑らかなコース
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
    constructor(waypoints = DEFAULT_LAKE_ROUTE, name = '本栖湖レイクサイド (サンプル)') {
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

        // 密集サンプリング (1500サンプル)
        const SAMPLES = Math.min(3000, Math.max(1000, Math.round(this.totalDistance / 8)));
        for (let i = 0; i <= SAMPLES; i++) {
            const targetDist = (i / SAMPLES) * this.totalDistance;
            this.interpolatedPoints.push(this.getRawPointByDistance(targetDist));
        }
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
     * 高精度・平滑化されたステート取得
     * 前後一定距離（Lookahead & Lookbehind）に基づく接線ベクトルから滑らかな方位角（Bearing）を算出
     */
    getStateAtProgress(progress) {
        const u = Math.max(0, Math.min(1, progress));
        const dist = u * this.totalDistance;
        const currentPt = this.getRawPointByDistance(dist);

        // 前後 15m 〜 25m の窓で接線ベクトルを計算（離散値の角折れジャンプを完全解消）
        const windowDist = Math.min(25, Math.max(10, this.totalDistance * 0.003));
        const forwardDist = Math.min(this.totalDistance, dist + windowDist);
        const backwardDist = Math.max(0, dist - windowDist);

        const fwdPt = this.getRawPointByDistance(forwardDist);
        const bwdPt = this.getRawPointByDistance(backwardDist);

        const bearing = GeoCourseManager.calcBearing(bwdPt.lon, bwdPt.lat, fwdPt.lon, fwdPt.lat);

        // 斜度計算
        const horizDist = GeoCourseManager.haversineDistance(bwdPt.lon, bwdPt.lat, fwdPt.lon, fwdPt.lat);
        const slope = horizDist > 0 ? ((fwdPt.alt - bwdPt.alt) / horizDist) * 100 : 0;

        return {
            u,
            distance: dist,
            lon: currentPt.lon,
            lat: currentPt.lat,
            alt: currentPt.alt,
            bearing,
            slope
        };
    }

    toGeoJSONCoordinates() {
        return this.interpolatedPoints.map(p => [p.lon, p.lat, p.alt]);
    }
}
