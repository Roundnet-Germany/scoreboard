// Base URL of the Roundnet Playerzone (PZ) - its own module, so pages
// without the input panel (overview.html) can link to the PZ without
// loading main.js.

const DEFAULT_PZ_BASE = 'https://playerzone.roundnetgermany.de';
const PZ_BASE_KEY = 'pz_base';

/**
 * PZ base URL. Overridable for testing against a local PZ: ?pz=http://localhost:8000
 * (remembered in localStorage), ?pz=default goes back to production.
 * Only while the scoreboard itself runs on localhost - on the live site a link
 * with ?pz= could otherwise point an operator's panel at any server for good.
 */
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(window.location.hostname);
export const PZ_BASE = (() => {
    const param = new URLSearchParams(window.location.search).get('pz');
    try {
        if (!IS_LOCAL) {
            localStorage.removeItem(PZ_BASE_KEY);
            return DEFAULT_PZ_BASE;
        }
        if (param === 'default' || param === '') localStorage.removeItem(PZ_BASE_KEY);
        else if (param && /^https?:\/\/[^\s]+$/.test(param)) localStorage.setItem(PZ_BASE_KEY, param.replace(/\/+$/, ''));
        return localStorage.getItem(PZ_BASE_KEY) || DEFAULT_PZ_BASE;
    } catch {
        return DEFAULT_PZ_BASE;
    }
})();
if (PZ_BASE !== DEFAULT_PZ_BASE) console.info(`[Playerzone] using ${PZ_BASE}`);

/** Public PZ page of a game (rosters, result, previous meetings). */
export const pzGamePage = (gameId) => `${PZ_BASE}/tournaments/game-info/${encodeURIComponent(gameId)}`;
