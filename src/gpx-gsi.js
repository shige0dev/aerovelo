/**
 * GPX XML Parser, 3D Terrain DEM Tile Sampler, & GSI 5m DEM API Client
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
 * 3Dマップと同一の Terrarium DEM タイルからバイリニア補間でコース上の標高を高精度サンプリング
 * （3D画面の地形・等高線とコース標高・勾配を完全一致させる）
 * @param {Array<{dist:number, lon:number, lat:number, alt:number}>} points
 * @returns {Promise<number[]|null>}
 */
export async function fetchTerrainDemElevations(points) {
    if (!points || points.length === 0) return null;

    const toTileCoords = (lon, lat, z) => {
        const n = 2 ** z;
        const xFloat = ((lon + 180) / 360) * n;
        const latRad = (lat * Math.PI) / 180;
        const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
        const tx = Math.floor(xFloat), ty = Math.floor(yFloat);
        return { tx, ty, px: (xFloat - tx) * 256, py: (yFloat - ty) * 256 };
    };

    // タイル数が36枚以下なら最大解像度 zoom=14、長距離コースなら zoom=13 を選択
    let zoom = 14;
    const countTiles = (z) => {
        const set = new Set();
        for (const p of points) {
            const { tx, ty } = toTileCoords(p.lon, p.lat, z);
            set.add(`${tx}/${ty}`);
        }
        return set;
    };
    let tileKeys = countTiles(zoom);
    if (tileKeys.size > 36) {
        zoom = 13;
        tileKeys = countTiles(zoom);
    }

    const tilePixels = new Map();
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const loadTile = (key) => new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                ctx.clearRect(0, 0, 256, 256);
                ctx.drawImage(img, 0, 0, 256, 256);
                tilePixels.set(key, ctx.getImageData(0, 0, 256, 256).data);
            } catch {
                // ignore canvas taint error
            }
            resolve();
        };
        img.onerror = () => resolve();
        img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${key}.png`;
    });

    await Promise.all(Array.from(tileKeys).map(loadTile));
    if (tilePixels.size === 0) return null;

    const decodePixel = (data, x, y) => {
        const cx = Math.max(0, Math.min(255, x));
        const cy = Math.max(0, Math.min(255, y));
        const idx = (cy * 256 + cx) * 4;
        return (data[idx] * 256 + data[idx + 1] + data[idx + 2] / 256) - 32768;
    };

    return points.map((p) => {
        const { tx, ty, px, py } = toTileCoords(p.lon, p.lat, zoom);
        const data = tilePixels.get(`${tx}/${ty}`);
        if (!data) return p.alt;

        // ピクセル中心基準のバイリニア補間
        const fx = px - 0.5, fy = py - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const dx = fx - x0, dy = fy - y0;

        const e00 = decodePixel(data, x0, y0);
        const e10 = decodePixel(data, x0 + 1, y0);
        const e01 = decodePixel(data, x0, y0 + 1);
        const e11 = decodePixel(data, x0 + 1, y0 + 1);

        const top = e00 + (e10 - e00) * dx;
        const bot = e01 + (e11 - e01) * dx;
        return top + (bot - top) * dy;
    });
}

/**
 * 国土地理院 標高API（DEM5A 5mレーザーメッシュ最優先）から等距離間隔でコース標高を取得・補間
 * @param {Array<{dist:number, lon:number, lat:number, alt:number}>} interpolatedPoints
 * @param {number} totalDistance
 * @param {Function} onProgress (pct, completed, total)
 */
export async function fetchGsi5mWaypoints(interpolatedPoints, totalDistance, onProgress = null) {
    const totalPts = interpolatedPoints.length;
    const targetCount = Math.min(220, Math.max(80, Math.round(totalDistance / 50)));
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
        const pt = interpolatedPoints[ptIdx];
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

    // 等距離サンプル点から全補間ポイントへ線形補間マッピング
    let s = 0;
    return interpolatedPoints.map((pt, origIdx) => {
        while (s < sampledIndices.length - 2 && origIdx > sampledIndices[s + 1]) s++;
        const idx0 = sampledIndices[s], idx1 = sampledIndices[s + 1];
        const ratio = idx1 > idx0 ? (origIdx - idx0) / (idx1 - idx0) : 0;
        const alt = newAltitudes[s] + (newAltitudes[s + 1] - newAltitudes[s]) * ratio;
        return { dist: pt.dist, lon: pt.lon, lat: pt.lat, alt: Math.round(alt * 100) / 100 };
    });
}
