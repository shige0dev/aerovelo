/**
 * OpenStreetMap からコース沿いの橋 (bridge) ・トンネル (tunnel) 区間を取得するモジュール
 *
 * 【方式1: メイン（実証済み Overpass API 軽量ポリライン検索）】
 * - コース座標を約30点（長距離でも最大40点/チャンク）に間引き
 * - around:30 (周囲30m) + way["bridge"]["bridge"!="no"] / way["tunnel"]["tunnel"!="no"]
 * - out body geom; で形状座標配列を直接取得（POST送信）
 *
 * 【方式2: バックアップ（OSM 公式 API v0.6 map.json）】
 * - Overpass サーバー混雑時の自動フェイルオーバー用
 */

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
];
const OSM_API_BASE = 'https://api.openstreetmap.org/api/0.6/map.json';

const SAMPLE_TARGET_POINTS = 35; // 1クエリあたりの間引き座標点数（約30〜35点：クエリ超過・タイムアウトを完全回避）
const AROUND_M = 30;             // Overpass around 検索半径 (30m)
const MATCH_TOL_M = 25;          // コース線分と OSM way の一致許容距離 (m)
const MAX_ANGLE_RAD = Math.PI / 3; // コースと way の向きの許容差 (60°: 直交する立体交差のみ除外)
const MERGE_GAP_M = 15;          // 近接する同種構造物 way を結合する距離閾値 (m)
const REQUEST_TIMEOUT_MS = 18000;

function isStructureTag(value) {
    return value !== undefined && value !== null && value !== '' && value !== 'no' && value !== 'false';
}

/**
 * コース座標列を約30〜35点に間引いた `lat1,lon1,lat2,lon2,...` 文字列を生成
 */
function buildSampledCoordString(samples, targetCount = SAMPLE_TARGET_POINTS) {
    const n = samples.length;
    if (n <= targetCount) {
        return samples.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(',');
    }
    const step = (n - 1) / (targetCount - 1);
    const pts = [];
    for (let i = 0; i < targetCount; i++) {
        const idx = Math.min(n - 1, Math.round(i * step));
        pts.push(`${samples[idx].lat.toFixed(4)},${samples[idx].lon.toFixed(4)}`);
    }
    return pts.join(',');
}

/**
 * 【メイン方式】実証済み Overpass QL（間引き座標列 + around:30 + out body geom;）を POST 送信
 */
async function fetchFromOverpassAround(samples) {
    // 25km以内の通常コースは1クエリ(約35点)、超長距離コース(しまなみ77km等)は20kmごとに分割
    const totalDist = samples[samples.length - 1].dist - samples[0].dist;
    const chunks = Math.max(1, Math.ceil(totalDist / 25000));
    const chunkSize = Math.ceil(samples.length / chunks);

    const wayMap = new Map();
    let usedEndpoint = '';

    for (let c = 0; c < chunks; c++) {
        const start = c * chunkSize;
        const end = Math.min(samples.length, (c + 1) * chunkSize + 1);
        const slice = samples.slice(start, end);
        if (slice.length < 2) continue;

        const coordsStr = buildSampledCoordString(slice, SAMPLE_TARGET_POINTS);
        const query = `[out:json][timeout:25];\n(\n` +
            `  way["bridge"]["bridge"!="no"](around:${AROUND_M},${coordsStr});\n` +
            `  way["tunnel"]["tunnel"!="no"](around:${AROUND_M},${coordsStr});\n` +
            `);\n(._;>;);\nout body geom;`;

        let chunkOk = false;
        for (const endpoint of OVERPASS_ENDPOINTS) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                    body: 'data=' + encodeURIComponent(query),
                    signal: ctrl.signal
                });
                if (!res.ok) continue;
                const json = await res.json();
                if (!json || !Array.isArray(json.elements)) continue;

                for (const el of json.elements) {
                    if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
                        // 水路・鉄道等の非道路を除外（highway タグがあるもの、またはタグ制限なし道路）
                        if (!el.tags?.waterway && !el.tags?.railway) {
                            wayMap.set(el.id, el);
                        }
                    }
                }
                usedEndpoint = endpoint.includes('kumi') ? 'Overpass (kumi.systems)' : 'Overpass (overpass-api.de)';
                chunkOk = true;
                break;
            } catch {
                // 次の予備エンドポイントへ
            } finally {
                clearTimeout(timer);
            }
        }

        if (!chunkOk) return null;
    }

    return { ways: [...wayMap.values()], source: usedEndpoint || 'Overpass API' };
}

/**
 * 【バックアップ方式】OpenStreetMap 公式 API v0.6 (map.json)
 */
async function fetchFromOsmApiFallback(samples) {
    const TILE_DEG = 0.025;
    const PAD = 0.0005;
    const tileMap = new Map();
    for (const s of samples) {
        const key = `${Math.floor(s.lon / TILE_DEG)},${Math.floor(s.lat / TILE_DEG)}`;
        let b = tileMap.get(key);
        if (!b) {
            b = { minLon: s.lon, minLat: s.lat, maxLon: s.lon, maxLat: s.lat };
            tileMap.set(key, b);
        } else {
            if (s.lon < b.minLon) b.minLon = s.lon;
            if (s.lon > b.maxLon) b.maxLon = s.lon;
            if (s.lat < b.minLat) b.minLat = s.lat;
            if (s.lat > b.maxLat) b.maxLat = s.lat;
        }
    }

    const bboxes = [...tileMap.values()];
    const wayMap = new Map();
    let anySuccess = false;

    const results = await Promise.all(bboxes.map(async (b) => {
        const url = `${OSM_API_BASE}?bbox=${(b.minLon - PAD).toFixed(6)},${(b.minLat - PAD).toFixed(6)},${(b.maxLon + PAD).toFixed(6)},${(b.maxLat + PAD).toFixed(6)}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: ctrl.signal });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }));

    for (const json of results) {
        if (!json || !Array.isArray(json.elements)) continue;
        anySuccess = true;
        const nodes = new Map();
        const rawWays = [];
        for (const el of json.elements) {
            if (el.type === 'node') nodes.set(el.id, { lon: el.lon, lat: el.lat });
            else if (el.type === 'way' && !el.tags?.waterway && !el.tags?.railway && Array.isArray(el.nodes)) {
                if (isStructureTag(el.tags?.tunnel) || isStructureTag(el.tags?.bridge)) rawWays.push(el);
            }
        }
        for (const w of rawWays) {
            const geometry = w.nodes.map((nid) => nodes.get(nid)).filter(Boolean);
            if (geometry.length >= 2) wayMap.set(w.id, { id: w.id, tags: w.tags, geometry });
        }
    }

    return anySuccess ? { ways: [...wayMap.values()], source: 'OSM API v0.6' } : null;
}

/**
 * コース上のサンプル点列から橋・トンネル区間を取得する
 * @param {Array<{dist:number, lon:number, lat:number}>} samples
 * @returns {Promise<{ranges: Array<{type:'bridge'|'tunnel', d0:number, d1:number, name?:string}>, source: string}|null>}
 */
export async function fetchOsmStructures(samples) {
    if (!samples || samples.length < 2) return { ranges: [], source: 'none' };

    // 1. まず実証済みの Overpass API (30点間引き + around:30 + POST) で取得
    let res = await fetchFromOverpassAround(samples);

    // 2. 万一 Overpass が全滅・タイムアウトした場合のみ OSM API v0.6 にフォールバック
    if (!res) {
        res = await fetchFromOsmApiFallback(samples);
    }

    if (!res) return null;

    const ranges = matchStructures(samples, res.ways);
    return { ranges, source: res.source };
}

/**
 * 取得した橋・トンネル way の座標列 (geometry) をコース折れ線へ投影し、
 * コース上の正確な始端距離 (d0) 〜 終端距離 (d1) に変換する
 */
export function matchStructures(samples, ways) {
    if (!samples || samples.length < 2 || !ways || !ways.length) return [];

    const n = samples.length;
    const lat0 = samples[0].lat, lon0 = samples[0].lon;
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
    const ky = 110540;
    const toXY = (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky];

    const routeXY = samples.map((s) => toXY(s.lon, s.lat));

    const routeSegs = [];
    for (let i = 0; i < n - 1; i++) {
        const [ax, ay] = routeXY[i];
        const [bx, by] = routeXY[i + 1];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-6) continue;
        routeSegs.push({
            ax, ay, bx, by, dx, dy, len2,
            angle: Math.atan2(dx, dy),
            d0: samples[i].dist,
            d1: samples[i + 1].dist
        });
    }

    const rawIntervals = [];

    for (const w of ways) {
        const type = isStructureTag(w.tags?.tunnel) ? 'tunnel' : isStructureTag(w.tags?.bridge) ? 'bridge' : null;
        if (!type || !Array.isArray(w.geometry) || w.geometry.length < 2) continue;

        const wxy = w.geometry.map((g) => toXY(g.lon, g.lat));
        let matchedMinD = Infinity;
        let matchedMaxD = -Infinity;

        for (let k = 0; k < wxy.length - 1; k++) {
            const [wax, way_] = wxy[k];
            const [wbx, wby] = wxy[k + 1];
            const wdx = wbx - wax, wdy = wby - way_;
            const wlen = Math.hypot(wdx, wdy);
            if (wlen < 0.3) continue;
            const wAngle = Math.atan2(wdx, wdy);

            const steps = Math.max(2, Math.ceil(wlen / 4));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const px = wax + wdx * t;
                const py = way_ + wdy * t;

                let bestDist = Infinity;
                let bestRouteD = null;

                for (const rs of routeSegs) {
                    if (px < Math.min(rs.ax, rs.bx) - MATCH_TOL_M || px > Math.max(rs.ax, rs.bx) + MATCH_TOL_M ||
                        py < Math.min(rs.ay, rs.by) - MATCH_TOL_M || py > Math.max(rs.ay, rs.by) + MATCH_TOL_M) {
                        continue;
                    }

                    let angDiff = Math.abs(wAngle - rs.angle) % Math.PI;
                    angDiff = Math.min(angDiff, Math.PI - angDiff);
                    if (angDiff > MAX_ANGLE_RAD) continue;

                    const proj = clamp(((px - rs.ax) * rs.dx + (py - rs.ay) * rs.dy) / rs.len2, 0, 1);
                    const dist = Math.hypot(px - (rs.ax + proj * rs.dx), py - (rs.ay + proj * rs.dy));
                    if (dist <= MATCH_TOL_M && dist < bestDist) {
                        bestDist = dist;
                        bestRouteD = rs.d0 + (rs.d1 - rs.d0) * proj;
                    }
                }

                if (bestRouteD !== null) {
                    if (bestRouteD < matchedMinD) matchedMinD = bestRouteD;
                    if (bestRouteD > matchedMaxD) matchedMaxD = bestRouteD;
                }
            }
        }

        if (matchedMaxD > matchedMinD && (matchedMaxD - matchedMinD) >= 2) {
            rawIntervals.push({
                type,
                d0: matchedMinD,
                d1: matchedMaxD,
                name: w.tags?.name || ''
            });
        }
    }

    if (!rawIntervals.length) return [];

    rawIntervals.sort((a, b) => a.d0 - b.d0 || a.d1 - b.d1);
    const merged = [rawIntervals[0]];
    for (let i = 1; i < rawIntervals.length; i++) {
        const cur = rawIntervals[i];
        const prev = merged[merged.length - 1];
        if (cur.type === prev.type && cur.d0 <= prev.d1 + MERGE_GAP_M) {
            prev.d1 = Math.max(prev.d1, cur.d1);
            if (!prev.name && cur.name) prev.name = cur.name;
        } else {
            merged.push(cur);
        }
    }

    return merged;
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
