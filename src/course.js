// 日本屈指のヒルクライム名所「ヤビツ峠（名古木交差点 〜 ヤビツ峠）」の実走コースデータ（緯度・経度・標高）
// 将来はGPXファイル等から動的インポート可能

export const YABITSU_PASS_ROUTE = [
    { lon: 139.2248, lat: 35.3721, alt: 96 },   // 名古木（スタート）
    { lon: 139.2255, lat: 35.3780, alt: 120 },
    { lon: 139.2272, lat: 35.3850, alt: 155 },
    { lon: 139.2310, lat: 35.3920, alt: 210 },
    { lon: 139.2335, lat: 35.4000, alt: 270 },
    { lon: 139.2360, lat: 35.4080, alt: 340 },
    { lon: 139.2385, lat: 35.4130, alt: 410 },  // 蓑毛（急勾配区間）
    { lon: 139.2360, lat: 35.4180, alt: 480 },
    { lon: 139.2330, lat: 35.4225, alt: 540 },
    { lon: 139.2365, lat: 35.4280, alt: 610 },  // 菜の花台展望台付近
    { lon: 139.2410, lat: 35.4320, alt: 670 },
    { lon: 139.2435, lat: 35.4370, alt: 720 },
    { lon: 139.2450, lat: 35.4415, alt: 761 }   // ヤビツ峠ゴール
];

export class GeoCourseManager {
    constructor(waypoints = YABITSU_PASS_ROUTE) {
        this.rawWaypoints = waypoints;
        this.interpolatedPoints = [];
        this.totalDistance = 0;
        this.cumDistances = [];
        this.initInterpolation();
    }

    // 2点間の球面距離計算（Haversine式: メートル単位）
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

        // 高密度サンプリング (1000点生成)
        const SAMPLES = 1000;
        for (let i = 0; i <= SAMPLES; i++) {
            const targetDist = (i / SAMPLES) * this.totalDistance;
            this.interpolatedPoints.push(this.getPointByDistance(targetDist));
        }
    }

    getPointByDistance(targetDist) {
        if (targetDist <= 0) return { ...this.rawWaypoints[0], bearing: 0, slope: 0 };
        if (targetDist >= this.totalDistance) {
            const last = this.rawWaypoints[this.rawWaypoints.length - 1];
            return { ...last, bearing: 0, slope: 0 };
        }

        // セグメント探索
        let segIdx = 0;
        for (let i = 0; i < this.cumDistances.length - 1; i++) {
            if (targetDist >= this.cumDistances[i] && targetDist <= this.cumDistances[i + 1]) {
                segIdx = i;
                break;
            }
        }

        const d0 = this.cumDistances[segIdx];
        const d1 = this.cumDistances[segIdx + 1];
        const ratio = (targetDist - d0) / (d1 - d0);

        const p0 = this.rawWaypoints[segIdx];
        const p1 = this.rawWaypoints[segIdx + 1];

        const lon = p0.lon + (p1.lon - p0.lon) * ratio;
        const lat = p0.lat + (p1.lat - p0.lat) * ratio;
        const alt = p0.alt + (p1.alt - p0.alt) * ratio;

        // 方位角（bearing）計算
        const y = Math.sin((p1.lon - p0.lon) * Math.PI / 180) * Math.cos(p1.lat * Math.PI / 180);
        const x = Math.cos(p0.lat * Math.PI / 180) * Math.sin(p1.lat * Math.PI / 180) -
                  Math.sin(p0.lat * Math.PI / 180) * Math.cos(p1.lat * Math.PI / 180) * Math.cos((p1.lon - p0.lon) * Math.PI / 180);
        let bearing = Math.atan2(y, x) * 180 / Math.PI;
        bearing = (bearing + 360) % 360;

        // 斜度計算
        const segDist = d1 - d0;
        const slope = segDist > 0 ? ((p1.alt - p0.alt) / segDist) * 100 : 0;

        return { lon, lat, alt, bearing, slope };
    }

    getStateAtProgress(progress) {
        const u = Math.max(0, Math.min(1, progress));
        const dist = u * this.totalDistance;
        const pt = this.getPointByDistance(dist);
        return {
            u,
            distance: dist,
            lon: pt.lon,
            lat: pt.lat,
            alt: pt.alt,
            bearing: pt.bearing,
            slope: pt.slope
        };
    }

    // GeoJSON LineString の座標配列形式を返す
    toGeoJSONCoordinates() {
        return this.interpolatedPoints.map(p => [p.lon, p.lat, p.alt]);
    }
}
