// ═══════════════════════════════════════════════════════════════════════════
// Putt Solver — Mobile Touch UI
// ═══════════════════════════════════════════════════════════════════════════

(function() {
    'use strict';

    // ── DOM elements ─────────────────────────────────────────────────────
    const courseSelect = document.getElementById('courseSelect');
    const greenSelect = document.getElementById('greenSelect');
    const stimpInput = document.getElementById('stimpInput');
    const canvas = document.getElementById('greenCanvas');
    const wrapper = document.getElementById('canvasWrapper');
    const statusBar = document.getElementById('statusBar');
    const resetBtn = document.getElementById('resetBtn');
    const prevHoleBtn = document.getElementById('prevHoleBtn');
    const nextHoleBtn = document.getElementById('nextHoleBtn');
    const solLabel = document.getElementById('solLabel');
    const layerSelect = document.getElementById('layerSelect');
    const downloadBtn = document.getElementById('downloadBtn');
    const offlineStatus = document.getElementById('offlineStatus');
    const ctx = canvas.getContext('2d');

    // ── State ────────────────────────────────────────────────────────────
    let courses = null;       // manifest data
    let currentGreenMeta = null;
    let mapImage = null;      // loaded Image object
    let demKey = null;        // key for worker's DEM cache
    let currentLayer = 'slope'; // persists across green/course changes

    let state = 'NO_GREEN';   // NO_GREEN | PLACE_HOLE | PLACE_BALL | SOLVING | SOLVED
                              //           | MANUAL_PLACE_BALL | MANUAL_AIM
    let holeXY = null;        // [x, y] in green coordinates
    let ballXY = null;
    let solutions = [];       // solver results
    let solIndex = 0;

    // ── Manual mode ──────────────────────────────────────────────────────
    let appMode = 'solver';           // 'solver' | 'manual'
    let manualPaths = [];             // accumulated trajectories
    let pendingManualAim = null;      // { aimAngle, v0, aimPoint } while waiting for path

    // Physics constants (mirrors solver.js — used for manual speed calc)
    const G_APP = 9.81;
    const V0_STIM_APP = 1.83;
    const ROLLOUT_APP = 0.43;

    function stimpToMuApp(stimpFeet) {
        const stimpM = stimpFeet * 0.3048;
        return (V0_STIM_APP * V0_STIM_APP) / (2 * G_APP * stimpM);
    }

    // Display transform: green coords ↔ canvas pixels
    let transform = null;     // { scale, offsetX, offsetY, imgW, imgH }

    // Zoom/pan state (applied on top of base transform)
    let viewZoom = 1.0;
    let viewPanX = 0;  // canvas pixels
    let viewPanY = 0;

    // ── Colours ──────────────────────────────────────────────────────────
    const PUTT_COLOURS = [
        '#FF4444', '#44AAFF', '#44DD44', '#FF8800',
        '#AA44FF', '#FF44AA', '#44FFDD', '#DDDD00',
    ];

    // ── Web Worker ───────────────────────────────────────────────────────
    const worker = new Worker('worker.js');

    worker.onerror = function(err) {
        console.error('Worker error:', err);
        setStatus('Worker error: ' + err.message, 'error');
    };

    worker.onmessage = function(e) {
        const { command } = e.data;
        console.log('Worker message:', command, e.data);

        if (command === 'demLoaded') {
            demKey = e.data.key;
            state = 'PLACE_HOLE';
            setStatus('Tap to place the hole', 'instruction');
            render();
            return;
        }

        if (command === 'error') {
            setStatus(e.data.message, 'error');
            state = currentGreenMeta ? 'PLACE_HOLE' : 'NO_GREEN';
            return;
        }

        if (command === 'solved') {
            solutions = e.data.solutions;
            solIndex = 0;

            if (solutions.length === 0) {
                state = 'PLACE_BALL';
                setStatus('No solution found. Tap another ball position.', 'error');
            } else {
                state = 'SOLVED';
                showSolutionStatus();
            }
            updateSolNav();
            render();
        }

        if (command === 'error') {
            setStatus(e.data.message, 'error');
            state = 'PLACE_BALL';
        }

        if (command === 'pathResult') {
            if (e.data.tag === 'manual' && pendingManualAim && state === 'MANUAL_AIM') {
                const { aimAngle, v0, aimPoint } = pendingManualAim;
                pendingManualAim = null;
                const stats = computeManualStats(aimAngle, v0, e.data.pathX, e.data.pathY);
                const colour = PUTT_COLOURS[manualPaths.length % PUTT_COLOURS.length];
                manualPaths.push({ pathX: e.data.pathX, pathY: e.data.pathY, aimPoint, colour, stats });
                showManualStatus();
                render();
            }
        }
    };

    // ── Status bar ───────────────────────────────────────────────────────

    function setStatus(text, type) {
        statusBar.textContent = text;
        statusBar.className = 'status-bar ' + (type || 'instruction');
    }

    function showSolutionStatus() {
        const sol = solutions[solIndex];
        const n = solutions.length;
        const tag = n > 1 ? ` [${solIndex + 1}/${n}]` : '';
        if (sol.isBestAttempt) {
            const missM = sol.missDistance.toFixed(2);
            setStatus(`No solution — closest: ${missM}m miss  |  Aim: ${sol.offsetLabel}  |  Speed: ${sol.speedLabel}${tag}`, 'warning');
        } else {
            setStatus(`Aim: ${sol.offsetLabel}  |  Speed: ${sol.speedLabel}${tag}`, 'result');
        }
    }

    // ── Manual mode helpers ──────────────────────────────────────────────

    function computeManualStats(aimAngle, v0, pathX, pathY) {
        const mu = stimpToMuApp(parseFloat(stimpInput.value) || 10);
        const flatRoll = (v0 * v0) / (2 * G_APP * mu);

        const holeDist = holeXY
            ? Math.sqrt((holeXY[0] - ballXY[0]) ** 2 + (holeXY[1] - ballXY[1]) ** 2)
            : 0;
        const speedDiff = flatRoll - holeDist;
        const sign = speedDiff >= 0 ? '+' : '';
        const speedLabel = `${flatRoll.toFixed(1)}m (${sign}${speedDiff.toFixed(1)}m)`;

        const straightAngle = holeXY
            ? Math.atan2(holeXY[1] - ballXY[1], holeXY[0] - ballXY[0])
            : 0;
        let angleDiff = ((aimAngle - straightAngle + Math.PI) % (2 * Math.PI)) - Math.PI;
        if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        const aimOffset = holeDist * Math.sin(angleDiff);
        let offsetLabel;
        if (Math.abs(aimOffset) < 0.05) {
            offsetLabel = 'Straight';
        } else {
            const side = aimOffset > 0 ? 'left' : 'right';
            offsetLabel = `${Math.abs(aimOffset).toFixed(2)}m ${side}`;
        }

        const endX = pathX[pathX.length - 1];
        const endY = pathY[pathY.length - 1];
        const missDist = holeXY
            ? Math.sqrt((endX - holeXY[0]) ** 2 + (endY - holeXY[1]) ** 2)
            : 0;

        return { speedLabel, offsetLabel, missDist };
    }

    function showManualStatus() {
        if (manualPaths.length === 0) {
            setStatus('Manual — tap to set aim', 'instruction');
            return;
        }
        const { stats } = manualPaths[manualPaths.length - 1];
        const n = manualPaths.length;
        const tag = n > 1 ? ` [path ${n}]` : '';
        setStatus(`Aim: ${stats.offsetLabel}  |  Speed: ${stats.speedLabel}  |  Miss: ${stats.missDist.toFixed(2)}m${tag}`, 'result');
    }

    // ── Mode toggle ──────────────────────────────────────────────────────

    const modeBtn = document.getElementById('modeBtn');

    modeBtn.addEventListener('click', () => {
        appMode = appMode === 'solver' ? 'manual' : 'solver';
        modeBtn.textContent = appMode === 'manual' ? 'Solver' : 'Manual';
        modeBtn.classList.toggle('active', appMode === 'manual');
        holeXY = null;
        ballXY = null;
        solutions = [];
        solIndex = 0;
        manualPaths = [];
        pendingManualAim = null;
        if (state !== 'NO_GREEN') {
            state = 'PLACE_HOLE';
            const prefix = appMode === 'manual' ? 'Manual — ' : '';
            setStatus(prefix + 'Tap to place the hole', 'instruction');
        }
        updateSolNav();
        render();
    });

    // ── Solution label ──────────────────────────────────────────────────

    function updateSolNav() {
        const n = solutions.length;
        solLabel.textContent = n > 1 ? `Sol ${solIndex + 1}/${n}` : '';
    }

    // ── Hole navigation ──────────────────────────────────────────────────

    function changeHole(delta) {
        const opts = greenSelect.options;
        if (opts.length === 0) return;
        let idx = greenSelect.selectedIndex + delta;
        if (idx < 0) idx = opts.length - 1;
        if (idx >= opts.length) idx = 0;
        greenSelect.selectedIndex = idx;
        loadGreen();
    }

    prevHoleBtn.addEventListener('click', () => changeHole(-1));
    nextHoleBtn.addEventListener('click', () => changeHole(1));

    // ── Reset ────────────────────────────────────────────────────────────

    resetBtn.addEventListener('click', () => {
        if (state === 'NO_GREEN') return;
        holeXY = null;
        ballXY = null;
        solutions = [];
        solIndex = 0;
        manualPaths = [];
        pendingManualAim = null;
        state = 'PLACE_HOLE';
        const prefix = appMode === 'manual' ? 'Manual — ' : '';
        setStatus(prefix + 'Tap to place the hole', 'instruction');
        updateSolNav();
        render();
    });

    // ── Download/save ────────────────────────────────────────────────────

    downloadBtn.addEventListener('click', () => {
        const link = document.createElement('a');
        link.download = 'putt_solver.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
    });

    // ── Coordinate transform ─────────────────────────────────────────────

    function setupTransform() {
        if (!mapImage || !currentGreenMeta) return;

        const cw = canvas.width;
        const ch = canvas.height;
        const meta = currentGreenMeta;

        // Map image aspect ratio
        const imgAspect = mapImage.width / mapImage.height;
        let imgW, imgH;
        if (cw / ch > imgAspect) {
            imgH = ch;
            imgW = ch * imgAspect;
        } else {
            imgW = cw;
            imgH = cw / imgAspect;
        }

        const offsetX = (cw - imgW) / 2;
        const offsetY = (ch - imgH) / 2;

        // Green coordinate range
        const gxRange = meta.x_max - meta.x_min;
        const gyRange = meta.y_max - meta.y_min;

        transform = {
            imgW, imgH, offsetX, offsetY,
            xMin: meta.x_min, xMax: meta.x_max,
            yMin: meta.y_min, yMax: meta.y_max,
            gxRange, gyRange,
        };
    }

    function greenToCanvas(gx, gy) {
        if (!transform) return [0, 0];
        const t = transform;
        // Base position (no zoom/pan)
        let px = t.offsetX + ((gx - t.xMin) / t.gxRange) * t.imgW;
        let py = t.offsetY + ((t.yMax - gy) / t.gyRange) * t.imgH;
        // Apply zoom/pan: zoom around canvas centre
        const cw = canvas.width, ch = canvas.height;
        px = (px - cw / 2) * viewZoom + cw / 2 + viewPanX;
        py = (py - ch / 2) * viewZoom + ch / 2 + viewPanY;
        return [px, py];
    }

    function canvasToGreen(px, py) {
        if (!transform) return [0, 0];
        const t = transform;
        // Undo zoom/pan
        const cw = canvas.width, ch = canvas.height;
        px = (px - cw / 2 - viewPanX) / viewZoom + cw / 2;
        py = (py - ch / 2 - viewPanY) / viewZoom + ch / 2;
        // Base conversion
        const gx = t.xMin + ((px - t.offsetX) / t.imgW) * t.gxRange;
        const gy = t.yMax - ((py - t.offsetY) / t.imgH) * t.gyRange;
        return [gx, gy];
    }

    // ── Rendering ────────────────────────────────────────────────────────

    function render() {
        const cw = canvas.width;
        const ch = canvas.height;
        ctx.clearRect(0, 0, cw, ch);

        // Background
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, cw, ch);

        // Map image (with zoom/pan)
        if (mapImage && transform) {
            const t = transform;
            const cx = cw / 2, cy = ch / 2;
            const dx = (t.offsetX - cx) * viewZoom + cx + viewPanX;
            const dy = (t.offsetY - cy) * viewZoom + cy + viewPanY;
            ctx.drawImage(mapImage, dx, dy, t.imgW * viewZoom, t.imgH * viewZoom);
        }

        if (!transform) return;

        const dpr = window.devicePixelRatio || 1;

        // Draw solved putt (current solution)
        if (state === 'SOLVED' && solutions.length > 0) {
            const sol = solutions[solIndex];
            const colour = sol.isBestAttempt ? '#FF8800' : PUTT_COLOURS[solIndex % PUTT_COLOURS.length];

            // Putt path (curved)
            if (sol.pathX && sol.pathX.length > 1) {
                ctx.beginPath();
                const [sx, sy] = greenToCanvas(sol.pathX[0], sol.pathY[0]);
                ctx.moveTo(sx, sy);
                for (let i = 1; i < sol.pathX.length; i++) {
                    const [px, py] = greenToCanvas(sol.pathX[i], sol.pathY[i]);
                    ctx.lineTo(px, py);
                }
                ctx.strokeStyle = colour;
                ctx.lineWidth = 2.5 * dpr;
                ctx.lineCap = 'round';
                ctx.stroke();
            }

            // Aim line (dashed)
            if (ballXY && sol.aimPoint) {
                const [bpx, bpy] = greenToCanvas(ballXY[0], ballXY[1]);
                const [apx, apy] = greenToCanvas(sol.aimPoint[0], sol.aimPoint[1]);
                ctx.beginPath();
                ctx.moveTo(bpx, bpy);
                ctx.lineTo(apx, apy);
                ctx.strokeStyle = colour;
                ctx.lineWidth = 1.5 * dpr;
                ctx.setLineDash([6 * dpr, 4 * dpr]);
                ctx.globalAlpha = 0.7;
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1.0;

                // Aim point marker (x)
                const sz = 6 * dpr;
                ctx.beginPath();
                ctx.moveTo(apx - sz, apy - sz); ctx.lineTo(apx + sz, apy + sz);
                ctx.moveTo(apx + sz, apy - sz); ctx.lineTo(apx - sz, apy + sz);
                ctx.strokeStyle = colour;
                ctx.lineWidth = 2.5 * dpr;
                ctx.stroke();
            }

            // Reference line to hole (dotted white)
            if (ballXY && holeXY) {
                const [bpx, bpy] = greenToCanvas(ballXY[0], ballXY[1]);
                const [hpx, hpy] = greenToCanvas(holeXY[0], holeXY[1]);
                ctx.beginPath();
                ctx.moveTo(bpx, bpy);
                ctx.lineTo(hpx, hpy);
                ctx.strokeStyle = 'rgba(255,255,255,0.4)';
                ctx.lineWidth = 1 * dpr;
                ctx.setLineDash([3 * dpr, 3 * dpr]);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Draw manual mode trajectories
        if ((state === 'MANUAL_AIM' || state === 'MANUAL_PLACE_BALL') && manualPaths.length > 0) {
            for (const mp of manualPaths) {
                const colour = mp.colour;

                // Path line
                if (mp.pathX && mp.pathX.length > 1) {
                    ctx.beginPath();
                    const [sx, sy] = greenToCanvas(mp.pathX[0], mp.pathY[0]);
                    ctx.moveTo(sx, sy);
                    for (let i = 1; i < mp.pathX.length; i++) {
                        const [px, py] = greenToCanvas(mp.pathX[i], mp.pathY[i]);
                        ctx.lineTo(px, py);
                    }
                    ctx.strokeStyle = colour;
                    ctx.lineWidth = 2.5 * dpr;
                    ctx.lineCap = 'round';
                    ctx.stroke();
                }

                // Dashed aim line from ball to aim point
                if (ballXY && mp.aimPoint) {
                    const [bpx, bpy] = greenToCanvas(ballXY[0], ballXY[1]);
                    const [apx, apy] = greenToCanvas(mp.aimPoint[0], mp.aimPoint[1]);
                    ctx.beginPath();
                    ctx.moveTo(bpx, bpy);
                    ctx.lineTo(apx, apy);
                    ctx.strokeStyle = colour;
                    ctx.lineWidth = 1.5 * dpr;
                    ctx.setLineDash([6 * dpr, 4 * dpr]);
                    ctx.globalAlpha = 0.6;
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.globalAlpha = 1.0;

                    // Aim point marker (×)
                    const sz = 5 * dpr;
                    ctx.beginPath();
                    ctx.moveTo(apx - sz, apy - sz); ctx.lineTo(apx + sz, apy + sz);
                    ctx.moveTo(apx + sz, apy - sz); ctx.lineTo(apx - sz, apy + sz);
                    ctx.strokeStyle = colour;
                    ctx.lineWidth = 2 * dpr;
                    ctx.stroke();
                }

                // Endpoint dot (where ball stopped)
                if (mp.pathX && mp.pathX.length > 0) {
                    const ex = mp.pathX[mp.pathX.length - 1];
                    const ey = mp.pathY[mp.pathY.length - 1];
                    const [epx, epy] = greenToCanvas(ex, ey);
                    ctx.beginPath();
                    ctx.arc(epx, epy, 4 * dpr, 0, Math.PI * 2);
                    ctx.fillStyle = colour;
                    ctx.fill();
                }
            }

            // White dotted line from ball to hole (reference)
            if (ballXY && holeXY) {
                const [bpx, bpy] = greenToCanvas(ballXY[0], ballXY[1]);
                const [hpx, hpy] = greenToCanvas(holeXY[0], holeXY[1]);
                ctx.beginPath();
                ctx.moveTo(bpx, bpy);
                ctx.lineTo(hpx, hpy);
                ctx.strokeStyle = 'rgba(255,255,255,0.4)';
                ctx.lineWidth = 1 * dpr;
                ctx.setLineDash([3 * dpr, 3 * dpr]);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Hole marker
        if (holeXY) {
            const [hpx, hpy] = greenToCanvas(holeXY[0], holeXY[1]);
            const r = 8 * dpr;
            ctx.beginPath();
            ctx.arc(hpx, hpy, r, 0, Math.PI * 2);
            ctx.fillStyle = '#000';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2 * dpr;
            ctx.stroke();
        }

        // Ball marker
        if (ballXY) {
            const [bpx, bpy] = greenToCanvas(ballXY[0], ballXY[1]);
            const r = 6 * dpr;
            ctx.beginPath();
            ctx.arc(bpx, bpy, r, 0, Math.PI * 2);
            ctx.fillStyle = '#44AAFF';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5 * dpr;
            ctx.stroke();
        }
    }

    // ── Canvas sizing ────────────────────────────────────────────────────

    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const rect = wrapper.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        setupTransform();
        render();
    }

    window.addEventListener('resize', resizeCanvas);

    // ── Touch/click handling with pinch-zoom and pan ────────────────────

    let lastTapTime = 0;
    let touchStartTime = 0;
    let touchStartPos = null;   // { x, y } client coords of single-finger start
    let touchMoved = false;     // did the finger move significantly?
    let isPanning = false;
    let panLastX = 0, panLastY = 0;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    function handleTap(clientX, clientY) {
        const now = Date.now();
        if (now - lastTapTime < 200) return;
        lastTapTime = now;

        if (state === 'NO_GREEN' || state === 'SOLVING') return;

        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const px = (clientX - rect.left) * dpr;
        const py = (clientY - rect.top) * dpr;
        const [gx, gy] = canvasToGreen(px, py);

        if (state === 'PLACE_HOLE') {
            holeXY = [gx, gy];
            ballXY = null;
            solutions = [];
            manualPaths = [];
            if (appMode === 'manual') {
                state = 'MANUAL_PLACE_BALL';
                setStatus('Manual — tap to place ball', 'instruction');
            } else {
                state = 'PLACE_BALL';
                setStatus('Tap to place the ball', 'instruction');
            }
            updateSolNav();
            render();
            return;
        }

        if (state === 'MANUAL_PLACE_BALL') {
            ballXY = [gx, gy];
            manualPaths = [];
            pendingManualAim = null;
            state = 'MANUAL_AIM';
            setStatus('Manual — tap to set aim', 'instruction');
            render();
            return;
        }

        if (state === 'MANUAL_AIM') {
            const stimpVal = parseFloat(stimpInput.value) || 10;
            const mu = stimpToMuApp(stimpVal);
            const aimAngle = Math.atan2(gy - ballXY[1], gx - ballXY[0]);
            const aimDist = Math.sqrt((gx - ballXY[0]) ** 2 + (gy - ballXY[1]) ** 2);
            const v0 = Math.sqrt(2 * mu * G_APP * (aimDist + ROLLOUT_APP));
            pendingManualAim = { aimAngle, v0, aimPoint: [gx, gy] };
            worker.postMessage({
                command: 'simulatePath',
                data: {
                    demKey: demKey,
                    ballXY: ballXY,
                    aimAngle: aimAngle,
                    v0: v0,
                    holeXY: holeXY,
                    stimp: stimpVal,
                    tag: 'manual',
                },
            });
            return;
        }

        if (state === 'PLACE_BALL' || state === 'SOLVED') {
            ballXY = [gx, gy];
            solutions = [];
            solIndex = 0;
            state = 'SOLVING';
            setStatus('Solving...', 'solving');
            updateSolNav();
            render();

            worker.postMessage({
                command: 'solve',
                data: {
                    demKey: demKey,
                    ballXY: ballXY,
                    holeXY: holeXY,
                    stimp: parseFloat(stimpInput.value) || 10,
                },
            });
            return;
        }
    }

    // Desktop: click = tap, wheel = zoom
    canvas.addEventListener('click', (e) => {
        e.preventDefault();
        handleTap(e.clientX, e.clientY);
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const mx = (e.clientX - rect.left) * dpr;
        const my = (e.clientY - rect.top) * dpr;

        // Zoom toward mouse position
        const cw = canvas.width, ch = canvas.height;
        const oldZoom = viewZoom;
        viewZoom = Math.max(1, Math.min(10, viewZoom * zoomFactor));
        const scale = viewZoom / oldZoom;

        viewPanX = (viewPanX - mx + cw / 2) * scale + mx - cw / 2;
        viewPanY = (viewPanY - my + ch / 2) * scale + my - ch / 2;

        // Reset pan if zoomed all the way out
        if (viewZoom <= 1) { viewPanX = 0; viewPanY = 0; }

        render();
    }, { passive: false });

    // Mobile: distinguish tap vs pan vs pinch
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();

        if (e.touches.length === 1) {
            touchStartTime = Date.now();
            touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            touchMoved = false;
            isPanning = false;
            panLastX = e.touches[0].clientX;
            panLastY = e.touches[0].clientY;
        }

        if (e.touches.length === 2) {
            // Pinch start
            touchMoved = true; // not a tap
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            pinchStartDist = Math.sqrt(dx * dx + dy * dy);
            pinchStartZoom = viewZoom;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();

        if (e.touches.length === 1 && touchStartPos) {
            const dx = e.touches[0].clientX - touchStartPos.x;
            const dy = e.touches[0].clientY - touchStartPos.y;
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                touchMoved = true;
                isPanning = true;
            }

            if (isPanning && viewZoom > 1) {
                const dpr = window.devicePixelRatio || 1;
                viewPanX += (e.touches[0].clientX - panLastX) * dpr;
                viewPanY += (e.touches[0].clientY - panLastY) * dpr;
                panLastX = e.touches[0].clientX;
                panLastY = e.touches[0].clientY;
                render();
            }
        }

        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const newZoom = Math.max(1, Math.min(10, pinchStartZoom * (dist / pinchStartDist)));

            // Zoom toward pinch centre
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const mx = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left) * dpr;
            const my = ((e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top) * dpr;
            const cw = canvas.width, ch = canvas.height;

            const scale = newZoom / viewZoom;
            viewPanX = (viewPanX - mx + cw / 2) * scale + mx - cw / 2;
            viewPanY = (viewPanY - my + ch / 2) * scale + my - ch / 2;
            viewZoom = newZoom;

            if (viewZoom <= 1) { viewPanX = 0; viewPanY = 0; }
            render();
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        e.preventDefault();

        // If it was a quick tap with no movement, treat as a tap
        if (!touchMoved && touchStartPos) {
            const elapsed = Date.now() - touchStartTime;
            if (elapsed < 300) {
                handleTap(touchStartPos.x, touchStartPos.y);
            }
        }
        touchStartPos = null;
        isPanning = false;
    }, { passive: false });

    // ── Layer switching ────────────────────────────────────────────────

    async function loadMapImage(courseName, greenMeta) {
        const layers = greenMeta.layers || {};
        // Find best available layer: try current, then fallback
        let layerFile = layers[currentLayer];
        if (!layerFile) {
            // Fallback to first available layer
            const available = Object.keys(layers);
            if (available.length > 0) {
                layerFile = layers[available[0]];
            }
        }
        if (layerFile) {
            const imgUrl = `data/${courseName}/${layerFile}`;
            console.log('Loading map image:', imgUrl);
            mapImage = await loadImage(imgUrl);
            console.log('Map image loaded:', mapImage.width, 'x', mapImage.height);
        } else {
            // Legacy format: single map_file
            if (greenMeta.map_file) {
                const imgUrl = `data/${courseName}/${greenMeta.map_file}`;
                mapImage = await loadImage(imgUrl);
            }
        }
    }

    layerSelect.addEventListener('change', async () => {
        currentLayer = layerSelect.value;
        if (currentGreenMeta && courseSelect.value) {
            await loadMapImage(courseSelect.value, currentGreenMeta);
            setupTransform();
            render();
        }
    });

    // ── Course/green loading ─────────────────────────────────────────────

    async function loadManifest() {
        try {
            const resp = await fetch('data/courses.json');
            courses = await resp.json();
        } catch (err) {
            setStatus('Could not load course data. Run export_web_data.py first.', 'error');
            return;
        }

        courseSelect.innerHTML = '';
        if (courses.courses.length === 0) {
            courseSelect.innerHTML = '<option value="">No courses</option>';
            return;
        }

        courses.courses.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.course;
            opt.textContent = c.course;
            courseSelect.appendChild(opt);
        });

        populateGreens(courses.courses[0]);
    }

    function populateGreens(courseData) {
        greenSelect.innerHTML = '';
        courseData.greens.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.green;
            // Extract hole number from "green_01" → "1"
            const num = parseInt(g.green.replace('green_', ''), 10);
            opt.textContent = `Hole ${num}`;
            greenSelect.appendChild(opt);
        });
    }

    courseSelect.addEventListener('change', () => {
        const cd = courses.courses.find(c => c.course === courseSelect.value);
        if (cd) {
            populateGreens(cd);
            loadGreen();
        }
    });

    greenSelect.addEventListener('change', loadGreen);

    async function loadGreen() {
        const courseName = courseSelect.value;
        const greenName = greenSelect.value;
        if (!courseName || !greenName) return;

        const courseData = courses.courses.find(c => c.course === courseName);
        const greenMeta = courseData.greens.find(g => g.green === greenName);
        if (!greenMeta) return;

        currentGreenMeta = greenMeta;
        state = 'NO_GREEN';
        holeXY = null;
        ballXY = null;
        solutions = [];
        viewZoom = 1; viewPanX = 0; viewPanY = 0;
        updateSolNav();
        setStatus('Loading green...', 'instruction');

        try {
            // Load map image for current layer
            await loadMapImage(courseName, greenMeta);

            // Load DEM binary
            const binUrl = `data/${courseName}/${greenMeta.bin_file}`;
            console.log('Loading DEM binary:', binUrl);
            const resp = await fetch(binUrl);
            const buffer = await resp.arrayBuffer();
            console.log('DEM binary loaded:', buffer.byteLength, 'bytes');

            const key = `${courseName}/${greenName}`;
            demKey = null; // will be set when worker confirms
            worker.postMessage({ command: 'loadDem', data: { key, buffer } }, [buffer]);
            console.log('Sent DEM to worker, waiting for demLoaded...');

            resizeCanvas();
        } catch (err) {
            console.error('loadGreen error:', err);
            setStatus('Error loading green: ' + err.message, 'error');
        }
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to load image: ' + url));
            img.src = url;
        });
    }

    // ── Service Worker ──────────────────────────────────────────────────

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // ── Download course for offline ──────────────────────────────────────

    const downloadCourseBtn = document.getElementById('downloadCourseBtn');
    const downloadStatusEl = document.getElementById('downloadStatus');

    downloadCourseBtn.addEventListener('click', async () => {
        const courseName = courseSelect.value;
        if (!courseName || !courses) return;

        const courseData = courses.courses.find(c => c.course === courseName);
        if (!courseData) return;

        downloadCourseBtn.disabled = true;

        // Build list of all URLs to cache
        const urls = ['data/courses.json'];
        for (const g of courseData.greens) {
            urls.push(`data/${courseName}/${g.bin_file}`);
            if (g.layers) {
                for (const file of Object.values(g.layers)) {
                    urls.push(`data/${courseName}/${file}`);
                }
            }
            if (g.map_file) {
                urls.push(`data/${courseName}/${g.map_file}`);
            }
        }

        let done = 0;
        const total = urls.length;
        downloadStatusEl.textContent = `0/${total}`;

        // Fetch each file — the Service Worker's fetch handler will cache them.
        // Process 3 at a time to avoid overwhelming the browser.
        for (let i = 0; i < urls.length; i += 3) {
            const batch = urls.slice(i, i + 3);
            const promises = batch.map(url =>
                fetch(url)
                    .then(r => r.blob())  // consume the response so it completes
                    .catch(() => {})
            );
            await Promise.all(promises);
            done += batch.length;
            downloadStatusEl.textContent = `${Math.min(done, total)}/${total}`;
        }

        downloadStatusEl.textContent = `${courseName} ready for offline`;
        downloadCourseBtn.disabled = false;
    });

    // ── Init ─────────────────────────────────────────────────────────────

    resizeCanvas();
    loadManifest().then(() => {
        if (courses && courses.courses.length > 0) {
            loadGreen();
        }
    });

})();
