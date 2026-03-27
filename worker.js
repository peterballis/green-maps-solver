// Web Worker — runs the solver off the main thread so the UI stays responsive.
// Receives solve requests, returns solutions + paths.

importScripts('solver.js');

const api = self.solverAPI;

// Cache loaded DEMs so we don't re-parse on every solve
const demCache = {};

self.onmessage = async function(e) {
    const { command, data } = e.data;

    if (command === 'loadDem') {
        try {
            demCache[data.key] = api.parseDemBin(data.buffer);
            self.postMessage({ command: 'demLoaded', key: data.key });
        } catch (err) {
            self.postMessage({ command: 'error', message: 'DEM parse error: ' + err.message });
        }
        return;
    }

    if (command === 'solve') {
        const dem = demCache[data.demKey];
        if (!dem) {
            self.postMessage({ command: 'error', message: 'DEM not loaded' });
            return;
        }

        const mu = api.stimpToMu(data.stimp);
        const t0 = performance.now();
        const solutions = api.solvePutt(data.ballXY, data.holeXY, mu, dem);
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

        const results = solutions.map(sol => {
            const { pathX, pathY } = api.simulatePath(
                data.ballXY, sol.aimAngle, sol.launchSpeed, mu, dem, data.holeXY
            );
            return { ...sol, pathX, pathY };
        });

        self.postMessage({ command: 'solved', solutions: results, elapsed });
        return;
    }

    if (command === 'simulatePath') {
        const dem = demCache[data.demKey];
        if (!dem) {
            self.postMessage({ command: 'error', message: 'DEM not loaded' });
            return;
        }

        const mu = api.stimpToMu(data.stimp);
        const { pathX, pathY } = api.simulatePath(
            data.ballXY, data.aimAngle, data.v0, mu, dem, data.holeXY || null
        );

        self.postMessage({ command: 'pathResult', pathX, pathY, tag: data.tag });
        return;
    }
};
