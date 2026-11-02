/**
 * AeroVelo - Mock Course Data & Interpolation Engine
 * 
 * Defines a 3D path with curves, straight sections, and altitude variations.
 * Provides interpolation for any progress percentage (0.0 - 1.0).
 */

export class CourseManager {
    constructor() {
        // Sample course waypoints: [x, y (altitude), z] in meters
        // A winding coastal/mountain road loop
        this.rawWaypoints = [
            { x: 0,    y: 0,   z: 0 },
            { x: 50,   y: 2,   z: 120 },
            { x: 140,  y: 8,   z: 220 },
            { x: 280,  y: 18,  z: 260 },
            { x: 420,  y: 25,  z: 210 },
            { x: 500,  y: 35,  z: 80 },
            { x: 480,  y: 42,  z: -60 },
            { x: 380,  y: 38,  z: -180 },
            { x: 220,  y: 26,  z: -240 },
            { x: 60,   y: 15,  z: -210 },
            { x: -80,  y: 8,   z: -110 },
            { x: -50,  y: 2,   z: -30 },
            { x: 0,    y: 0,   z: 0 }
        ];

        this.points = [];
        this.totalDistance = 0;
        this.initDenseCurve();
    }

    /**
     * Build dense equidistant samples using Catmull-Rom spline
     */
    initDenseCurve() {
        if (typeof THREE === 'undefined') {
            console.warn('Three.js not loaded yet for spline interpolation');
            return;
        }

        const v3Points = this.rawWaypoints.map(p => new THREE.Vector3(p.x, p.y, p.z));
        this.curve = new THREE.CatmullRomCurve3(v3Points, true); // closed loop
        
        // Sample points densely (1000 points)
        const SAMPLES = 1000;
        this.points = this.curve.getSpacedPoints(SAMPLES);
        this.totalDistance = this.curve.getLength();
    }

    /**
     * Get 3D state at given progress ratio (0.0 to 1.0)
     */
    getStateAtProgress(progress) {
        const u = Math.max(0, Math.min(1, progress));
        if (!this.curve) this.initDenseCurve();

        // Current position
        const position = this.curve.getPointAt(u);

        // Tangent / Heading (Look ahead slightly)
        const deltaU = 0.002;
        const forwardU = (u + deltaU) % 1.0;
        const forwardPos = this.curve.getPointAt(forwardU);
        const tangent = new THREE.Vector3().subVectors(forwardPos, position).normalize();

        // Calculate gradient / slope (dy / horizontal distance)
        const horizDist = Math.sqrt(
            Math.pow(forwardPos.x - position.x, 2) + Math.pow(forwardPos.z - position.z, 2)
        );
        const slopePct = horizDist > 0 ? ((forwardPos.y - position.y) / horizDist) * 100 : 0;

        return {
            u,
            distance: u * this.totalDistance,
            position,
            forwardPos,
            tangent,
            altitude: position.y,
            slopePct
        };
    }
}

