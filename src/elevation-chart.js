/**
 * Elevation Profile Chart & Interactive Progress Line Slider
 * Handles 2D canvas rendering, ResizeObserver resolution sync, and pointer scrubbing.
 */

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
            const progress = Math.max(0.0, Math.min(1.0, (clientX - rect.left) / rect.width));
            this.onSeek?.(progress);
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
        const samples = 150;
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
        this.currentProgress = Math.max(0.0, Math.min(1.0, isNaN(progress) ? 0.0 : progress));
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

        // 背景グラデーション塗りつぶし
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(0, 240, 255, 0.50)');
        gradient.addColorStop(1, 'rgba(0, 240, 255, 0.05)');

        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i <= samples; i++) ctx.lineTo((i / samples) * w, getY(elevations[i]));
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // 標高プロファイルライン
        ctx.beginPath();
        for (let i = 0; i <= samples; i++) {
            const x = (i / samples) * w, y = getY(elevations[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // 現在位置の縦線スライダー＆ドット
        const riderX = this.currentProgress * w;
        const riderY = getY(this.course.sampleAtDist(this.currentProgress * this.course.totalDistance).alt);

        ctx.beginPath();
        ctx.moveTo(riderX, 0);
        ctx.lineTo(riderX, h);
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.35)';
        ctx.lineWidth = 6;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(riderX, 0);
        ctx.lineTo(riderX, h);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

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
