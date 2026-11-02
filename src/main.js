import { CourseManager } from './course.js';

class App {
    constructor() {
        this.container = document.getElementById('canvas-container');
        this.courseManager = new CourseManager();
        this.currentProgress = 0.0;
        this.cameraMode = 'follow'; // 'follow' | 'free'
        this.isPlaying = false;
        this.playSpeed = 0.0006; // progress increment per frame

        this.initThree();
        this.initCourseVisuals();
        this.initRider();
        this.initElevationProfile();
        this.initUI();
        this.setupEvents();

        this.updateState(0.0);
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    initThree() {
        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0b0f19);
        this.scene.fog = new THREE.FogExp2(0x0b0f19, 0.0015);

        // Camera
        this.camera = new THREE.PerspectiveCamera(
            55,
            window.innerWidth / window.innerHeight,
            0.5,
            5000
        );

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.container.appendChild(this.renderer.domElement);

        // OrbitControls for Free Camera
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // Don't dip below ground

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xa5f3fc, 1.2);
        dirLight.position.set(300, 500, 200);
        dirLight.castShadow = true;
        this.scene.add(dirLight);

        // Subtle ground grid
        const gridHelper = new THREE.GridHelper(1500, 60, 0x1e293b, 0x0f172a);
        gridHelper.position.y = -0.5;
        this.scene.add(gridHelper);
    }

    initCourseVisuals() {
        if (!this.courseManager.curve) {
            this.courseManager.initDenseCurve();
        }

        // 1. Road Tube Geometry
        const tubeGeometry = new THREE.TubeGeometry(
            this.courseManager.curve,
            200,   // tubularSegments
            3.0,   // radius (road width ~6m)
            12,    // radialSegments
            true   // closed
        );

        // Dark asphalt material with high specularity
        const roadMaterial = new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            roughness: 0.6,
            metalness: 0.1,
            wireframe: false
        });
        const roadMesh = new THREE.Mesh(tubeGeometry, roadMaterial);
        roadMesh.receiveShadow = true;
        this.scene.add(roadMesh);

        // 2. Centerline Glowing Line
        const linePoints = this.courseManager.curve.getPoints(500);
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);
        const lineMaterial = new THREE.LineBasicMaterial({
            color: 0x00f0ff,
            linewidth: 2,
            transparent: true,
            opacity: 0.8
        });
        const centerLine = new THREE.Line(lineGeometry, lineMaterial);
        centerLine.position.y += 0.05; // Slightly above road
        this.scene.add(centerLine);

        // 3. Waypoint Markers (Pillars / Beacons)
        this.courseManager.rawWaypoints.forEach((wp, idx) => {
            const markerGeo = new THREE.CylinderGeometry(0.8, 0.8, wp.y + 4, 16);
            const markerMat = new THREE.MeshBasicMaterial({
                color: idx === 0 ? 0x10b981 : 0x38bdf8,
                wireframe: true,
                transparent: true,
                opacity: 0.35
            });
            const marker = new THREE.Mesh(markerGeo, markerMat);
            marker.position.set(wp.x, wp.y / 2, wp.z);
            this.scene.add(marker);
        });
    }

    initRider() {
        this.riderGroup = new THREE.Group();

        // Pin body (Glowing sphere & arrow indicator)
        const sphereGeo = new THREE.SphereGeometry(2.5, 32, 16);
        const sphereMat = new THREE.MeshStandardMaterial({
            color: 0x00f0ff,
            emissive: 0x00f0ff,
            emissiveIntensity: 0.6,
            roughness: 0.2
        });
        this.riderSphere = new THREE.Mesh(sphereGeo, sphereMat);
        this.riderSphere.position.y = 2.5;
        this.riderGroup.add(this.riderSphere);

        // Direction Arrow Pointer
        const pointerGeo = new THREE.ConeGeometry(1.4, 4, 16);
        pointerGeo.rotateX(Math.PI / 2); // Point forward along Z
        const pointerMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: 0xffffff,
            emissiveIntensity: 0.4
        });
        const pointer = new THREE.Mesh(pointerGeo, pointerMat);
        pointer.position.set(0, 2.5, 4.0);
        this.riderGroup.add(pointer);

        // Pulsing light on rider
        this.riderLight = new THREE.PointLight(0x00f0ff, 2.5, 30);
        this.riderLight.position.y = 3;
        this.riderGroup.add(this.riderLight);

        this.scene.add(this.riderGroup);
    }

    initElevationProfile() {
        this.chartCanvas = document.getElementById('elevation-canvas');
        this.chartCtx = this.chartCanvas.getContext('2d');
        this.drawElevationChart();
    }

    drawElevationChart() {
        const ctx = this.chartCtx;
        const w = this.chartCanvas.width;
        const h = this.chartCanvas.height;

        ctx.clearRect(0, 0, w, h);

        const samples = 150;
        const elevations = [];
        let minAlt = Infinity, maxAlt = -Infinity;

        for (let i = 0; i <= samples; i++) {
            const u = i / samples;
            const state = this.courseManager.getStateAtProgress(u);
            elevations.push(state.altitude);
            if (state.altitude < minAlt) minAlt = state.altitude;
            if (state.altitude > maxAlt) maxAlt = state.altitude;
        }

        const altSpan = Math.max(maxAlt - minAlt, 10);
        const padY = 8;
        const getY = (alt) => h - padY - ((alt - minAlt) / altSpan) * (h - padY * 2);

        // Draw profile fill
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(0, 240, 255, 0.4)');
        gradient.addColorStop(1, 'rgba(0, 240, 255, 0.02)');

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

        // Stroke line
        ctx.beginPath();
        for (let i = 0; i <= samples; i++) {
            const x = (i / samples) * w;
            const y = getY(elevations[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        // Rider indicator dot on profile
        const riderX = this.currentProgress * w;
        const riderState = this.courseManager.getStateAtProgress(this.currentProgress);
        const riderY = getY(riderState.altitude);

        ctx.beginPath();
        ctx.arc(riderX, riderY, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    initUI() {
        // Elements
        this.progressSlider = document.getElementById('progress-slider');
        this.progressInput = document.getElementById('progress-input');
        this.btnPlay = document.getElementById('btn-play');
        this.btnReset = document.getElementById('btn-reset');
        this.camFollowBtn = document.getElementById('cam-follow');
        this.camFreeBtn = document.getElementById('cam-free');

        // Metrics elements
        this.elDistance = document.getElementById('val-distance');
        this.elTotalDist = document.getElementById('val-total-distance');
        this.elAltitude = document.getElementById('val-altitude');
        this.elSlope = document.getElementById('val-slope');
        this.elSlopeWrap = document.getElementById('val-slope-wrap');
        this.elCoords = document.getElementById('val-coords');

        const totalKm = (this.courseManager.totalDistance / 1000).toFixed(2);
        this.elTotalDist.textContent = `/ ${totalKm} km`;
    }

    setupEvents() {
        // Slider drag
        this.progressSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) / 100;
            this.updateState(val);
        });

        // Numerical input
        this.progressInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 0;
            val = Math.max(0, Math.min(100, val)) / 100;
            this.updateState(val);
        });

        // Play / Pause
        this.btnPlay.addEventListener('click', () => {
            this.isPlaying = !this.isPlaying;
            this.btnPlay.textContent = this.isPlaying ? '停止 (Pause)' : '再生 (Auto Run)';
            this.btnPlay.classList.toggle('running', this.isPlaying);
        });

        // Reset
        this.btnReset.addEventListener('click', () => {
            this.isPlaying = false;
            this.btnPlay.textContent = '再生 (Auto Run)';
            this.btnPlay.classList.remove('running');
            this.updateState(0.0);
        });

        // Camera toggles
        this.camFollowBtn.addEventListener('click', () => {
            this.cameraMode = 'follow';
            this.camFollowBtn.classList.add('active');
            this.camFreeBtn.classList.remove('active');
            this.controls.enabled = false;
        });

        this.camFreeBtn.addEventListener('click', () => {
            this.cameraMode = 'free';
            this.camFreeBtn.classList.add('active');
            this.camFollowBtn.classList.remove('active');
            this.controls.enabled = true;
            this.controls.target.copy(this.riderGroup.position);
        });

        // Click on elevation chart to jump
        this.chartCanvas.addEventListener('click', (e) => {
            const rect = this.chartCanvas.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const progress = Math.max(0, Math.min(1, clickX / rect.width));
            this.updateState(progress);
        });

        // Resize
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    updateState(progress) {
        this.currentProgress = ((progress % 1.0) + 1.0) % 1.0; // wrap safely
        const state = this.courseManager.getStateAtProgress(this.currentProgress);

        // Update 3D Rider Position & Heading
        this.riderGroup.position.copy(state.position);

        // Orient rider along tangent
        const lookTarget = state.position.clone().add(state.tangent);
        this.riderGroup.lookAt(lookTarget);

        // Update UI Controls
        const pct100 = (this.currentProgress * 100).toFixed(1);
        if (document.activeElement !== this.progressInput) {
            this.progressInput.value = pct100;
        }
        this.progressSlider.value = (this.currentProgress * 100).toFixed(2);

        // Update Metrics
        this.elDistance.textContent = (state.distance / 1000).toFixed(2);
        this.elAltitude.textContent = state.altitude.toFixed(1);

        const slopeSign = state.slopePct >= 0 ? '+' : '';
        this.elSlope.textContent = `${slopeSign}${state.slopePct.toFixed(1)}`;
        if (state.slopePct > 3) {
            this.elSlopeWrap.style.color = 'var(--climb-color)';
        } else if (state.slopePct < -3) {
            this.elSlopeWrap.style.color = 'var(--descent-color)';
        } else {
            this.elSlopeWrap.style.color = 'var(--flat-color)';
        }

        this.elCoords.textContent = `${state.position.x.toFixed(0)}, ${state.position.y.toFixed(0)}, ${state.position.z.toFixed(0)}`;

        // Redraw Mini Chart
        this.drawElevationChart();

        // Update Follow Camera
        if (this.cameraMode === 'follow') {
            const backwardOffset = state.tangent.clone().multiplyScalar(-24);
            const upwardOffset = new THREE.Vector3(0, 10, 0);
            const cameraPos = state.position.clone().add(backwardOffset).add(upwardOffset);

            this.camera.position.lerp(cameraPos, 0.12);
            this.camera.lookAt(state.position.clone().add(new THREE.Vector3(0, 3, 0)));
        }
    }

    animate() {
        requestAnimationFrame(this.animate);

        if (this.isPlaying) {
            const nextProgress = (this.currentProgress + this.playSpeed) % 1.0;
            this.updateState(nextProgress);
        } else if (this.cameraMode === 'free') {
            this.controls.update();
        }

        this.renderer.render(this.scene, this.camera);
    }
}

// Start on DOM loaded
window.addEventListener('DOMContentLoaded', () => {
    new App();
});

