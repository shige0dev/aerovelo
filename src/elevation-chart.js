/**
 * Elevation Profile Chart & Interactive Progress Line Slider
 * Handles 2D canvas rendering, ResizeObserver resolution sync, and pointer scrubbing.
 */

import { clamp } from './course.js';

export class ElevationChart {
    constructor(canvasId = 'elevation-canvas', onSeek = null) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas?.getContext('2d') || null;
        this.onSeek = onSeek;
        this.course = null;
        this.profile = null;
        this.currentProgress = 0.0;

        this.resize();
        this.setupInteraction();
        if (window.ResizeObserver && this.canvas) {
            this.resizeObserver = new ResizeObserver(() => {
                this.resize();
                this.draw();
            });
            this.resizeObserver.observe(this.canvas);
        }
    }

    setupInteraction() {
        const c = this.canvas;
        if (!c) return;
        let isDragging = false;

        const seek = (clientX) => {
            const rect = c.getBoundingClientRect();
            if (rect.width <= 0) return;
            this.onSeek?.(clamp((clientX - rect.left) / rect.width, 0.0, 1.0));
        };

        c.addEventListener('pointerdown', (e) => {
            isDragging = true;
            c.setPointerCapture?.(e.pointerId);
            seek(e.clientX);
        });
        c.addEventListener('pointermove', (e) => {
            if (isDragging) seek(e.clientX);
        });
        const stop = () => { isDragging = false; };
        c.addEventListener('pointerup', stop);
        c.addEventListener('pointercancel', stop);
    }

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.floor(rect.width) || Math.max(window.innerWidth - 60, 300);
        this.canvas.height = Math.floor(rect.height) || 76;
    }

    setCourse(course) {
        this.course = course;
        const samples = 300;
        const elevations = new Array(samples + 1);
        let minAlt = Infinity, maxAlt = -Infinity;

        for (let i = 0; i <= samples; i++) {
            const alt = course.sampleAtDist((i / samples) * course.totalDistance).alt;
            elevations[i] = alt;
            if (alt < minAlt) minAlt = alt;
            if (alt > maxAlt) maxAlt = alt;
        }
        this.profile = { samples, elevations, minAlt, altSpan: Math.max(maxAlt - minAlt, 10) };
        this.resize();
        this.draw();
    }

    setProgress(progress) {
        this.currentProgress = clamp(isNaN(progress) ? 0.0 : progress, 0.0, 1.0);
        this.draw();
    }

    draw() {
        if (!this.ctx || !this.canvas || !this.course || !this.profile) return;
        const ctx = this.ctx;
        const w = this.canvas.width, h = this.canvas.height;
        const { samples, elevations, minAlt, altSpan } = this.profile;

        ctx.clearRect(0, 0, w, h);

        const padY = 10;
        const getY = (alt) => h - padY - ((alt - minAlt) / altSpan) * (h - padY * 2);

        // 標高プロファイルパスを構築（塗りつぶし・線描画で共通化）
        const linePath = new Path2D();
        for (let i = 0; i <= samples; i++) {
            const x = (i / samples) * w, y = getY(elevations[i]);
            if (i === 0) linePath.moveTo(x, y);
            else linePath.lineTo(x, y);
        }

        const areaPath = new Path2D(linePath);
        areaPath.lineTo(w, h);
        areaPath.lineTo(0, h);
        areaPath.closePath();

        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(0, 240, 255, 0.50)');
        gradient.addColorStop(1, 'rgba(0, 240, 255, 0.05)');
        ctx.fillStyle = gradient;
        ctx.fill(areaPath);

        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.5;
        ctx.stroke(linePath);

        // 橋・トンネル区間の色替え描画（背景帯＋端部間直線ライン）
        const totalDist = this.course.totalDistance || 1;
        const structures = this.course.structureRanges || [];
        for (const { type, d0, d1 } of structures) {
            const x0 = clamp(d0 / totalDist, 0, 1) * w;
            const x1 = clamp(d1 / totalDist, 0, 1) * w;
            const spanW = Math.max(2, x1 - x0);
            const isTunnel = type === 'tunnel';
            const bandColor = isTunnel ? 'rgba(168, 85, 247, 0.24)' : 'rgba(245, 158, 11, 0.24)';
            const strokeColor = isTunnel ? '#c084fc' : '#fbbf24';
            const barColor = isTunnel ? '#a855f7' : '#f59e0b';

            // 区間背景ハイライト帯 & 上端バー
            ctx.fillStyle = bandColor;
            ctx.fillRect(x0, 0, spanW, h);
            ctx.fillStyle = barColor;
            ctx.fillRect(x0, 0, spanW, 3);

            // 端部と端部を結ぶ直線高度ライン
            const y0 = getY(this.course.sampleAtDist(d0).alt);
            const y1 = getY(this.course.sampleAtDist(d1).alt);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 3.5;
            ctx.stroke();

            // 端部ポイント
            ctx.fillStyle = strokeColor;
            for (const [px, py] of [[x0, y0], [x1, y1]]) {
                ctx.beginPath();
                ctx.arc(px, py, 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // 現在位置の縦線スライダー＆ドット
        const riderX = this.currentProgress * w;
        const riderY = getY(this.course.sampleAtDist(this.currentProgress * this.course.totalDistance).alt);

        const drawVLine = (color, width) => {
            ctx.beginPath();
            ctx.moveTo(riderX, 0);
            ctx.lineTo(riderX, h);
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.stroke();
        };
        drawVLine('rgba(0, 240, 255, 0.35)', 6);
        drawVLine('#ffffff', 2);

        ctx.beginPath();
        ctx.arc(riderX, riderY, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(riderX - 5, 0);
        ctx.lineTo(riderX + 5, 0);
        ctx.lineTo(riderX, 8);
        ctx.closePath();
        ctx.fillStyle = '#00f0ff';
        ctx.fill();
    }
}
