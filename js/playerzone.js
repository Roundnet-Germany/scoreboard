// Roundnet Playerzone (PZ) - public scoreboard API.
//
// The input panel picks a game here (event -> division/phase -> game) or takes
// a game id copied from a PZ game card, then imports it via
// Scoreboard.loadPlayerzoneGame(). What the PZ reads back for its live view is
// written there too (match-<channel>/playerzone, live_games/<game_id>).
// syncToPlayerzone() asks the PZ to store the current score as an interim
// result - the PZ reads it from Firebase itself, so the court has to still
// carry that game when it's called.

import { showToast } from "./main.js?v=4";

const DEFAULT_PZ_BASE = 'https://playerzone.roundnetgermany.de';
const PZ_BASE_KEY = 'pz_base';
const SELECTION_KEY = 'pz_selection';

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

/** Every PZ endpoint the scoreboard uses - all calls (and the pagehide beacon) build their URL here. */
export const pzUrl = {
    events: (query = '') => `${PZ_BASE}/api/events${query ? `?q=${encodeURIComponent(query)}` : ''}`,
    phaseGames: (phaseId) => `${PZ_BASE}/api/phases/${encodeURIComponent(phaseId)}/games`,
    gameScoreboard: (gameId) => `${PZ_BASE}/api/games/${encodeURIComponent(gameId)}/scoreboard`,
    gameScoreboardSync: (gameId) => `${PZ_BASE}/api/games/${encodeURIComponent(gameId)}/scoreboard-sync`,
};

/** GET a PZ endpoint; throws an Error with the PZ's own `error` message on failure. */
async function pzFetch(url) {
    let response;
    try {
        response = await fetch(url);
    } catch {
        throw new Error("Playerzone isn't reachable");
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Playerzone error (${response.status})`);
    if (!body) throw new Error('Invalid response from Playerzone');
    return body;
}

export const fetchEvents = (query = '') =>
    pzFetch(pzUrl.events(query)).then((body) => body.events || []);
export const fetchPhaseGames = (phaseId) => pzFetch(pzUrl.phaseGames(phaseId));
export const fetchGame = (gameId) => pzFetch(pzUrl.gameScoreboard(gameId));

const SYNC_TIMEOUT_MS = 5000;

/**
 * Store the court's current score of a game as interim result in the PZ.
 * Never throws and gives up after SYNC_TIMEOUT_MS, so callers can simply
 * await it and carry on. A failure shows a toast; `saved: false` (e.g. the
 * game already has a complete result) is no failure.
 * @returns {Promise<Object|null>} the PZ's answer ({ saved, sets | reason }) or null on failure
 */
export async function syncToPlayerzone(gameId) {
    if (!gameId) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    try {
        const response = await fetch(pzUrl.gameScoreboardSync(gameId), { method: 'POST', signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
        if (!body?.saved) console.info(`[Playerzone] game ${gameId} not saved:`, body?.reason);
        return body || {};
    } catch (err) {
        console.warn(`[Playerzone] sync of game ${gameId} failed:`, err.name === 'AbortError' ? 'timeout' : err.message);
        showToast("⚠️", "Interim score couldn't be saved in the Playerzone.");
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/** Best-effort sync while the page is going away (pagehide) - no answer. */
export function sendSyncBeacon(gameId) {
    if (!gameId || !navigator.sendBeacon) return;
    try {
        navigator.sendBeacon(pzUrl.gameScoreboardSync(gameId));
    } catch { /* best effort */ }
}

function loadSelection() {
    try {
        return JSON.parse(localStorage.getItem(SELECTION_KEY)) || {};
    } catch {
        return {};
    }
}

function saveSelection(selection) {
    try {
        localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
    } catch { /* private mode etc. - just not remembered */ }
}

function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date)) return '';
    const sameDay = date.toDateString() === new Date().toDateString();
    return date.toLocaleString([], sameDay
        ? { hour: '2-digit', minute: '2-digit' }
        : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

const GAMES_COLLAPSED_KEY = 'pz_games_collapsed';

/**
 * Small dropdown for the picker: a trigger button showing the selection and a
 * panel with an optional search field and a grouped list.
 * Items: { value, label, sublabel?, group?, display? } - `display` is what the
 * trigger shows once selected (defaults to label).
 */
class PlayerzoneDropdown {
    /**
     * @param {jQuery} $root - empty .pz_dropdown element
     * @param {Object} opts
     * @param {string} opts.placeholder - trigger text without selection
     * @param {string} [opts.searchPlaceholder] - shows a search field when set
     * @param {Function} [opts.onSearch] - debounced, gets the query (server search)
     * @param {Function} opts.onChange - gets the picked item
     */
    constructor($root, { placeholder, searchPlaceholder, onSearch, onChange }) {
        this.$root = $root;
        this.placeholder = placeholder;
        this.onSearch = onSearch;
        this.onChange = onChange;
        this.items = [];
        this.value = null;
        this.emptyText = '';
        // Query the current items came from - those aren't filtered again locally
        this.itemsQuery = '';
        this.activeIndex = -1;

        const id = $root.attr('id');
        this.$trigger = $('<button type="button" class="pz_dropdown_trigger" aria-haspopup="listbox" aria-expanded="false"></button>')
            .attr('id', `${id}_trigger`).appendTo($root);
        this.$value = $('<span class="pz_dropdown_value"></span>').appendTo(this.$trigger);
        $('<i class="material-symbols-rounded">expand_more</i>').appendTo(this.$trigger);
        this.$panel = $('<div class="pz_dropdown_panel"></div>').appendTo($root);
        if (searchPlaceholder) {
            this.$search = $('<input type="search" class="pz_dropdown_search" autocomplete="off">')
                .attr('placeholder', searchPlaceholder).appendTo(this.$panel);
        }
        this.$list = $('<div class="pz_dropdown_list" role="listbox"></div>').appendTo(this.$panel);

        this.$trigger.on('click', () => (this.isOpen() ? this.close() : this.open()));
        this.$trigger.on('keydown', (e) => {
            if (!this.isOpen() && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
                e.preventDefault();
                this.open();
            }
        });
        this.$panel.on('keydown', (e) => this.handleKey(e));
        this.$list.on('click', '.pz_dropdown_option', (e) => this.pick(Number($(e.currentTarget).attr('data-index'))));
        this.$list.on('mousemove', '.pz_dropdown_option', (e) => this.setActive(Number($(e.currentTarget).attr('data-index')), false));

        let searchTimeout = null;
        this.$search?.on('input', () => {
            this.renderList();
            if (!this.onSearch) return;
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.onSearch(this.query()), 300);
        });

        // Click anywhere else closes it
        $(document).on('mousedown', (e) => {
            if (this.isOpen() && !$.contains(this.$root[0], e.target)) this.close();
        });
        this.renderTrigger();
    }

    query() {
        return (this.$search?.val() || '').trim();
    }

    isOpen() {
        return this.$root.hasClass('open');
    }

    open() {
        if (this.$trigger.prop('disabled')) return;
        this.$root.addClass('open');
        this.$trigger.attr('aria-expanded', 'true');
        this.renderList();
        if (this.$search) this.$search.trigger('focus').trigger('select');
        else this.$list.attr('tabindex', '-1').trigger('focus');
        this.scrollToActive();
    }

    close(focusTrigger = false) {
        this.$root.removeClass('open');
        this.$trigger.attr('aria-expanded', 'false');
        if (focusTrigger) this.$trigger.trigger('focus');
    }

    setDisabled(disabled) {
        this.$trigger.prop('disabled', disabled);
        if (disabled) this.close();
    }

    /** New items, e.g. from a server search for `query`. */
    setItems(items, { emptyText = 'Nothing found', query = '' } = {}) {
        this.items = items;
        this.emptyText = emptyText;
        this.itemsQuery = query;
        this.renderTrigger();
        if (this.isOpen()) this.renderList();
    }

    setValue(value) {
        this.value = value ?? null;
        this.renderTrigger();
    }

    selectedItem() {
        return this.items.find((item) => item.value === this.value) || null;
    }

    renderTrigger() {
        // Remembered so a search whose results don't contain the selection still shows it
        const found = this.selectedItem();
        if (found) this.lastSelected = found;
        const item = found || (this.value !== null && this.lastSelected?.value === this.value ? this.lastSelected : null);
        this.$value.text(item ? (item.display || item.label) : this.placeholder).toggleClass('placeholder', !item);
        this.$trigger.attr('title', item ? (item.display || item.label) : '');
    }

    /** Items shown for the current search text. */
    visibleItems() {
        const query = this.query().toLowerCase();
        if (!query || query === this.itemsQuery.toLowerCase()) return this.items;
        const words = query.split(/\s+/);
        return this.items.filter((item) => {
            const text = `${item.label} ${item.sublabel || ''} ${item.group || ''}`.toLowerCase();
            return words.every((word) => text.includes(word));
        });
    }

    renderList() {
        this.visible = this.visibleItems();
        this.$list.empty();
        if (!this.visible.length) {
            $('<p class="pz_hint"></p>').text(this.query() && this.onSearch && this.query() !== this.itemsQuery ? 'Searching…' : this.emptyText).appendTo(this.$list);
            this.activeIndex = -1;
            return;
        }
        let group = null;
        this.visible.forEach((item, index) => {
            if (item.group && item.group !== group) {
                group = item.group;
                $('<div class="pz_dropdown_group"></div>').text(group).appendTo(this.$list);
            }
            const $option = $('<div class="pz_dropdown_option" role="option"></div>')
                .attr('data-index', index)
                .attr('aria-selected', item.value === this.value)
                .toggleClass('selected', item.value === this.value)
                .toggleClass('grouped', !!item.group)
                .appendTo(this.$list);
            $('<span class="pz_dropdown_label"></span>').text(item.label).appendTo($option);
            if (item.sublabel) $('<span class="pz_dropdown_sublabel"></span>').text(item.sublabel).appendTo($option);
        });
        const selectedIndex = this.visible.findIndex((item) => item.value === this.value);
        this.setActive(selectedIndex >= 0 ? selectedIndex : 0, false);
    }

    setActive(index, scroll = true) {
        this.activeIndex = index;
        this.$list.find('.pz_dropdown_option').each((_, el) => {
            $(el).toggleClass('active', Number(el.getAttribute('data-index')) === index);
        });
        if (scroll) this.scrollToActive();
    }

    scrollToActive() {
        const el = this.$list.find('.pz_dropdown_option.active')[0];
        el?.scrollIntoView({ block: 'nearest' });
    }

    handleKey(e) {
        const count = this.visible?.length || 0;
        if (e.key === 'Escape') {
            e.preventDefault();
            this.close(true);
        } else if (e.key === 'ArrowDown' && count) {
            e.preventDefault();
            this.setActive(Math.min(count - 1, this.activeIndex + 1));
        } else if (e.key === 'ArrowUp' && count) {
            e.preventDefault();
            this.setActive(Math.max(0, this.activeIndex - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (this.activeIndex >= 0) this.pick(this.activeIndex);
        } else if (e.key === 'Tab') {
            this.close();
        }
    }

    pick(index) {
        const item = this.visible?.[index];
        if (!item) return;
        this.close(true);
        if (item.value === this.value) return;
        this.setValue(item.value);
        this.onChange(item);
    }
}

/**
 * Event / phase / game picker in the "Playerzone" container of input.html.
 * Calls onPick(gameId) for a picked game or an entered game id; a picked game
 * collapses the game list once onPick() resolves to true.
 */
export class PlayerzonePicker {
    constructor($root, onPick) {
        this.$root = $root;
        this.onPick = onPick;
        this.$gamesSection = $root.find('.pz_games_section');
        this.$gamesToggle = $root.find('.pz_games_toggle');
        this.$gamesCount = $root.find('.pz_games_count');
        this.$games = $root.find('.pz_games');
        this.$gameId = $root.find('#pz_game_id');
        this.events = [];
        this.linkedGameId = null;
        this.selection = loadSelection();
        // Guards against responses arriving out of order
        this.eventsRequest = 0;
        this.gamesRequest = 0;

        this.eventDropdown = new PlayerzoneDropdown($root.find('#pz_event'), {
            placeholder: 'Loading…',
            searchPlaceholder: 'Search tournaments…',
            onSearch: (query) => this.loadEvents(query),
            onChange: (item) => {
                // The event itself is kept too, so it stays selectable once it's outside the PZ's default window
                this.selection = { eventId: item.value, phaseId: null, event: this.events.find((e) => e.id === item.value) || null };
                saveSelection(this.selection);
                this.renderPhases();
            },
        });
        this.phaseDropdown = new PlayerzoneDropdown($root.find('#pz_phase'), {
            placeholder: 'Select a tournament first',
            onChange: (item) => {
                this.selection.phaseId = item.value;
                saveSelection(this.selection);
                this.setGamesCollapsed(false);
                this.loadGames();
            },
        });

        let collapsed = false;
        try {
            collapsed = localStorage.getItem(GAMES_COLLAPSED_KEY) === '1';
        } catch { /* default: expanded */ }
        this.setGamesCollapsed(collapsed, false);
        this.$gamesToggle.on('click', () => this.setGamesCollapsed(!this.$gamesSection.hasClass('collapsed')));
        $root.find('#pz_reload').on('click', () => this.loadGames());
        this.$loadId = $root.find('#pz_load_id');
        this.$loadId.on('click', () => this.pickEnteredId());
        this.$gameId.on('keydown', (e) => {
            if (e.key === 'Enter') this.pickEnteredId();
        });
        this.$games.on('click', 'button[data-game-id]', async (e) => {
            const $button = $(e.currentTarget);
            if (await this.pick(Number($button.attr('data-game-id')), $button)) this.setGamesCollapsed(true);
        });
    }

    /** Loads the event list once the user is signed in. */
    start() {
        if (this.started) return;
        this.started = true;
        this.loadEvents();
    }

    setGamesCollapsed(collapsed, remember = true) {
        this.$gamesSection.toggleClass('collapsed', collapsed);
        this.$gamesToggle.attr('aria-expanded', String(!collapsed));
        if (remember) {
            try {
                localStorage.setItem(GAMES_COLLAPSED_KEY, collapsed ? '1' : '0');
            } catch { /* not remembered */ }
        }
    }

    /** Loads a game via onPick() with a spinner on $button meanwhile - one at a time. */
    async pick(gameId, $button) {
        if (this.picking) return false;
        this.picking = true;
        $button.addClass('loading');
        try {
            return await this.onPick(gameId);
        } finally {
            $button.removeClass('loading');
            this.picking = false;
        }
    }

    async pickEnteredId() {
        const id = this.$gameId.val().trim();
        if (!/^\d+$/.test(id)) {
            this.$gameId.trigger('focus');
            return;
        }
        if (await this.pick(Number(id), this.$loadId)) this.$gameId.val('');
    }

    /** Highlight the game currently linked to the selected court. */
    setLinkedGame(gameId) {
        this.linkedGameId = gameId ? Number(gameId) : null;
        this.$games.find('[data-game-id]').each((_, el) => {
            $(el).toggleClass('linked', Number(el.getAttribute('data-game-id')) === this.linkedGameId);
        });
    }

    async loadEvents(query = '') {
        const request = ++this.eventsRequest;
        try {
            let events = await fetchEvents(query);
            // Keep the selected event selectable even if it's outside the default window
            if (!query && this.selection.eventId && !events.some((e) => e.id === this.selection.eventId)) {
                const remembered = this.events.find((e) => e.id === this.selection.eventId) || this.selection.event;
                if (remembered?.id === this.selection.eventId) events = [remembered, ...events];
            }
            if (request !== this.eventsRequest) return;
            this.renderEvents(events, query);
        } catch (err) {
            if (request !== this.eventsRequest) return;
            this.renderEvents([], query, err.message);
        }
    }

    renderEvents(events, query, error) {
        // Search results replace the list, but the selected event has to stay known
        const selected = this.events.find((e) => e.id === this.selection.eventId) || this.selection.event;
        this.events = events;
        if (selected && !events.some((e) => e.id === selected.id)) this.events = [...events, selected];

        this.eventDropdown.placeholder = 'Select tournament…';
        this.eventDropdown.setItems(events.map((event) => {
            const date = event.date ? new Date(event.date).toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
            return { value: event.id, label: event.name, sublabel: date };
        }), { query, emptyText: error || (query ? 'No tournaments found' : 'No tournaments in the next days - search above') });

        // Only the initial load / default list (re)applies the remembered selection
        if (!query) {
            const isKnown = this.events.some((e) => e.id === this.selection.eventId);
            this.eventDropdown.setValue(isKnown ? this.selection.eventId : null);
            if (this.renderedEventId !== this.eventDropdown.value) this.renderPhases();
        }
    }

    renderPhases() {
        const event = this.events.find((e) => e.id === this.selection.eventId);
        this.renderedEventId = event ? event.id : null;
        this.phaseDropdown.setDisabled(!event);
        if (!event) {
            this.phaseDropdown.placeholder = 'Select a tournament first';
            this.phaseDropdown.setItems([]);
            this.phaseDropdown.setValue(null);
            this.renderGames(null);
            return;
        }

        const items = event.divisions.flatMap((division) => division.phases.map((phase) => ({
            value: phase.id,
            label: phase.name,
            group: division.title,
            display: `${division.title} · ${phase.name}`,
        })));
        this.phaseDropdown.placeholder = items.length ? 'Select division / phase…' : 'No public phases';
        this.phaseDropdown.setDisabled(!items.length);
        this.phaseDropdown.setItems(items);
        // Single phase in the whole event: preselect it
        const phaseId = items.some((p) => p.value === this.selection.phaseId)
            ? this.selection.phaseId
            : (items.length === 1 ? items[0].value : null);
        this.selection.phaseId = phaseId;
        this.phaseDropdown.setValue(phaseId);
        this.loadGames();
    }

    async loadGames() {
        const phaseId = this.phaseDropdown.value;
        const request = ++this.gamesRequest;
        if (!phaseId) {
            this.renderGames(null);
            return;
        }
        this.$games.addClass('loading');
        try {
            const body = await fetchPhaseGames(phaseId);
            if (request === this.gamesRequest) this.renderGames(body.games || []);
        } catch (err) {
            if (request === this.gamesRequest) this.renderGames([], err.message);
        } finally {
            if (request === this.gamesRequest) this.$games.removeClass('loading');
        }
    }

    gameButton(game, label) {
        const $button = $('<button type="button" class="pz_game"></button>')
            .attr('data-game-id', game.id)
            .toggleClass('done', !!game.complete_result)
            .toggleClass('linked', game.id === this.linkedGameId);
        $('<span class="pz_game_meta"></span>').text(label).appendTo($button);
        $('<span class="pz_game_teams"></span>').text(`${game.team1} – ${game.team2}`).appendTo($button);
        if (game.complete_result) $('<i class="material-symbols-rounded" title="Finished">check</i>').appendTo($button);
        $('<span class="pz_spinner" aria-hidden="true"></span>').appendTo($button);
        return $button;
    }

    renderGames(games, error) {
        this.$games.empty();
        this.$gamesSection.toggleClass('hidden', games === null);
        if (games === null) return;
        const open = (games || []).filter((g) => !g.complete_result).length;
        this.$gamesCount.text(games.length ? `${open} open · ${games.length - open} finished` : '');
        if (error || !games.length) {
            $('<p class="pz_hint"></p>').text(error || 'No games with known teams in this phase').appendTo(this.$games);
            return;
        }

        // Finished games go to the end, otherwise keep the PZ's order (by time)
        const sorted = [...games].sort((a, b) => Number(!!a.complete_result) - Number(!!b.complete_result));
        sorted.forEach((game) => {
            const meta = [game.label, formatTime(game.date)].filter(Boolean).join(' · ');
            if (!game.is_liga_game) {
                this.$games.append(this.gameButton(game, meta));
                return;
            }
            // Liga games can't be imported themselves, only their subgames
            const $details = $('<details class="pz_liga"></details>').toggleClass('done', !!game.complete_result);
            const $summary = $('<summary></summary>').appendTo($details);
            $('<span class="pz_game_meta"></span>').text(meta).appendTo($summary);
            $('<span class="pz_game_teams"></span>').text(`${game.team1} – ${game.team2}`).appendTo($summary);
            $('<i class="material-symbols-rounded pz_liga_chevron">expand_more</i>').appendTo($summary);
            const subgames = game.subgames || [];
            if (subgames.some((s) => s.id === this.linkedGameId)) $details.attr('open', '');
            if (!subgames.length) $('<p class="pz_hint"></p>').text('Lineups not confirmed yet').appendTo($details);
            subgames.forEach((subgame) => $details.append(this.gameButton(subgame, subgame.title)));
            this.$games.append($details);
        });
    }
}
