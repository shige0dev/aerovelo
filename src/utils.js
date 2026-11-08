/**
 * Common Math, Geo, and DOM Utilities
 */

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 2地点間の大圏距離（Haversine距離、単位: m）
 */
export function haversineDistance(lon1, lat1, lon2, lat2) {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 2地点間の方位角（Bearing、0〜360度、北=0、東=90）
 */
export function calcBearing(lon1, lat1, lon2, lat2) {
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const rLat1 = lat1 * DEG_TO_RAD, rLat2 = lat2 * DEG_TO_RAD;
    const y = Math.sin(dLon) * Math.cos(rLat2);
    const x = Math.cos(rLat1) * Math.sin(rLat2) - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

/**
 * DOM ヘルパー
 */
export const $ = (id) => document.getElementById(id);
export const on = (elOrId, type, fn, opts) => {
    const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
    el?.addEventListener(type, fn, opts);
    return el;
};
