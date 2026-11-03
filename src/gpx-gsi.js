/**
 * GPX XML Parser, GSI 10m DEM Tile Sampler (dem_png z=14), & AWS Terrarium Global DEM Sampler
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
    if (x === 8388608 || (r === 0 && g === 0 && b === 0)) return null; // 無効値 (NoData)
    return x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01;
}

/**
 * 256x256 の国土地理院 DEM PNG ピクセル配列 (RGBA) を標高配列 Float32Array(65536) にデコードし、
 * 水面等の無効値 (NoData) ピクセルを周囲の水際標高（沿岸部は0m）でシームレスに補完する
 */
export function decodeAndFillGsiTile(rgba) {
    const N = 256;
    const grid = new Float32Array(N * N);
    let validCount = 0;
    let minValid = Infinity;

    for (let i = 0; i < N * N; i++) {
        const idx = i * 4;
        const h = decodeGsiPixel(rgba[idx], rgba[idx + 1], rgba[idx + 2]);
        if (h !== null) {
            grid[i] = h;
            validCount++;
            if (h < minValid) minValid = h;
        } else {
            grid[i] = NaN;
        }
    }

    if (validCount === 0) return null;
    if (validCount === N * N) return grid;

    // 沿岸・海域タイル（最小有効標高 5m 以下）の無効値は海面 (0m) で埋める
    if (minValid <= 5) {
        for (let i = 0; i < N * N; i++) {
            if (isNaN(grid[i])) grid[i] = 0;
        }
        return grid;
    }

    // 内陸・山間部タイルの水面（ダム湖・河川等の NoData）は 4方向の直近水際標高の最小値で平坦に補完
    const fillVal = new Float32Array(N * N);
    fillVal.fill(Infinity);

    for (let y = 0; y < N; y++) {
        const row = y * N;
        let last = Infinity;
        for (let x = 0; x < N; x++) {
            const v = grid[row + x];
            if (!isNaN(v)) last = v;
            else if (last < fillVal[row + x]) fillVal[row + x] = last;
        }
        last = Infinity;
        for (let x = N - 1; x >= 0; x--) {
            const v = grid[row + x];
            if (!isNaN(v)) last = v;
            else if (last < fillVal[row + x]) fillVal[row + x] = last;
        }
    }

    for (let x = 0; x < N; x++) {
        let last = Infinity;
        for (let y = 0; y < N; y++) {
            const idx = y * N + x;
            const v = grid[idx];
            if (!isNaN(v)) last = v;
            else if (last < fillVal[idx]) fillVal[idx] = last;
        }
        last = Infinity;
        for (let y = N - 1; y >= 0; y--) {
            const idx = y * N + x;
            const v = grid[idx];
            if (!isNaN(v)) last = v;
            else if (last < fillVal[idx]) fillVal[idx] = last;
        }
    }

    for (let i = 0; i < N * N; i++) {
        if (isNaN(grid[i])) {
            grid[i] = fillVal[i] < Infinity ? fillVal[i] : minValid;
        }
    }

    return grid;
}

/**
 * 標高(m)から AWS Terrarium 形式の RGB ピクセル値をエンコード
 * 仕様: h = (R*256 + G + B/256) - 32768
 */
export function encodeTerrariumPixel(h) {
    if (h === null || isNaN(h)) return [128, 0, 0];
    const v = Math.round((h + 32768) * 256);
    const r = Math.max(0, Math.min(255, Math.floor(v / 65536)));
    const g = Math.max(0, Math.min(255, Math.floor((v % 65536) / 256)));
    const b = Math.max(0, Math.min(255, v % 256));
    return [r, g, b];
}

/**
 * 画像URLから ImageData.data を取得（fetch + createImageBitmap で高速・高信頼性取得）
 */
async function fetchImagePixels(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        const img = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 256, 256);
        return ctx.getImageData(0, 0, 256, 256).data;
    } catch {
        return null;
    }
}

/**
 * 🇯🇵 日本国内用：国土地理院 10mメッシュ（dem_png / DEM10B z=14）からコース標高を統一サンプリング
 * （全国100%網羅・ズーム14統一により位置ズレゼロ・水面陥没ゼロ）
 * @param {Array<{dist:number, lon:number, lat:number, alt:number}>} points
 * @param {Function} onProgress
 * @returns {Promise<{ elevations: number[], type: string }|null>}
 */
export async function fetchGsiDem10mElevations(points, onProgress = null) {
    if (!points || points.length === 0) return null;

    const ZOOM = 14;
    const z14Set = new Set();
    for (const p of points) {
        const { tx, ty } = lonLatToTileCoords(p.lon, p.lat, ZOOM);
        z14Set.add(`${tx}/${ty}`);
    }

    const tileCache = new Map();
    let completed = 0;
    const totalTiles = z14Set.size;

    const loadTile = async (key) => {
        const [tx, ty] = key.split('/').map(Number);
        const rgba = await fetchImagePixels(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${ZOOM}/${tx}/${ty}.png`);
        const grid = rgba ? decodeAndFillGsiTile(rgba) : null;
        tileCache.set(key, grid);
        completed++;
        onProgress?.(Math.round((completed / totalTiles) * 100));
    };

    await Promise.all(Array.from(z14Set).map(loadTile));

    const sampleTileGrid = (grid, px, py) => {
        if (!grid) return null;
        const fx = px - 0.5, fy = py - 0.5;
        const x0 = Math.max(0, Math.min(255, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(255, Math.floor(fy)));
        const x1 = Math.min(255, x0 + 1);
        const y1 = Math.min(255, y0 + 1);
        const dx = Math.max(0, Math.min(1, fx - x0));
        const dy = Math.max(0, Math.min(1, fy - y0));

        const e00 = grid[y0 * 256 + x0];
        const e10 = grid[y0 * 256 + x1];
        const e01 = grid[y1 * 256 + x0];
        const e11 = grid[y1 * 256 + x1];

        const top = e00 + (e10 - e00) * dx;
        const bot = e01 + (e11 - e01) * dx;
        return top + (bot - top) * dy;
    };

    let validCount = 0;
    const elevations = points.map((p) => {
        const { tx, ty, px, py } = lonLatToTileCoords(p.lon, p.lat, ZOOM);
        const grid = tileCache.get(`${tx}/${ty}`);
        const alt = sampleTileGrid(grid, px, py);
        if (alt !== null && !isNaN(alt)) {
            validCount++;
            return alt;
        }
        return p.alt;
    });

    if (validCount === 0) return null;
    return { elevations, type: 'DEM10B' };
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
