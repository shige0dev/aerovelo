/**
 * GPX XML Parser, GSI 5m/10m DEM Tile Sampler, & AWS Terrarium Global DEM Sampler
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
 * 経度・緯度・ズームレベルから Webメルカトル タイル座標（tx, ty, px, py）を計算
 */
export function lonLatToTileCoords(lon, lat, z) {
    const n = 2 ** z;
    const xFloat = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const tx = Math.floor(xFloat), ty = Math.floor(yFloat);
    return { tx, ty, px: (xFloat - tx) * 256, py: (yFloat - ty) * 256 };
}

/**
 * 国土地理院 標高タイル（PNG）の RGB ピクセル値から標高(m)をデコード
 * 仕様: X = 2^16*R + 2^8*G + B. X < 2^23 なら h = X * 0.01m, X = 2^23 なら無効値, X > 2^23 なら h = (X - 2^24) * 0.01m
 */
export function decodeGsiPixel(r, g, b) {
    const x = (r << 16) | (g << 8) | b;
    if (x === 8388608 || (r === 0 && g === 0 && b === 0)) return null; // 無効値
    return x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01;
}

/**
 * 標高(m)から AWS Terrarium 形式の RGB ピクセル値をエンコード
 * 仕様: h = (R*256 + G + B/256) - 32768
 */
export function encodeTerrariumPixel(h) {
    if (h === null || isNaN(h)) return [0, 0, 0];
    const v = Math.round((h + 32768) * 256);
    const r = Math.max(0, Math.min(255, Math.floor(v / 65536)));
    const g = Math.max(0, Math.min(255, Math.floor((v % 65536) / 256)));
    const b = Math.max(0, Math.min(255, v % 256));
    return [r, g, b];
}

/**
 * 画像URLから ImageData を取得
 */
function fetchImagePixels(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 256;
                canvas.height = 256;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0, 256, 256);
                resolve(ctx.getImageData(0, 0, 256, 256).data);
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

/**
 * 🇯🇵 日本国内用：国土地理院 5mメッシュ（DEM5A PNG z=15）からコース標高を高精度サンプリング
 * （未計測の山岳部は DEM10B z=14 または DEM z=14 へシームレスに自動フォールバック）
 * @param {Array<{dist:number, lon:number, lat:number, alt:number}>} points
 * @param {Function} onProgress
 * @returns {Promise<{ elevations: number[], type: string }|null>}
 */
export async function fetchGsiDem5aElevations(points, onProgress = null) {
    if (!points || points.length === 0) return null;

    // ズーム15（1ピクセル≒約4〜5m）の必要タイルセットを抽出
    const z15Set = new Set();
    for (const p of points) {
        const { tx, ty } = lonLatToTileCoords(p.lon, p.lat, 15);
        z15Set.add(`${tx}/${ty}`);
    }

    const tileCache = new Map();
    let completed = 0;
    const totalTiles = z15Set.size;

    const loadTile = async (key) => {
        const [tx, ty] = key.split('/').map(Number);
        // 優先度1: DEM5A (5m航空レーザー測量)
        let data = await fetchImagePixels(`https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/15/${tx}/${ty}.png`);
        if (!data) {
            // 優先度2: DEM5B (5m写真測量)
            data = await fetchImagePixels(`https://cyberjapandata.gsi.go.jp/xyz/dem5b_png/15/${tx}/${ty}.png`);
        }
        if (!data) {
            // 優先度3: DEM10B (10mメッシュ z=14 をサンプリング)
            const z14x = Math.floor(tx / 2), z14y = Math.floor(ty / 2);
            data = await fetchImagePixels(`https://cyberjapandata.gsi.go.jp/xyz/dem10b_png/14/${z14x}/${z14y}.png`);
        }
        if (!data) {
            // 優先度4: DEM統合版 (z=14)
            const z14x = Math.floor(tx / 2), z14y = Math.floor(ty / 2);
            data = await fetchImagePixels(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/${z14x}/${z14y}.png`);
        }

        tileCache.set(key, data);
        completed++;
        onProgress?.(Math.round((completed / totalTiles) * 100));
    };

    // 並行タイル取得（通常コース全体で5〜15枚程度、計約100〜200KB）
    await Promise.all(Array.from(z15Set).map(loadTile));

    const sampleTilePixel = (data, px, py) => {
        if (!data) return null;
        const fx = px - 0.5, fy = py - 0.5;
        const x0 = Math.max(0, Math.min(255, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(255, Math.floor(fy)));
        const x1 = Math.min(255, x0 + 1);
        const y1 = Math.min(255, y0 + 1);
        const dx = Math.max(0, Math.min(1, fx - x0));
        const dy = Math.max(0, Math.min(1, fy - y0));

        const getAlt = (x, y) => {
            const idx = (y * 256 + x) * 4;
            return decodeGsiPixel(data[idx], data[idx + 1], data[idx + 2]);
        };

        const e00 = getAlt(x0, y0);
        const e10 = getAlt(x1, y0) ?? e00;
        const e01 = getAlt(x0, y1) ?? e00;
        const e11 = getAlt(x1, y1) ?? e10 ?? e00;

        if (e00 === null) return null;
        const top = e00 + (e10 - e00) * dx;
        const bot = e01 + (e11 - e01) * dx;
        return top + (bot - top) * dy;
    };

    let validCount = 0;
    const elevations = points.map((p) => {
        const { tx, ty, px, py } = lonLatToTileCoords(p.lon, p.lat, 15);
        const data = tileCache.get(`${tx}/${ty}`);
        const alt = sampleTilePixel(data, px, py);
        if (alt !== null) {
            validCount++;
            return alt;
        }
        return p.alt;
    });

    if (validCount === 0) return null;
    return { elevations, type: 'DEM5A' };
}

/**
 * 🌍 海外用 / グローバルフォールバック：AWS Terrarium DEM（約30mメッシュ）からコース標高をサンプリング
 * @param {Array<{dist:number, lon:number, lat:number, alt:number}>} points
 * @returns {Promise<number[]|null>}
 */
export async function fetchTerrainDemElevations(points) {
    if (!points || points.length === 0) return null;

    let zoom = 14;
    const countTiles = (z) => {
        const set = new Set();
        for (const p of points) {
            const { tx, ty } = lonLatToTileCoords(p.lon, p.lat, z);
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
    const loadTile = async (key) => {
        const data = await fetchImagePixels(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${key}.png?_c=1`);
        if (data) tilePixels.set(key, data);
    };

    await Promise.all(Array.from(tileKeys).map(loadTile));
    if (tilePixels.size === 0) return null;

    const decodePixel = (data, x, y) => {
        const cx = Math.max(0, Math.min(255, x));
        const cy = Math.max(0, Math.min(255, y));
        const idx = (cy * 256 + cx) * 4;
        return (data[idx] * 256 + data[idx + 1] + data[idx + 2] / 256) - 32768;
    };

    return points.map((p) => {
        const { tx, ty, px, py } = lonLatToTileCoords(p.lon, p.lat, zoom);
        const data = tilePixels.get(`${tx}/${ty}`);
        if (!data) return p.alt;

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
