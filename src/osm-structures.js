/**
 * OpenStreetMap (Overpass API) からコース沿いの橋・トンネル区間を取得する
 * GPX / GeoJSON のどちらでも、座標さえあれば使える（BRouter のタグ出力に依存しない）
 */

const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
];

const QUERY_POINT_STEP_M = 50;   // Overpass に渡すコース折れ線の間隔
const POINTS_PER_QUERY = 300;    // 1クエリあたりの折れ線の点数（長距離コースは分割して問い合わせ）
const AROUND_M = 15;             // way の検索半径
const MATCH_TOL_M = 8;           // コース点と way の一致とみなす距離
const MAX_ANGLE_RAD = Math.PI / 6; // コースと way の向きの差の許容値 (30°)。直交する立体交差を除外する
const MIN_RUN_SAMPLES = 2;       // 区間として採用する最小サンプル数
const MAX_GAP_SAMPLES = 2;       // 同種区間の間の欠けを埋める最大サンプル数
const REQUEST_TIMEOUT_MS = 30000;

async function postOverpass(query) {
    for (const endpoint of ENDPOINTS) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'data=' + encodeURIComponent(query),
                signal: ctrl.signal
            });
            if (!res.ok) continue;
            return await res.json();
        } catch {
            // 次のミラーへ
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

/**
 * @param {Array<{dist:number, lon:number, lat:number}>} samples コース上の等間隔サンプル
 * @returns {Promise<Array<{type:'bridge'|'tunnel', d0:number, d1:number}>|null>} 取得失敗時は null
 */
export async function fetchOsmStructures(samples) {
    if (!samples || samples.length < 3) return [];

    const stepDist = (samples[samples.length - 1].dist - samples[0].dist) / (samples.length - 1) || 5;
    const stride = Math.max(1, Math.round(QUERY_POINT_STEP_M / stepDist));
    const poly = [];
    for (let i = 0; i < samples.length; i += stride) poly.push(samples[i]);
    if (poly[poly.length - 1] !== samples[samples.length - 1]) poly.push(samples[samples.length - 1]);

    const ways = new Map();
    for (let s = 0; s < poly.length - 1; s += POINTS_PER_QUERY - 1) {
        const part = poly.slice(s, s + POINTS_PER_QUERY);
        if (part.length < 2) continue;
        const coords = part.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
        const query = `[out:json][timeout:25];(` +
            `way["highway"]["bridge"]["bridge"!="no"](around:${AROUND_M},${coords});` +
            `way["highway"]["tunnel"]["tunnel"!="no"](around:${AROUND_M},${coords});` +
            `);out tags geom;`;
        const json = await postOverpass(query);
        if (!json || !Array.isArray(json.elements)) return null;
        for (const el of json.elements) {
            if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) ways.set(el.id, el);
        }
    }

    return matchStructures(samples, [...ways.values()]);
}

function isStructureTag(value) {
    return value !== undefined && value !== 'no';
}

/**
 * コースのサンプル点と OSM の橋・トンネル way を、距離と向きで照合して区間化する
 */
export function matchStructures(samples, ways) {
    const n = samples.length;
    const lat0 = samples[0].lat, lon0 = samples[0].lon;
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
    const ky = 110540;
    const toXY = (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky];

    const pts = samples.map((s) => toXY(s.lon, s.lat));
    const heading = (i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        return Math.atan2(b[0] - a[0], b[1] - a[1]);
    };

    const prepared = [];
    for (const w of ways) {
        const type = isStructureTag(w.tags?.tunnel) ? 'tunnel' : isStructureTag(w.tags?.bridge) ? 'bridge' : null;
        if (!type) continue;
        const xy = w.geometry.map((g) => toXY(g.lon, g.lat));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of xy) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        prepared.push({ type, xy, minX: minX - MATCH_TOL_M, minY: minY - MATCH_TOL_M, maxX: maxX + MATCH_TOL_M, maxY: maxY + MATCH_TOL_M });
    }

    // 1. サンプルごとに、近く（8m以内）かつ向きが揃っている橋・トンネル way を判定（トンネル優先）
    const labels = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        const [px, py] = pts[i];
        const hd = heading(i);
        for (const w of prepared) {
            if (px < w.minX || px > w.maxX || py < w.minY || py > w.maxY) continue;
            if (labels[i] === 'tunnel') break;
            for (let k = 0; k < w.xy.length - 1; k++) {
                const [ax, ay] = w.xy[k], [bx, by] = w.xy[k + 1];
                const dx = bx - ax, dy = by - ay;
                const len2 = dx * dx + dy * dy;
                if (len2 === 0) continue;
                const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
                const dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
                if (dist > MATCH_TOL_M) continue;
                let diff = Math.abs(hd - Math.atan2(dx, dy)) % Math.PI;
                diff = Math.min(diff, Math.PI - diff);
                if (diff <= MAX_ANGLE_RAD) {
                    labels[i] = w.type === 'tunnel' || !labels[i] ? w.type : labels[i];
                    break;
                }
            }
        }
    }

    // 2. 同種区間の間の小さな欠けを埋める
    for (let i = 0; i < n; i++) {
        if (labels[i]) continue;
        let j = i;
        while (j < n && !labels[j]) j++;
        if (i > 0 && j < n && j - i <= MAX_GAP_SAMPLES && labels[i - 1] === labels[j]) {
            for (let k = i; k < j; k++) labels[k] = labels[j];
        }
        i = j;
    }

    // 3. 連続区間にまとめる
    const ranges = [];
    let i = 0;
    while (i < n) {
        if (!labels[i]) { i++; continue; }
        let j = i;
        while (j + 1 < n && labels[j + 1] === labels[i]) j++;
        if (j - i + 1 >= MIN_RUN_SAMPLES) {
            ranges.push({ type: labels[i], d0: samples[i].dist, d1: samples[j].dist });
        }
        i = j + 1;
    }
    return ranges;
}

