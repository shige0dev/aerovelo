/**
 * GPX XML Parser & GSI (Geospatial Information Authority of Japan) 5m DEM API Client
 */

export class GPXParser {
    static parse(gpxText) {
        const xmlDoc = new DOMParser().parseFromString(gpxText, 'application/xml');
        let points = Array.from(xmlDoc.querySelectorAll('trkpt'));
        if (points.length === 0) points = Array.from(xmlDoc.querySelectorAll('rtept'));
        if (points.length === 0) {
            throw new Error('GPXファイル内に有効なポイント (<trkpt> または <rtept>) が見つかりませんでした。');
        }

        const waypoints = [];
        for (const pt of points) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            const alt = parseFloat(pt.querySelector('ele')?.textContent);
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

/**
 * 国土地理院 標高API（DEM5A 5mレーザーメッシュ最優先）からコース標高を一括取得・補間
 * @param {Array<{lon:number, lat:number, alt:number}>} rawWaypoints
 * @param {number} totalDistance
 * @param {Function} onProgress (pct, completed, total)
 */
export async function fetchGsi5mWaypoints(rawWaypoints, totalDistance, onProgress = null) {
    const totalPts = rawWaypoints.length;
    const targetCount = Math.min(180, Math.max(60, Math.round(totalDistance / 70)));
    const step = Math.max(1, Math.floor(totalPts / targetCount));

    const sampledIndices = [];
    for (let i = 0; i < totalPts; i += step) sampledIndices.push(i);
    if (sampledIndices[sampledIndices.length - 1] !== totalPts - 1) {
        sampledIndices.push(totalPts - 1);
    }

    const newAltitudes = new Array(sampledIndices.length);
    const concurrency = 6;
    let completed = 0;

    const fetchOne = async (sIdx, ptIdx) => {
        const pt = rawWaypoints[ptIdx];
        const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${pt.lon.toFixed(6)}&lat=${pt.lat.toFixed(6)}&outtype=JSON`;
        try {
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                if (typeof data?.elevation === 'number') {
                    newAltitudes[sIdx] = data.elevation;
                    return;
                }
            }
        } catch {
            // 通信エラー時は元の標高値をフォールバック保持
        }
        newAltitudes[sIdx] = pt.alt;
    };

    for (let i = 0; i < sampledIndices.length; i += concurrency) {
        const batch = sampledIndices.slice(i, i + concurrency).map((ptIdx, offset) => {
            const sIdx = i + offset;
            return fetchOne(sIdx, ptIdx).then(() => {
                completed++;
                onProgress?.(Math.round((completed / sampledIndices.length) * 100), completed, sampledIndices.length);
            });
        });
        await Promise.all(batch);
    }

    // 取得したサンプル標高を全ウェイポイントへ線形補間マッピング
    let s = 0;
    return rawWaypoints.map((pt, origIdx) => {
        while (s < sampledIndices.length - 2 && origIdx > sampledIndices[s + 1]) s++;
        const idx0 = sampledIndices[s], idx1 = sampledIndices[s + 1];
        const ratio = idx1 > idx0 ? (origIdx - idx0) / (idx1 - idx0) : 0;
        const alt = newAltitudes[s] + (newAltitudes[s + 1] - newAltitudes[s]) * ratio;
        return { lon: pt.lon, lat: pt.lat, alt: Math.round(alt * 10) / 10 };
    });
}
