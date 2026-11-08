/**
 * 3D Terrain DEM Service
 * Handles GSI 10m (dem_png) & AWS Terrarium DEM protocols, tile sampling, pixel conversion, and elevation sync.
 */

export const DEM_AWS_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const HYBRID_DEM_URL = 'gsi-dem://{z}/{x}/{y}';

// タイルメモリキャッシュ（3D地形とコンター生成で同一タイルを1回だけフェッチ・変換）
const tileCache = new Map();
const inFlightTiles = new Map();

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
        let lastH = NaN;
        for (let x = 0; x < N; x++) {
            const h = grid[row + x];
            if (!isNaN(h)) lastH = h;
            else if (!isNaN(lastH) && lastH < fillVal[row + x]) fillVal[row + x] = lastH;
        }
        lastH = NaN;
        for (let x = N - 1; x >= 0; x--) {
            const h = grid[row + x];
            if (!isNaN(h)) lastH = h;
            else if (!isNaN(lastH) && lastH < fillVal[row + x]) fillVal[row + x] = lastH;
        }
    }

    for (let x = 0; x < N; x++) {
        let lastH = NaN;
        for (let y = 0; y < N; y++) {
            const idx = y * N + x;
            const h = grid[idx];
            if (!isNaN(h)) lastH = h;
            else if (!isNaN(lastH) && lastH < fillVal[idx]) fillVal[idx] = lastH;
        }
        lastH = NaN;
        for (let y = N - 1; y >= 0; y--) {
            const idx = y * N + x;
            const h = grid[idx];
            if (!isNaN(h)) lastH = h;
            else if (!isNaN(lastH) && lastH < fillVal[idx]) fillVal[idx] = lastH;
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
 * 標高(m) を MapLibre 互換の Terrarium 形式 RGB にエンコード
 * 仕様: elevation = (R * 256 + G + B / 256) - 32768
 */
export function encodeTerrariumPixel(alt) {
    const v = Math.round((alt + 32768) * 256);
    const clamped = Math.max(0, Math.min(16777215, v));
    const r = (clamped >> 16) & 255;
    const g = (clamped >> 8) & 255;
    const b = clamped & 255;
    return [r, g, b];
}

/**
 * 画像 URL を非同期ロードして RGBA ピクセル Uint8ClampedArray を取得
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
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, 256, 256).data;
    } catch {
        return null;
    }
}

/**
 * 国土地理院 10mメッシュ (dem_png z<=14) を取得し、水面補完＋Terrarium形式RGB (ArrayBuffer) に変換する
 */
export async function fetchGsiTerrariumPng(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key).slice(0);
    if (inFlightTiles.has(key)) {
        const buf = await inFlightTiles.get(key);
        return buf ? buf.slice(0) : null;
    }

    const promise = (async () => {
        const n = 2 ** z;
        const lonMin = (x / n) * 360 - 180;
        const lonMax = ((x + 1) / n) * 360 - 180;
        const isJapan = lonMin < 154 && lonMax > 122;

        if (!isJapan || z < 9 || z > 14) {
            const res = await fetch(`${DEM_AWS_BASE}/${z}/${x}/${y}.png?_c=1`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.arrayBuffer();
        }

        try {
            const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const img = await createImageBitmap(blob);

            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, 256, 256);
            const imgData = ctx.getImageData(0, 0, 256, 256);
            const d = imgData.data;

            const grid = decodeAndFillGsiTile(d);
            if (!grid) {
                const awsRes = await fetch(`${DEM_AWS_BASE}/${z}/${x}/${y}.png?_c=1`);
                return await awsRes.arrayBuffer();
            }

            for (let i = 0; i < 65536; i++) {
                const [tr, tg, tb] = encodeTerrariumPixel(grid[i]);
                const idx = i * 4;
                d[idx] = tr;
                d[idx + 1] = tg;
                d[idx + 2] = tb;
                d[idx + 3] = 255;
            }

            ctx.putImageData(imgData, 0, 0);
            const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            if (!outBlob) throw new Error('toBlob failed');
            return await outBlob.arrayBuffer();
        } catch {
            const awsRes = await fetch(`${DEM_AWS_BASE}/${z}/${x}/${y}.png?_c=1`);
            return await awsRes.arrayBuffer();
        }
    })();

    inFlightTiles.set(key, promise);
    try {
        const buf = await promise;
        if (buf && buf.byteLength > 0) {
            tileCache.set(key, buf);
            if (tileCache.size > 200) {
                const oldest = tileCache.keys().next().value;
                tileCache.delete(oldest);
            }
            return buf.slice(0);
        }
        return buf;
    } finally {
        inFlightTiles.delete(key);
    }
}

/**
 * 国土地理院 10mメッシュを 3D地形 (MapLibre addProtocol) および等高線 (fetch hook) の双方に直結
 */
let isGsiProtocolRegistered = false;
export function registerGsiDemProtocol() {
    if (isGsiProtocolRegistered) return;
    isGsiProtocolRegistered = true;

    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
        const urlStr = typeof input === 'string' ? input : (input?.url || '');
        const match = urlStr.match(/^gsi-dem:\/\/(\d+)\/(\d+)\/(\d+)/);
        if (match) {
            try {
                const z = parseInt(match[1], 10);
                const x = parseInt(match[2], 10);
                const y = parseInt(match[3], 10);
                const buf = await fetchGsiTerrariumPng(z, x, y);
                return new Response(buf, {
                    status: 200,
                    headers: { 'Content-Type': 'image/png' }
                });
            } catch (err) {
                return new Response(null, { status: 404, statusText: err.message });
            }
        }
        return origFetch.apply(this, arguments);
    };

    if (window.maplibregl?.addProtocol) {
        maplibregl.addProtocol('gsi-dem', (params, callback) => {
            const match = params.url.match(/gsi-dem:\/\/(\d+)\/(\d+)\/(\d+)/);
            if (!match) {
                callback(new Error('Invalid gsi-dem URL'));
                return { cancel: () => {} };
            }
            const z = parseInt(match[1], 10);
            const x = parseInt(match[2], 10);
            const y = parseInt(match[3], 10);
            fetchGsiTerrariumPng(z, x, y)
                .then((buf) => callback(null, buf, null, null))
                .catch((err) => callback(err));
            return { cancel: () => {} };
        });
    }
}

/**
 * 日本国内用：国土地理院 10mメッシュ DEM タイルからコース各点の標高を一括取得（バイリニア補間）
 */
export async function fetchGsiDem10mElevations(points, onProgress = null) {
    if (!points || points.length === 0) return null;

    const ZOOM = 14;
    const z14Set = new Set();
    for (const p of points) {
        const { tx, ty } = lonLatToTileCoords(p.lon, p.lat, ZOOM);
        z14Set.add(`${tx}/${ty}`);
    }

    const localTileCache = new Map();
    let completed = 0;
    const totalTiles = z14Set.size;

    const loadTile = async (key) => {
        const [tx, ty] = key.split('/').map(Number);
        const rgba = await fetchImagePixels(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${ZOOM}/${tx}/${ty}.png`);
        const grid = rgba ? decodeAndFillGsiTile(rgba) : null;
        localTileCache.set(key, grid);
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
        const grid = localTileCache.get(`${tx}/${ty}`);
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
 * 海外用 / グローバルフォールバック：AWS Terrarium DEM（約30mメッシュ）からコース標高をサンプリング
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
