/**
 * GPX XML Parser, 3D Terrain DEM Tile Sampler, Marching Squares Contour Generator, & GSI 5m DEM Client
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
 * 3Dマップと同一の Terrarium DEM タイルから
 * 1) バイリニア補間によるコース標高配列
 * 2) マーチング・スクエア法によるコース周辺の 5m / 2.5m 間隔等高線 GeoJSON
 * を一括計算して返す
 * @param {Array<{dist:number, lon:number, lat:number, alt:number}>} points
 * @returns {Promise<{elevations: number[], contourGeoJSON: object}|null>}
 */
export async function fetchTerrainDemData(points) {
    if (!points || points.length === 0) return null;

    const toTileCoords = (lon, lat, z) => {
        const n = 2 ** z;
        const xFloat = ((lon + 180) / 360) * n;
        const latRad = (lat * Math.PI) / 180;
        const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
        const tx = Math.floor(xFloat), ty = Math.floor(yFloat);
        return { tx, ty, px: (xFloat - tx) * 256, py: (yFloat - ty) * 256 };
    };

    // 周辺領域も含めてタイル数が40枚以下なら最大解像度 zoom=14、長距離コースなら zoom=13
    let zoom = 14;
    const collectTileKeys = (z) => {
        const set = new Set();
        for (const p of points) {
            // コース周辺 ±400m 分のタイルもカバーする
            for (const dLon of [-0.004, 0, 0.004]) {
                for (const dLat of [-0.004, 0, 0.004]) {
                    const { tx, ty } = toTileCoords(p.lon + dLon, p.lat + dLat, z);
                    set.add(`${tx}/${ty}`);
                }
            }
        }
        return set;
    };

    let tileKeys = collectTileKeys(zoom);
    if (tileKeys.size > 40) {
        zoom = 13;
        tileKeys = collectTileKeys(zoom);
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

    // 任意の (lon, lat) のバイリニア補間標高を取得
    const sampleRawDem = (lon, lat) => {
        const { tx, ty, px, py } = toTileCoords(lon, lat, zoom);
        const data = tilePixels.get(`${tx}/${ty}`);
        if (!data) return null;

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
    };

    // ピクセル境界の折れを滑らかにする5点ガウシアン風サンプリング
    const sampleSmoothDem = (lon, lat) => {
        const c = sampleRawDem(lon, lat);
        if (c === null) return null;
        const d = 0.00008; // 約8mオフセット
        const n = sampleRawDem(lon, lat + d) ?? c;
        const s = sampleRawDem(lon, lat - d) ?? c;
        const e = sampleRawDem(lon + d, lat) ?? c;
        const w = sampleRawDem(lon - d, lat) ?? c;
        return c * 0.4 + (n + s + e + w) * 0.15;
    };

    // 1. コース上の標高配列を算出
    const elevations = points.map((p) => sampleSmoothDem(p.lon, p.lat) ?? p.alt);

    // 2. コース周辺コリドーの 5m / 2.5m 等高線 GeoJSON をマーチング・スクエア法で生成
    const contourGeoJSON = buildCorridorContours(points, sampleSmoothDem);

    return { elevations, contourGeoJSON };
}

/**
 * マーチング・スクエア法（Marching Squares）でコース周辺（約±350m）の 5m / 2.5m 等高線を生成
 */
function buildCorridorContours(points, sampleFn) {
    // 1ブロック = 0.002° (約200m四方) とし、コースから ±1ブロック (約±350m) をアクティブ領域とする
    const BLOCK_DEG = 0.002;
    const SUB_DIV = 12; // 1ブロック内を12×12分割 (約16mメッシュ)
    const activeBlocks = new Set();

    // 長距離コースでも高速に動作するよう間引いてブロック登録
    const stride = Math.max(1, Math.floor(points.length / 800));
    for (let i = 0; i < points.length; i += stride) {
        const p = points[i];
        const bx = Math.floor(p.lon / BLOCK_DEG);
        const by = Math.floor(p.lat / BLOCK_DEG);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                activeBlocks.add(`${bx + dx},${by + dy}`);
            }
        }
    }

    const minorLines = []; // 2.5m 間隔 (level: 0)
    const majorLines = []; // 5.0m 間隔 (level: 1)

    // マーチング・スクエアの16ケースのエッジ接続定義 (0:上, 1:右, 2:下, 3:左)
    const MS_CASES = [
        [],             // 0
        [[3, 2]],       // 1
        [[2, 1]],       // 2
        [[3, 1]],       // 3
        [[0, 1]],       // 4
        [[0, 3], [2, 1]], // 5 (saddle)
        [[0, 2]],       // 6
        [[3, 0]],       // 7
        [[0, 3]],       // 8
        [[0, 2]],       // 9
        [[0, 1], [3, 2]], // 10 (saddle)
        [[0, 1]],       // 11
        [[3, 1]],       // 12
        [[2, 1]],       // 13
        [[3, 2]],       // 14
        []              // 15
    ];

    const stepDeg = BLOCK_DEG / SUB_DIV;
    const elevCache = new Map();
    const getGridElev = (gx, gy) => {
        const key = `${gx},${gy}`;
        let val = elevCache.get(key);
        if (val === undefined) {
            val = sampleFn(gx * stepDeg, gy * stepDeg);
            elevCache.set(key, val);
        }
        return val;
    };

    for (const blockKey of activeBlocks) {
        const [bx, by] = blockKey.split(',').map(Number);
        const baseGx = bx * SUB_DIV;
        const baseGy = by * SUB_DIV;

        for (let ix = 0; ix < SUB_DIV; ix++) {
            const gx = baseGx + ix;
            const lon0 = gx * stepDeg;
            const lon1 = (gx + 1) * stepDeg;

            for (let iy = 0; iy < SUB_DIV; iy++) {
                const gy = baseGy + iy;
                const lat0 = gy * stepDeg;
                const lat1 = (gy + 1) * stepDeg;

                // 4隅の標高 (v0:左上, v1:右上, v2:右下, v3:左下)
                const v0 = getGridElev(gx, gy + 1);
                const v1 = getGridElev(gx + 1, gy + 1);
                const v2 = getGridElev(gx + 1, gy);
                const v3 = getGridElev(gx, gy);
                if (v0 === null || v1 === null || v2 === null || v3 === null) continue;

                const minV = Math.min(v0, v1, v2, v3);
                const maxV = Math.max(v0, v1, v2, v3);
                if (maxV - minV < 0.05 || maxV - minV > 120) continue;

                // 2.5m 刻みのインデックス k (偶数 = 5.0m 間隔, 奇数 = 2.5m 間隔)
                const kStart = Math.ceil(minV / 2.5);
                const kEnd = Math.floor(maxV / 2.5);

                for (let k = kStart; k <= kEnd; k++) {
                    const iso = k * 2.5;
                    const mask = (v0 >= iso ? 8 : 0) | (v1 >= iso ? 4 : 0) | (v2 >= iso ? 2 : 0) | (v3 >= iso ? 1 : 0);
                    const pairs = MS_CASES[mask];
                    if (!pairs || pairs.length === 0) continue;

                    const edgePt = (edge) => {
                        if (edge === 0) {
                            const t = (iso - v0) / (v1 - v0 || 1e-6);
                            return [lon0 + (lon1 - lon0) * t, lat1];
                        }
                        if (edge === 1) {
                            const t = (iso - v2) / (v1 - v2 || 1e-6);
                            return [lon1, lat0 + (lat1 - lat0) * t];
                        }
                        if (edge === 2) {
                            const t = (iso - v3) / (v2 - v3 || 1e-6);
                            return [lon0 + (lon1 - lon0) * t, lat0];
                        }
                        const t = (iso - v3) / (v0 - v3 || 1e-6);
                        return [lon0, lat0 + (lat1 - lat0) * t];
                    };

                    const targetArr = (k % 2 === 0) ? majorLines : minorLines;
                    for (const [eA, eB] of pairs) {
                        targetArr.push([edgePt(eA), edgePt(eB)]);
                    }
                }
            }
        }
    }

    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { level: 0 },
                geometry: { type: 'MultiLineString', coordinates: minorLines }
            },
            {
                type: 'Feature',
                properties: { level: 1 },
                geometry: { type: 'MultiLineString', coordinates: majorLines }
            }
        ]
    };
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
