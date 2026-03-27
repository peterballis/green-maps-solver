// ═══════════════════════════════════════════════════════════════════════════
// Putt Solver — JavaScript port of putt_solver.py physics
//
// Runs entirely in the browser. Uses scalar loops (no numpy needed).
// Designed to run inside a Web Worker so the UI stays responsive.
// ═══════════════════════════════════════════════════════════════════════════

// ── Physics constants (match straight_putt_detector.py) ──────────────────
const G = 9.81;
const V0_STIM = 1.83;
const HOLE_RADIUS = 0.054;
const CAPTURE_RADIUS = 0.020;
const CAPTURE_SPEED = 0.65;
const ROLLOUT_M = 0.43;
const MIN_SPEED = 0.008;
const DT = 0.005;
const MAX_SIM_S = 15.0;

// ── Solver grid parameters (match putt_solver.py) ────────────────────────
const COARSE_N_ANGLES = 361;
const COARSE_N_SPEEDS = 51;
const COARSE_ANGLE_RANGE = Math.PI / 2; // ±90°
const COARSE_SPEED_LO = 0.20;
const COARSE_SPEED_HI = 3.0;

const FINE_N_ANGLES = 101;
const FINE_N_SPEEDS = 51;

const CLUSTER_GAP_RAD = 5 * Math.PI / 180; // 5° between distinct solutions
const DEDUP_GAP_RAD = 2 * Math.PI / 180;   // 2° dedup threshold

// ── Helpers ──────────────────────────────────────────────────────────────

function stimpToMu(stimpFeet) {
    const stimpM = stimpFeet * 0.3048;
    return (V0_STIM * V0_STIM) / (2 * G * stimpM);
}

// ── Single-trajectory simulation (scalar) ────────────────────────────────
// Returns { minDist, speedAtMin } — closest approach to hole

function simulateOne(bx, by, aim, v0, mu, dem, hx, hy) {
    const { sdx, sdy, gx, gy, nx, ny } = dem;
    const x0g = gx[0], y0g = gy[0];
    const dxg = gx[1] - gx[0], dyg = gy[1] - gy[0];
    const maxSteps = Math.floor(MAX_SIM_S / DT);

    let x = bx, y = by;
    let vx = v0 * Math.cos(aim);
    let vy = v0 * Math.sin(aim);
    let minDistSq = 1e10;
    let speedAtMin = 1e10;

    // Bail-out distance
    const bhDistSq = (bx - hx) * (bx - hx) + (by - hy) * (by - hy);
    const maxTravelSq = Math.max(25.0, 16.0 * bhDistSq);

    for (let step = 0; step < maxSteps; step++) {
        const sp = Math.sqrt(vx * vx + vy * vy);
        if (sp < MIN_SPEED) break;

        const dhx = x - hx, dhy = y - hy;
        const distSq = dhx * dhx + dhy * dhy;

        // Track closest approach
        if (distSq < minDistSq) {
            minDistSq = distSq;
            speedAtMin = sp;
        }

        // Bail: moving away and far from hole
        if (distSq > 1.0 && distSq > minDistSq * 4) break;

        // Bail: too far from start
        const fromStartSq = (x - bx) * (x - bx) + (y - by) * (y - by);
        if (fromStartSq > maxTravelSq) break;

        // Bilinear slope interpolation
        const fi = (x - x0g) / dxg;
        const fj = (y - y0g) / dyg;
        const i0 = Math.max(0, Math.min(Math.floor(fi), nx - 2));
        const j0 = Math.max(0, Math.min(Math.floor(fj), ny - 2));
        const fx = Math.max(0, Math.min(fi - i0, 1));
        const fy = Math.max(0, Math.min(fj - j0, 1));

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        // sdx/sdy are row-major: [j * nx + i]
        const idx00 = j0 * nx + i0;
        const idx10 = j0 * nx + (i0 + 1);
        const idx01 = (j0 + 1) * nx + i0;
        const idx11 = (j0 + 1) * nx + (i0 + 1);

        const slopeX = w00 * sdx[idx00] + w10 * sdx[idx10] +
                        w01 * sdx[idx01] + w11 * sdx[idx11];
        const slopeY = w00 * sdy[idx00] + w10 * sdy[idx10] +
                        w01 * sdy[idx01] + w11 * sdy[idx11];

        const spSafe = Math.max(sp, 1e-10);
        const ux = vx / spSafe, uy = vy / spSafe;
        const ax = -G * slopeX - mu * G * ux;
        const ay = -G * slopeY - mu * G * uy;

        vx += ax * DT;
        vy += ay * DT;
        x += vx * DT;
        y += vy * DT;
    }

    return { minDist: Math.sqrt(minDistSq), speedAtMin };
}

// ── Endpoint simulation (for lag putt) ───────────────────────────────────
// Like simulateOne but lets the ball roll to a natural stop (no hole bail-out).
// Returns squared distance from final resting position to hole.

function simulateEndpoint(bx, by, aim, v0, mu, dem, hx, hy) {
    const { sdx, sdy, gx, gy, nx, ny } = dem;
    const x0g = gx[0], y0g = gy[0];
    const dxg = gx[1] - gx[0], dyg = gy[1] - gy[0];
    const maxSteps = Math.floor(MAX_SIM_S / DT);

    let x = bx, y = by;
    let vx = v0 * Math.cos(aim);
    let vy = v0 * Math.sin(aim);

    const bhDistSq = (bx - hx) * (bx - hx) + (by - hy) * (by - hy);
    const maxTravelSq = Math.max(25.0, 16.0 * bhDistSq);

    for (let step = 0; step < maxSteps; step++) {
        const sp = Math.sqrt(vx * vx + vy * vy);
        if (sp < MIN_SPEED) break;

        // Bail: too far from start
        const fromStartSq = (x - bx) * (x - bx) + (y - by) * (y - by);
        if (fromStartSq > maxTravelSq) break;

        const fi = (x - x0g) / dxg;
        const fj = (y - y0g) / dyg;
        const i0 = Math.max(0, Math.min(Math.floor(fi), nx - 2));
        const j0 = Math.max(0, Math.min(Math.floor(fj), ny - 2));
        const fx = Math.max(0, Math.min(fi - i0, 1));
        const fy = Math.max(0, Math.min(fj - j0, 1));

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        const idx00 = j0 * nx + i0;
        const idx10 = j0 * nx + (i0 + 1);
        const idx01 = (j0 + 1) * nx + i0;
        const idx11 = (j0 + 1) * nx + (i0 + 1);

        const slopeX = w00 * sdx[idx00] + w10 * sdx[idx10] +
                       w01 * sdx[idx01] + w11 * sdx[idx11];
        const slopeY = w00 * sdy[idx00] + w10 * sdy[idx10] +
                       w01 * sdy[idx01] + w11 * sdy[idx11];

        const spSafe = Math.max(sp, 1e-10);
        const ux = vx / spSafe, uy = vy / spSafe;
        vx += (-G * slopeX - mu * G * ux) * DT;
        vy += (-G * slopeY - mu * G * uy) * DT;
        x += vx * DT;
        y += vy * DT;
    }

    const dx = x - hx, dy = y - hy;
    return dx * dx + dy * dy;
}

// ── Lag putt search ───────────────────────────────────────────────────────
// Finds the aim/speed whose endpoint (resting position) is closest to the hole.

function lagPuttSearch(ballXY, holeXY, mu, dem) {
    const [bx, by] = ballXY;
    const [hx, hy] = holeXY;
    const dist = Math.sqrt((hx - bx) * (hx - bx) + (hy - by) * (hy - by));
    const straightAngle = Math.atan2(hy - by, hx - bx);
    const v0Flat = Math.sqrt(2 * mu * G * (dist + ROLLOUT_M));

    // Coarse pass
    let bestEndDistSq = 1e10;
    let bestAim = straightAngle;
    let bestSpeed = v0Flat;

    const angleLo = straightAngle - COARSE_ANGLE_RANGE;
    const angleHi = straightAngle + COARSE_ANGLE_RANGE;
    const speedLo = v0Flat * COARSE_SPEED_LO;
    const speedHi = v0Flat * COARSE_SPEED_HI;

    for (let ai = 0; ai < COARSE_N_ANGLES; ai++) {
        const aim = angleLo + (angleHi - angleLo) * ai / (COARSE_N_ANGLES - 1);
        for (let si = 0; si < COARSE_N_SPEEDS; si++) {
            const v0 = speedLo + (speedHi - speedLo) * si / (COARSE_N_SPEEDS - 1);
            const endDistSq = simulateEndpoint(bx, by, aim, v0, mu, dem, hx, hy);
            if (endDistSq < bestEndDistSq) {
                bestEndDistSq = endDistSq;
                bestAim = aim;
                bestSpeed = v0;
            }
        }
    }

    // Fine pass
    for (let ai = 0; ai < FINE_N_ANGLES; ai++) {
        const aim = (bestAim - 3 * Math.PI / 180) +
                    (6 * Math.PI / 180) * ai / (FINE_N_ANGLES - 1);
        for (let si = 0; si < FINE_N_SPEEDS; si++) {
            const v0 = bestSpeed * 0.80 + bestSpeed * 0.40 * si / (FINE_N_SPEEDS - 1);
            const endDistSq = simulateEndpoint(bx, by, aim, v0, mu, dem, hx, hy);
            if (endDistSq < bestEndDistSq) {
                bestEndDistSq = endDistSq;
                bestAim = aim;
                bestSpeed = v0;
            }
        }
    }

    // Extra-fine pass
    for (let ai = 0; ai < 101; ai++) {
        const aim = (bestAim - 0.5 * Math.PI / 180) +
                    (1.0 * Math.PI / 180) * ai / 100;
        for (let si = 0; si < 51; si++) {
            const v0 = bestSpeed * 0.95 + bestSpeed * 0.10 * si / 50;
            const endDistSq = simulateEndpoint(bx, by, aim, v0, mu, dem, hx, hy);
            if (endDistSq < bestEndDistSq) {
                bestEndDistSq = endDistSq;
                bestAim = aim;
                bestSpeed = v0;
            }
        }
    }

    return { aim: bestAim, speed: bestSpeed, endDist: Math.sqrt(bestEndDistSq) };
}

// ── Grid search ──────────────────────────────────────────────────────────
// Runs nAngles × nSpeeds scalar simulations, returns arrays of results

function gridSearch(bx, by, angleLo, angleHi, nAngles, speedLo, speedHi, nSpeeds, mu, dem, hx, hy) {
    const N = nAngles * nSpeeds;
    const aims = new Float64Array(N);
    const speeds = new Float64Array(N);
    const dists = new Float64Array(N);
    const spAtMin = new Float64Array(N);

    let idx = 0;
    for (let si = 0; si < nSpeeds; si++) {
        const v0 = nSpeeds === 1 ? speedLo : speedLo + (speedHi - speedLo) * si / (nSpeeds - 1);
        for (let ai = 0; ai < nAngles; ai++) {
            const aim = nAngles === 1 ? angleLo : angleLo + (angleHi - angleLo) * ai / (nAngles - 1);
            const result = simulateOne(bx, by, aim, v0, mu, dem, hx, hy);
            aims[idx] = aim;
            speeds[idx] = v0;
            dists[idx] = result.minDist;
            spAtMin[idx] = result.speedAtMin;
            idx++;
        }
    }

    return { aims, speeds, dists, spAtMin, N };
}

function bestFromSearch(dists, spAtMin, N) {
    let bestIdx = 0;
    let bestDist = 1e10;
    let hasValid = false;

    // First pass: find best among valid speed
    for (let i = 0; i < N; i++) {
        if (spAtMin[i] <= CAPTURE_SPEED && dists[i] < bestDist) {
            bestDist = dists[i];
            bestIdx = i;
            hasValid = true;
        }
    }

    // Fallback: best regardless of speed
    if (!hasValid) {
        bestDist = 1e10;
        for (let i = 0; i < N; i++) {
            if (dists[i] < bestDist) {
                bestDist = dists[i];
                bestIdx = i;
            }
        }
    }

    return bestIdx;
}

// ── Build solution dict ──────────────────────────────────────────────────

function buildSolution(bx, by, hx, hy, dist, straightAngle, finalAim, finalSpeed, mu) {
    const flatRoll = (finalSpeed * finalSpeed) / (2 * G * mu);
    const speedDiff = flatRoll - dist;

    const aimPointX = bx + flatRoll * Math.cos(finalAim);
    const aimPointY = by + flatRoll * Math.sin(finalAim);

    let angleDiff = ((finalAim - straightAngle + Math.PI) % (2 * Math.PI)) - Math.PI;
    // Handle negative modulo
    if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    const aimOffset = dist * Math.sin(angleDiff);

    let offsetLabel;
    if (Math.abs(aimOffset) < 0.05) {
        offsetLabel = "Straight";
    } else {
        const side = aimOffset > 0 ? "left" : "right";
        offsetLabel = `${Math.abs(aimOffset).toFixed(2)}m ${side}`;
    }

    const sign = speedDiff >= 0 ? "+" : "";
    const speedLabel = `${flatRoll.toFixed(1)}m (${sign}${speedDiff.toFixed(1)}m)`;

    return {
        aimAngle: finalAim,
        launchSpeed: finalSpeed,
        aimOffsetM: aimOffset,
        aimPoint: [aimPointX, aimPointY],
        flatDistanceM: flatRoll,
        actualDistanceM: dist,
        speedDiffM: speedDiff,
        offsetLabel,
        speedLabel,
        straightAngle,
    };
}

// ── Main solver ──────────────────────────────────────────────────────────

function solvePutt(ballXY, holeXY, mu, dem) {
    const [bx, by] = ballXY;
    const [hx, hy] = holeXY;
    const dist = Math.sqrt((hx - bx) * (hx - bx) + (hy - by) * (hy - by));
    const straightAngle = Math.atan2(hy - by, hx - bx);
    const v0Flat = Math.sqrt(2 * mu * G * (dist + ROLLOUT_M));

    // Phase 1: coarse
    const coarse = gridSearch(
        bx, by,
        straightAngle - COARSE_ANGLE_RANGE, straightAngle + COARSE_ANGLE_RANGE,
        COARSE_N_ANGLES,
        v0Flat * COARSE_SPEED_LO, v0Flat * COARSE_SPEED_HI,
        COARSE_N_SPEEDS,
        mu, dem, hx, hy
    );

    // Find all coarse candidates within hole radius at valid speed
    const candIndices = [];
    for (let i = 0; i < coarse.N; i++) {
        if (coarse.spAtMin[i] <= CAPTURE_SPEED && coarse.dists[i] < HOLE_RADIUS) {
            candIndices.push(i);
        }
    }

    let candidates;
    if (candIndices.length === 0) {
        // Fallback: single best
        const bestIdx = bestFromSearch(coarse.dists, coarse.spAtMin, coarse.N);
        candidates = [{ aim: coarse.aims[bestIdx], speed: coarse.speeds[bestIdx] }];
    } else {
        // Sort candidates by aim angle, then cluster
        candIndices.sort((a, b) => coarse.aims[a] - coarse.aims[b]);

        const clusters = [];
        let clusterStart = 0;
        for (let i = 1; i < candIndices.length; i++) {
            if (coarse.aims[candIndices[i]] - coarse.aims[candIndices[i - 1]] > CLUSTER_GAP_RAD) {
                clusters.push([clusterStart, i]);
                clusterStart = i;
            }
        }
        clusters.push([clusterStart, candIndices.length]);

        // Best from each cluster
        candidates = clusters.map(([lo, hi]) => {
            let bestDist = 1e10, bestJ = lo;
            for (let j = lo; j < hi; j++) {
                if (coarse.dists[candIndices[j]] < bestDist) {
                    bestDist = coarse.dists[candIndices[j]];
                    bestJ = j;
                }
            }
            const idx = candIndices[bestJ];
            return { aim: coarse.aims[idx], speed: coarse.speeds[idx] };
        });
    }

    // Phase 2 & 3: refine each candidate
    const solutions = [];

    for (const cand of candidates) {
        // Fine
        const fine = gridSearch(
            bx, by,
            cand.aim - 3 * Math.PI / 180, cand.aim + 3 * Math.PI / 180,
            FINE_N_ANGLES,
            cand.speed * 0.80, cand.speed * 1.20,
            FINE_N_SPEEDS,
            mu, dem, hx, hy
        );
        const bestF = bestFromSearch(fine.dists, fine.spAtMin, fine.N);

        // Extra-fine
        const ef = gridSearch(
            bx, by,
            fine.aims[bestF] - 0.5 * Math.PI / 180, fine.aims[bestF] + 0.5 * Math.PI / 180,
            101,
            fine.speeds[bestF] * 0.95, fine.speeds[bestF] * 1.05,
            51,
            mu, dem, hx, hy
        );
        const bestEF = bestFromSearch(ef.dists, ef.spAtMin, ef.N);

        if (ef.dists[bestEF] <= HOLE_RADIUS) {
            solutions.push(buildSolution(
                bx, by, hx, hy, dist, straightAngle,
                ef.aims[bestEF], ef.speeds[bestEF], mu
            ));
        }
    }

    // If nothing sank, run lag putt engine to find best resting position
    if (solutions.length === 0) {
        const lag = lagPuttSearch(ballXY, holeXY, mu, dem);
        const sol = buildSolution(bx, by, hx, hy, dist, straightAngle, lag.aim, lag.speed, mu);
        sol.isLagPutt = true;
        sol.lagEndDist = lag.endDist;
        solutions.push(sol);
    }

    // Sort by launch speed (slowest first)
    solutions.sort((a, b) => a.launchSpeed - b.launchSpeed);

    // Deduplicate
    if (solutions.length > 1) {
        const unique = [solutions[0]];
        for (let i = 1; i < solutions.length; i++) {
            let gap = Math.abs(((solutions[i].aimAngle - unique[unique.length - 1].aimAngle + Math.PI) % (2 * Math.PI)) - Math.PI);
            if (gap > DEDUP_GAP_RAD) {
                unique.push(solutions[i]);
            }
        }
        return unique;
    }

    return solutions;
}

// ── Single-trajectory path recorder ──────────────────────────────────────

function simulatePath(ballXY, aimAngle, v0, mu, dem, holeXY) {
    const [bx, by] = ballXY;
    const { sdx, sdy, gx, gy, nx, ny } = dem;
    const x0g = gx[0], y0g = gy[0];
    const dxg = gx[1] - gx[0], dyg = gy[1] - gy[0];

    const hasHole = holeXY != null;
    const hx = hasHole ? holeXY[0] : 0;
    const hy = hasHole ? holeXY[1] : 0;

    let x = bx, y = by;
    let vx = v0 * Math.cos(aimAngle);
    let vy = v0 * Math.sin(aimAngle);

    const pathX = [x], pathY = [y];
    let minDistSq = 1e10;
    const maxSteps = Math.floor(MAX_SIM_S / DT);

    for (let step = 0; step < maxSteps; step++) {
        const sp = Math.sqrt(vx * vx + vy * vy);
        if (sp < MIN_SPEED) break;

        if (hasHole) {
            const dhx = x - hx, dhy = y - hy;
            const distSq = dhx * dhx + dhy * dhy;
            minDistSq = Math.min(distSq, minDistSq);
            if (distSq <= CAPTURE_RADIUS * CAPTURE_RADIUS && sp <= CAPTURE_SPEED) break;
            if (distSq > 1.0 && distSq > minDistSq * 4) break;
        }

        // Bilinear slope interpolation
        const fi = (x - x0g) / dxg;
        const fj = (y - y0g) / dyg;
        const i0 = Math.max(0, Math.min(Math.floor(fi), nx - 2));
        const j0 = Math.max(0, Math.min(Math.floor(fj), ny - 2));
        const fx = Math.max(0, Math.min(fi - i0, 1));
        const fy = Math.max(0, Math.min(fj - j0, 1));

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        const idx00 = j0 * nx + i0;
        const idx10 = j0 * nx + (i0 + 1);
        const idx01 = (j0 + 1) * nx + i0;
        const idx11 = (j0 + 1) * nx + (i0 + 1);

        const slopeX = w00 * sdx[idx00] + w10 * sdx[idx10] +
                        w01 * sdx[idx01] + w11 * sdx[idx11];
        const slopeY = w00 * sdy[idx00] + w10 * sdy[idx10] +
                        w01 * sdy[idx01] + w11 * sdy[idx11];

        const spSafe = Math.max(sp, 1e-10);
        const ux = vx / spSafe, uy = vy / spSafe;
        const accelX = -G * slopeX - mu * G * ux;
        const accelY = -G * slopeY - mu * G * uy;

        vx += accelX * DT;
        vy += accelY * DT;
        x += vx * DT;
        y += vy * DT;

        if (step % 5 === 0) {
            pathX.push(x);
            pathY.push(y);
        }
    }

    pathX.push(x);
    pathY.push(y);
    return { pathX, pathY };
}

// ── DEM binary loader ────────────────────────────────────────────────────
// Reads the .bin format produced by export_web_data.py

function parseDemBin(buffer) {
    // Use DataView for all reads to avoid Float32Array alignment issues.
    // The nanMask (uint8) shifts subsequent data to non-4-aligned offsets,
    // so we copy into fresh typed arrays instead of creating buffer views.
    const view = new DataView(buffer);
    let off = 0;

    const nx = view.getUint16(off, true); off += 2;
    const ny = view.getUint16(off, true); off += 2;
    const nPoly = view.getUint16(off, true); off += 2;
    off += 2; // padding

    function readF32(count) {
        const arr = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            arr[i] = view.getFloat32(off, true);
            off += 4;
        }
        return arr;
    }

    const gx = readF32(nx);
    const gy = readF32(ny);
    const sdx = readF32(ny * nx);
    const sdy = readF32(ny * nx);
    const gzSmooth = readF32(ny * nx);

    const nanMask = new Uint8Array(ny * nx);
    for (let i = 0; i < ny * nx; i++) {
        nanMask[i] = view.getUint8(off);
        off += 1;
    }

    const polyCoords = readF32(nPoly * 2);

    const greenPoly = [];
    for (let i = 0; i < nPoly; i++) {
        greenPoly.push([polyCoords[i * 2], polyCoords[i * 2 + 1]]);
    }

    return { nx, ny, gx, gy, sdx, sdy, gzSmooth, nanMask, greenPoly };
}

// ── Point-in-polygon (ray casting) ───────────────────────────────────────

function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

// ── Exports (for Web Worker) ─────────────────────────────────────────────
if (typeof self !== 'undefined' && typeof module === 'undefined') {
    // Running in a Web Worker or browser
    self.solverAPI = {
        stimpToMu,
        solvePutt,
        simulatePath,
        parseDemBin,
        pointInPolygon,
        HOLE_RADIUS,
        CAPTURE_RADIUS,
        ROLLOUT_M,
    };
}
