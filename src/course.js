/**
 * GPX Parser & GeoCourseManager
 * Reads any standard GPX XML and creates smooth Catmull-Rom spline curves.
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

// デフォルトのサンプルコース: 本栖湖レイクサイドパノラマループ
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

    /**
     * Catmull-Rom 3D スプライン補間関数
     * 4点 (p0, p1, p2, p3) の間を t (0.0〜1.0) で滑らかに曲線補間
     */
    static catmullRom(p0, p1, p2, p3, t) {
        const t2 = t * t;
        const t3 = t2 * t;
        return 0.5 * (
            (2 * p1) +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t3
        );
    }

    initInterpolation() {
        const wps = this.rawWaypoints;
        const n = wps.length;

        // 1. 各区間を Catmull-Rom スプライン曲線で高密度サンプリング
        const splinePoints = [];
        const isClosed = (GeoCourseManager.haversineDistance(wps[0].lon, wps[0].lat, wps[n - 1].lon, wps[n - 1].lat) < 50);

        for (let i = 0; i < n - 1; i++) {
            // 前後の制御点
            let p0, p1 = wps[i], p2 = wps[i + 1], p3;

            if (i === 0) {
                p0 = isClosed ? wps[n - 2] : {
                    lon: p1.lon - (p2.lon - p1.lon),
                    lat: p1.lat - (p2.lat - p1.lat),
                    alt: p1.alt - (p2.alt - p1.alt)
                };
            } else {
                p0 = wps[i - 1];
            }

            if (i === n - 2) {
                p3 = isClosed ? wps[1] : {
                    lon: p2.lon + (p2.lon - p1.lon),
                    lat: p2.lat + (p2.lat - p1.lat),
                    alt: p2.alt + (p2.alt - p1.alt)
                };
            } else {
                p3 = wps[i + 2];
            }

            // 区間長に応じたサンプリング分割数（最低15分割、長ければ増やす）
            const segDist = GeoCourseManager.haversineDistance(p1.lon, p1.lat, p2.lon, p2.lat);
            const steps = Math.max(15, Math.round(segDist / 5)); // 5mピッチで美しいスプライン曲線を生成

            for (let step = 0; step < steps; step++) {
                const t = step / steps;
                const lon = GeoCourseManager.catmullRom(p0.lon, p1.lon, p2.lon, p3.lon, t);
                const lat = GeoCourseManager.catmullRom(p0.lat, p1.lat, p2.lat, p3.lat, t);
                const alt = GeoCourseManager.catmullRom(p0.alt, p1.alt, p2.alt, p3.alt, t);
                splinePoints.push({ lon, lat, alt });
            }
        }
        // 最終点追加
        splinePoints.push({ ...wps[n - 1] });

        // 2. スプライン曲線に沿った累積距離を計算
        this.cumDistances = [0];
        let total = 0;
        for (let i = 0; i < splinePoints.length - 1; i++) {
            const d = GeoCourseManager.haversineDistance(
                splinePoints[i].lon, splinePoints[i].lat,
                splinePoints[i + 1].lon, splinePoints[i + 1].lat
            );
            total += d;
            this.cumDistances.push(total);
        }
        this.totalDistance = total;

        // 3. 標高のガウシアン空間移動平均（~80m区間）で道路の自然な勾配に平滑化
        const SAMPLES = splinePoints.length;
        const windowHalfCount = Math.max(3, Math.round(40 / (total / SAMPLES)));

        this.interpolatedPoints = splinePoints.map((sample, idx) => {
            let sumAlt = 0;
            let sumWeight = 0;

            for (let offset = -windowHalfCount; offset <= windowHalfCount; offset++) {
                const targetIdx = Math.max(0, Math.min(SAMPLES - 1, idx + offset));
                const weight = Math.exp(-Math.pow(offset / (windowHalfCount * 0.6), 2));
                sumAlt += splinePoints[targetIdx].alt * weight;
                sumWeight += weight;
            }

            return {
                dist: this.cumDistances[idx],
                lon: sample.lon,
                lat: sample.lat,
                alt: sumWeight > 0 ? (sumAlt / sumWeight) : sample.alt
            };
        });
    }

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

        // 前後 25m の窓で接線 Bearing を算出（滑らかな旋回）
        const windowDist = Math.min(30, Math.max(12, this.totalDistance * 0.003));
        const forwardDist = Math.min(this.totalDistance, dist + windowDist);
        const backwardDist = Math.max(0, dist - windowDist);

        const fwdIdx = Math.min(sampleCount, Math.round((forwardDist / this.totalDistance) * sampleCount));
        const bwdIdx = Math.max(0, Math.round((backwardDist / this.totalDistance) * sampleCount));

        const fwdPt = this.interpolatedPoints[fwdIdx];
        const bwdPt = this.interpolatedPoints[bwdIdx];

        const bearing = GeoCourseManager.calcBearing(bwdPt.lon, bwdPt.lat, fwdPt.lon, fwdPt.lat);

        // 斜度計算
        const horizDist = GeoCourseManager.haversineDistance(bwdPt.lon, bwdPt.lat, fwdPt.lon, fwdPt.lat);
        let slope = horizDist > 0 ? ((fwdPt.alt - bwdPt.alt) / horizDist) * 100 : 0;
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

    // スプライン補間された高精度な全3D座標配列を返す（画面上のネオンコースライン用）
    toGeoJSONCoordinates() {
        return this.interpolatedPoints.map(p => [p.lon, p.lat, p.alt]);
    }
}
