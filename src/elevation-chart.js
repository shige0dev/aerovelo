/**
 * Elevation Profile Chart & Interactive Progress Line Slider
 * Handles 2D canvas rendering, ResizeObserver resolution sync, and mouse/touch scrubbing.
 */

export class ElevationChart {
    /**
     * @param {string} canvasId Canvas element ID
     * @param {Function} onSeek Callback (progress: 0.0 ~ 1.0) when user drags/clicks the progress line
     */
    constructor(canvasId = 'elevation-canvas', onSeek = null) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        this.onSeek = onSeek;

        this.course = null;
        this.currentProgress = 0.0;

        this.resize();
        this.setupInteraction();
        this.setupResizeObserver();
    }

    setupResizeObserver() {
        if (window.ResizeObserver && this.canvas) {
            this.resizeObserver = new ResizeObserver(() => {
                this.resize();
                this.draw();
            });
            this.resizeObserver.observe(this.canvas);
        }
    }

    setupInteraction() {
        if (!this.canvas) return;

        let isDragging = false;

        const seekFromClientX = (clientX) => {
            const rect = this.canvas.getBoundingClientRect();
            if (rect.width <= 0) return;
            const clickX = clientX - rect.left;
            const progress = Math.max(0.0, Math.min(1.0, clickX / rect.width));
            if (this.onSeek) {
                this.onSeek(progress);
            }
        };

        this.canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            seekFromClientX(e.clientX);
            const moveHandler = (moveEvent) => {
                if (isDragging) seekFromClientX(moveEvent.clientX);
            };
            const upHandler = () => {
                isDragging = false;
                window.removeEventListener('mousemove', moveHandler);
                window.removeEventListener('mouseup', upHandler);
            };
            window.addEventListener('mousemove', moveHandler);
            window.addEventListener('mouseup', upHandler);
        });

        this.canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length > 0) {
                isDragging = true;
                seekFromClientX(e.touches[0].clientX);
            }
        }, { passive: true });

        this.canvas.addEventListener('touchmove', (e) => {
            if (isDragging && e.touches.length > 0) {
                seekFromClientX(e.touches[0].clientX);
            }
        }, { passive: true });

        const touchEndHandler = () => {
            isDragging = false;
        };
        this.canvas.addEventListener('touchend', touchEndHandler);
        this.canvas.addEventListener('touchcancel', touchEndHandler);
    }

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const displayW = Math.floor(rect.width);
        const displayH = Math.floor(rect.height) || 76;
        if (displayW > 0) {
            this.canvas.width = displayW;
            this.canvas.height = displayH;
        } else {
            this.canvas.width = Math.max(window.innerWidth - 60, 300);
            this.canvas.height = 76;
        }
    }

    setCourse(course) {
        this.course = course;
        this.resize();
        this.draw();
    }

    setProgress(progress) {
        this.currentProgress = Math.max(0.0, Math.min(1.0, isNaN(progress) ? 0.0 : progress));
        this.draw();
    }

    draw() {
        if (!this.ctx || !this.canvas || !this.course) return;
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);

        const samples = 150;
        const elevations = [];
        let minAlt = Infinity;
        let maxAlt = -Infinity;

        for (let i = 0; i <= samples; i++) {
            const u = i / samples;
            const state = this.course.getStateAtProgress(u);
            elevations.push(state.alt);
            if (state.alt < minAlt) minAlt = state.alt;
            if (state.alt > maxAlt) maxAlt = state.alt;
        }

        const altSpan = Math.max(maxAlt - minAlt, 10);
        const padY = 10;
        const getY = (alt) => h - padY - ((alt - minAlt) / altSpan) * (h - padY * 2);

        // 背景グラデーション
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(0, 240, 255, 0.50)');
        gradient.addColorStop(1, 'rgba(0, 240, 255, 0.05)');

        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i <= samples; i++) {
            const x = (i / samples) * w;
            const y = getY(elevations[i]);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // 標高ライン
        ctx.beginPath();
        for (let i = 0; i <= samples; i++) {
            const x = (i / samples) * w;
            const y = getY(elevations[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // 現在位置の縦線スライダー (全高にわたるネオンシアン縦ライン)
        const riderX = this.currentProgress * w;
        const riderState = this.course.getStateAtProgress(this.currentProgress);
        const riderY = getY(riderState.alt);

        // 縦線背景グロー
        ctx.beginPath();
        ctx.moveTo(riderX, 0);
        ctx.lineTo(riderX, h);
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.35)';
        ctx.lineWidth = 6;
        ctx.stroke();

        // 縦線本体
        ctx.beginPath();
        ctx.moveTo(riderX, 0);
        ctx.lineTo(riderX, h);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 現在位置ドット (標高線上)
        ctx.beginPath();
        ctx.arc(riderX, riderY, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // 上部ハンドル（縦線スライダつまみ）
        ctx.beginPath();
        ctx.moveTo(riderX - 5, 0);
        ctx.lineTo(riderX + 5, 0);
        ctx.lineTo(riderX, 8);
        ctx.closePath();
        ctx.fillStyle = '#00f0ff';
        ctx.fill();
    }
}
