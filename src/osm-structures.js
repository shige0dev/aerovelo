/**
 * OpenStreetMap 公式 API v0.6 (https://api.openstreetmap.org/api/0.6/map.json) を用いて、
 * コース沿いの橋 (bridge) ・トンネル (tunnel) 区間を確実に取得するモジュール (v2.2.3 実証済み方式)
 */

import { clamp } from './utils.js';

const OSM_API_BASE = 'https://api.openstreetmap.org/api/0.6/map.json';
const OVERPASS_ENDPOINTS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
];

const TILE_DEG = 0.025;          // コース沿いを分割する bbox タイルサイズ（約 2.5km 四方）
const BBOX_PAD_DEG = 0.0005;     // タイル端の余白（約 50m）
const MATCH_TOL_M = 18;          // コース線分と OSM way の一致許容距離 (m)
const MAX_ANGLE_RAD = Math.PI / 4; // コースと way の向きの許容差 (45°: 立体交差を除外しつつカーブ橋・トンネルを許容)
const MERGE_GAP_M = 15;          // 同一構造物内で連続とみなす距離閾値 (m)
const SCAN_STEP_M = 3;           // コースを先頭から走査するステップ間隔 (m)
const REQUEST_TIMEOUT_MS = 15000;

function isStructureTag(value) {
    return value !== undefined && value !== null && value !== '' && value !== 'no' && value !== 'false';
}

/**
 * コースが通過する 0.025° 四方の bbox リストを生成
 */
function buildRouteBboxes(samples) {
    const tileMap = new Map();
    for (const s of samples) {
        const tx = Math.floor(s.lon / TILE_DEG);
        const ty = Math.floor(s.lat / TILE_DEG);
        const key = `${tx},${ty}`;
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
    return [...tileMap.values()].map((b) => ({
        minLon: b.minLon - BBOX_PAD_DEG,
        minLat: b.minLat - BBOX_PAD_DEG,
        maxLon: b.maxLon + BBOX_PAD_DEG,
        maxLat: b.maxLat + BBOX_PAD_DEG
    }));
}

/**
 * OpenStreetMap 公式 API v0.6 (map.json) から指定 bbox の橋・トンネル way を取得
 */
async function fetchFromOsmApiV06(bbox) {
    const url = `${OSM_API_BASE}?bbox=${bbox.minLon.toFixed(6)},${bbox.minLat.toFixed(6)},${bbox.maxLon.toFixed(6)},${bbox.maxLat.toFixed(6)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: ctrl.signal
        });
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) return null;

        const nodes = new Map();
        const ways = [];
        for (const el of json.elements) {
            if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
                nodes.set(el.id, { lon: el.lon, lat: el.lat });
            } else if (el.type === 'way' && el.tags?.highway && Array.isArray(el.nodes)) {
                if (isStructureTag(el.tags.tunnel) || isStructureTag(el.tags.bridge)) {
                    ways.push(el);
                }
            }
        }

        const result = [];
        for (const w of ways) {
            const geometry = [];
            for (const nid of w.nodes) {
                const pt = nodes.get(nid);
                if (pt) geometry.push(pt);
            }
            if (geometry.length >= 2) {
                result.push({ id: w.id, tags: w.tags, geometry });
            }
        }
        return result;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * フォールバック用 Overpass API (bbox クエリ)
 */
async function fetchFromOverpassBbox(bbox) {
    const bboxStr = `${bbox.minLat.toFixed(5)},${bbox.minLon.toFixed(5)},${bbox.maxLat.toFixed(5)},${bbox.maxLon.toFixed(5)}`;
    const query = `[out:json][timeout:12];(way["highway"]["bridge"]["bridge"!="no"](${bboxStr});way["highway"]["tunnel"]["tunnel"!="no"](${bboxStr}););out tags geom;`;

    for (const endpoint of OVERPASS_ENDPOINTS) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: ctrl.signal
            });
            if (!res.ok) continue;
            const json = await res.json();
            if (!json || !Array.isArray(json.elements)) continue;
            return json.elements.filter((el) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2);
        } catch {
            // 次のミラーへ
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

/**
 * コース上のサンプル点列から OpenStreetMap の橋・トンネル区間を取得する
 * @param {Array<{dist:number, lon:number, lat:number}>} samples
 * @returns {Promise<{ranges: Array<{type:'bridge'|'tunnel', d0:number, d1:number, name?:string}>, source: string}|null>}
 */
export async function fetchOsmStructures(samples) {
    if (!samples || samples.length < 2) return { ranges: [], source: 'none' };

    const bboxes = buildRouteBboxes(samples);
    const wayMap = new Map();
    let anySuccess = false;
    let usedSource = 'OSM API v0.6';

    // 並列で OSM 公式 API v0.6 から各タイルのデータを取得
    const tileResults = await Promise.all(bboxes.map((b) => fetchFromOsmApiV06(b)));

    for (let i = 0; i < tileResults.length; i++) {
        let ways = tileResults[i];
        if (ways === null) {
            ways = await fetchFromOverpassBbox(bboxes[i]);
            if (ways !== null) usedSource = 'Overpass API';
        }
        if (ways !== null) {
            anySuccess = true;
            for (const w of ways) wayMap.set(w.id, w);
        }
    }

    if (!anySuccess) return null;

    const ranges = matchStructures(samples, [...wayMap.values()]);
    return { ranges, source: usedSource };
}

/**
 * コースの先頭（0km）からゴールまで順番に走査（1次元ストリーム判定）し、
 * 現在地が OSM の橋・トンネル上にある区間 [d0, d1] をシンプルかつ確実に抽出する
 */
export function matchStructures(samples, ways) {
    if (!samples || samples.length < 2 || !ways || !ways.length) return [];

    const n = samples.length;
    const lat0 = samples[0].lat, lon0 = samples[0].lon;
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
    const ky = 110540;
    const toXY = (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky];

    // 1. OSM の橋・トンネル線分リストを抽出
    const structSegs = [];
    for (const w of ways) {
        const type = isStructureTag(w.tags?.tunnel) ? 'tunnel' : isStructureTag(w.tags?.bridge) ? 'bridge' : null;
        if (!type || !Array.isArray(w.geometry) || !w.geometry.length) continue;
        const name = w.tags?.name || '';
        const wxy = w.geometry.map((g) => toXY(g.lon, g.lat));

        for (let k = 0; k < wxy.length - 1; k++) {
            const [ax, ay] = wxy[k];
            const [bx, by] = wxy[k + 1];
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            if (len2 < 0.25) continue;
            structSegs.push({
                type,
                name,
                ax, ay, bx, by, dx, dy, len2,
                minX: Math.min(ax, bx) - MATCH_TOL_M,
                maxX: Math.max(ax, bx) + MATCH_TOL_M,
                minY: Math.min(ay, by) - MATCH_TOL_M,
                maxY: Math.max(ay, by) + MATCH_TOL_M,
                angle: Math.atan2(dx, dy)
            });
        }
    }

    if (!structSegs.length) return [];

    // 2. コースを 0m からゴールまで順番に走査し、連続する構造物区間を記録
    const routeXY = samples.map((s) => toXY(s.lon, s.lat));
    const intervals = [];
    let current = null;

    for (let i = 0; i < n - 1; i++) {
        const [ax, ay] = routeXY[i];
        const [bx, by] = routeXY[i + 1];
        const rdx = bx - ax, rdy = by - ay;
        const segLen = Math.hypot(rdx, rdy);
        if (segLen < 1e-3) continue;

        const rAngle = Math.atan2(rdx, rdy);
        const d0 = samples[i].dist;
        const d1 = samples[i + 1].dist;
        const steps = Math.max(1, Math.ceil(segLen / SCAN_STEP_M));

        for (let s = 0; s <= steps; s++) {
            if (i > 0 && s === 0) continue; // 前セグメント終端との重複をスキップ
            const t = s / steps;
            const px = ax + rdx * t;
            const py = ay + rdy * t;
            const d = d0 + (d1 - d0) * t;

            let matchedType = null;
            let matchedName = '';
            let bestDist = Infinity;

            for (const ss of structSegs) {
                if (px < ss.minX || px > ss.maxX || py < ss.minY || py > ss.maxY) continue;

                let angDiff = Math.abs(rAngle - ss.angle) % Math.PI;
                angDiff = Math.min(angDiff, Math.PI - angDiff);
                if (angDiff > MAX_ANGLE_RAD) continue;

                const proj = clamp(((px - ss.ax) * ss.dx + (py - ss.ay) * ss.dy) / ss.len2, 0, 1);
                const dist = Math.hypot(px - (ss.ax + proj * ss.dx), py - (ss.ay + proj * ss.dy));
                if (dist <= MATCH_TOL_M && dist < bestDist) {
                    bestDist = dist;
                    matchedType = ss.type;
                    matchedName = ss.name;
                }
            }

            if (matchedType) {
                if (current && current.type === matchedType && (d - current.d1) <= MERGE_GAP_M) {
                    current.d1 = d;
                    if (!current.name && matchedName) current.name = matchedName;
                } else {
                    if (current && (current.d1 - current.d0) >= 3) {
                        intervals.push(current);
                    }
                    current = { type: matchedType, d0: d, d1: d, name: matchedName };
                }
            }
        }
    }

    if (current && (current.d1 - current.d0) >= 3) {
        intervals.push(current);
    }

    return intervals;
}


