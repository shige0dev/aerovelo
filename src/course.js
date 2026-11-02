// ヤビツ峠（名古木交差点 〜 善波入口 〜 蓑毛 〜 菜の花台 〜 ヤビツ峠頂上）
// 神奈川県道70号秦野清川線の実走カーブ・標高を忠実にトレースした高密度GPSウェイポイント

export const YABITSU_PASS_ROUTE = [
    { lon: 139.2438, lat: 35.3688, alt: 96 },   // 名古木交差点 (スタート)
    { lon: 139.2415, lat: 35.3732, alt: 110 },
    { lon: 139.2392, lat: 35.3775, alt: 125 },
    { lon: 139.2370, lat: 35.3812, alt: 140 },  // 落合交差点
    { lon: 139.2355, lat: 35.3855, alt: 165 },
    { lon: 139.2348, lat: 35.3892, alt: 188 },
    { lon: 139.2335, lat: 35.3940, alt: 220 },
    { lon: 139.2320, lat: 35.3985, alt: 255 },  // 蓑毛バス停手前
    { lon: 139.2325, lat: 35.4020, alt: 295 },  // 蓑毛の激坂区間（最大10-14%）
    { lon: 139.2340, lat: 35.4055, alt: 345 },
    { lon: 139.2348, lat: 35.4090, alt: 395 },
    { lon: 139.2332, lat: 35.4120, alt: 440 },  // つづら折り第1コーナー
    { lon: 139.2295, lat: 35.4138, alt: 470 },
    { lon: 139.2275, lat: 35.4162, alt: 498 },
    { lon: 139.2290, lat: 35.4185, alt: 525 },  // ヘアピン
    { lon: 139.2325, lat: 35.4195, alt: 550 },
    { lon: 139.2350, lat: 35.4225, alt: 575 },
    { lon: 139.2345, lat: 35.4255, alt: 605 },  // 菜の花台展望台付近
    { lon: 139.2328, lat: 35.4282, alt: 635 },
    { lon: 139.2345, lat: 35.4310, alt: 660 },
    { lon: 139.2372, lat: 35.4335, alt: 685 },
    { lon: 139.2385, lat: 35.4362, alt: 710 },
    { lon: 139.2405, lat: 35.4385, alt: 735 },
    { lon: 139.2422, lat: 35.4410, alt: 755 },
    { lon: 139.2435, lat: 35.4428, alt: 761 }   // ヤビツ峠頂上 (ゴール)
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

        // 1200サンプルの高密度補間
        const SAMPLES = 1200;
        for (let i = 0; i <= SAMPLES; i++) {
            const targetDist = (i / SAMPLES) * this.totalDistance;
            this.interpolatedPoints.push(this.getPointByDistance(targetDist));
        }
    }

    getPointByDistance(targetDist) {
        if (targetDist <= 0) return { ...this.rawWaypoints[0], bearing: 0, slope: 4.2 };
        if (targetDist >= this.totalDistance) {
            const last = this.rawWaypoints[this.rawWaypoints.length - 1];
            return { ...last, bearing: 0, slope: 2.5 };
        }

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

    toGeoJSONCoordinates() {
        return this.interpolatedPoints.map(p => [p.lon, p.lat, p.alt]);
    }
}
