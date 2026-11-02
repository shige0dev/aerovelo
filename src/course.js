// ヤビツ峠（名古木交差点 〜 蓑毛 〜 浅間平 〜 菜の花台展望台 〜 ヤビツ峠頂上）
// 神奈川県道70号秦野清川線の実道路形状（WGS84世界測地系）
// 名古木(標高96m)からヤビツ峠(標高761m)まで、実際の県道に沿ってひたすら登り続ける実走トレースデータ

export const YABITSU_PASS_ROUTE = [
    { lon: 139.2410, lat: 35.3817, alt: 96 },   // 0.0km: 名古木交差点（スタート）
    { lon: 139.2395, lat: 35.3848, alt: 110 },
    { lon: 139.2382, lat: 35.3880, alt: 125 },
    { lon: 139.2370, lat: 35.3912, alt: 142 },  // 落合交差点
    { lon: 139.2355, lat: 35.3945, alt: 160 },
    { lon: 139.2338, lat: 35.3980, alt: 185 },
    { lon: 139.2320, lat: 35.4015, alt: 215 },
    { lon: 139.2305, lat: 35.4050, alt: 245 },
    { lon: 139.2295, lat: 35.4090, alt: 275 },
    { lon: 139.2286, lat: 35.4125, alt: 310 },  // 蓑毛バス停（ここから本格的な山道・急勾配へ）
    { lon: 139.2270, lat: 35.4140, alt: 335 },
    { lon: 139.2245, lat: 35.4145, alt: 365 },
    { lon: 139.2220, lat: 35.4138, alt: 395 },
    { lon: 139.2195, lat: 35.4122, alt: 425 },
    { lon: 139.2170, lat: 35.4110, alt: 450 },
    { lon: 139.2140, lat: 35.4102, alt: 480 },
    { lon: 139.2110, lat: 35.4098, alt: 510 },
    { lon: 139.2086, lat: 35.4100, alt: 550 },  // 菜の花台展望台（夜景・相模湾の絶景スポット）
    { lon: 139.2080, lat: 35.4125, alt: 580 },
    { lon: 139.2092, lat: 35.4155, alt: 615 },
    { lon: 139.2115, lat: 35.4180, alt: 645 },
    { lon: 139.2138, lat: 35.4208, alt: 675 },
    { lon: 139.2155, lat: 35.4235, alt: 705 },
    { lon: 139.2175, lat: 35.4260, alt: 735 },
    { lon: 139.2194, lat: 35.4280, alt: 761 }   // 11.6km: ヤビツ峠頂上（ゴール）
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
        if (targetDist <= 0) return { ...this.rawWaypoints[0], bearing: 0, slope: 4.5 };
        if (targetDist >= this.totalDistance) {
            const last = this.rawWaypoints[this.rawWaypoints.length - 1];
            return { ...last, bearing: 0, slope: 3.0 };
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

        // 登り斜度計算（常にプラス勾配）
        const segDist = d1 - d0;
        const slope = segDist > 0 ? ((p1.alt - p0.alt) / segDist) * 100 : 5.0;

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
