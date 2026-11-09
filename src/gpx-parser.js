/**
 * Pure GPX XML Parser
 * Extracts track/route waypoints, course name, and metadata without external dependencies.
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
