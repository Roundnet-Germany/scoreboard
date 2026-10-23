import { themes, DEFAULT_BRAND_LOGO, subscribeToMatch, getPathsAndValues, getColorBrightness, rgb2hex, writeData, readData, serverTimestamp, writeTimerState, copyToClipboard, changeEventHistory, normalizeEventHistory } from "./main.js?v=4";
import { showToast } from "./toast.js?v=4";
import { PlayerzonePicker, fetchGame, syncToPlayerzone, sendSyncBeacon } from "./playerzone.js?v=4";

// Mutually exclusive "team indicator" settings, see the Team Indicator handler
const TEAM_INDICATOR_MODES = ['show_color', 'show_flag', 'show_club_logo', 'show_team_logo'];
import { resolveFlag, getCountryList } from "./flags.js?v=4";
import { historyScore, reconcileScore, recordSquadScore, cleanScoreEvents } from "./scoreHistory.js?v=4";
// Timer durations and the set-mode convention are shared with the live overview
import { TIMER_DURATIONS_MS, TIMER_LABELS, setModeToFormat, serveInfo } from "./matchStatus.js?v=4";
import { squadScoreFromResults } from "./squadGroups.js?v=4";
import { AutoSquadScore } from "./autoSquadScore.js?v=4";

/** Settings a spectator picks for themselves (setViewerSettings()) instead of taking the court's. */
const VIEWER_SETTINGS = ['show_score_history', 'show_score_history_chart', 'show_match_statistics', 'show_match_preview', 'match_stats_type'];

/** A typed score that jumps by more than one point waits this long for the next keystroke. */
const SCORE_TYPING_DELAY_MS = 700;

/** Text-like fields upload after a short pause in typing instead of on every keystroke. */
const TEXT_UPLOAD_DELAY_MS = 300;
const isTextField = ($elem) => $elem.is('textarea, input:not([type]), input[type="text"], input[type="url"], input[type="color"]');


/* ==============================================================================
* Scoreboard class manages the live scoreboard functionality for both input and output modes.
* Handles real-time data synchronization, UI updates, event history, and theme management.
* ============================================================================== */
export class Scoreboard {
    /**
     * @param {string} type - 'input' for admin interface, 'output' for display
     * @param {jQuery} $html_frame - Main scoreboard container
     * @param {number} channel - Channel number for data synchronization
     * @param {string} theme - Theme identifier for styling
     * @param {User|null} user - Authenticated user object (required for input mode)
    */  
    constructor(type = 'input', $html_frame = $('.scoreboard'), channel, theme = 'rg', user = null) {
        this.type = type;
        this.user = user;
        
        // Frontend elements - using const for immutable references
        this.$html_frame = $html_frame;
        this.$themeInput = $('#theme');
        this.$channelInput = $('#channel');
        this.$scoreChangeButtons = $('.button[team][change]');
        this.$setChangeButtons = $('.set_controls_container .button');
        // Only inputs bound to match data - the Playerzone picker's own fields must not upload
        this.$scoreboardInputs = this.$html_frame.find($('input:not([type=submit])[fb-data], textarea[fb-data]'));
        this.$setCounter = $('#Set_Count');
        this.$winPoints = $('#win_points');
        this.$hardcap = $('#Hardcap');
        this.$resetScoresButton = $('#reset_scores');
        this.$startTimeoutButton = $('#start_timeout');
        this.$startMedicalButton = $('#start_medical');
        this.$cancelTimerButton = $('#cancel_timer');
        this.$timerStatus = $('.timer_status');
        this.$timerWidget = $('.timer_widget');
        // Not the score history inside the statistics: updateScoreHistory() shows
        // its sets by the statistics type - toggled here by the active set as well,
        // it showed other sets for a moment while the statistics faded out
        this.$sets = $('.set').not('.score_history_in_stats .set');
        this.$setScoreCounterA = $('.a_sets_won');
        this.$setScoreCounterB = $('.b_sets_won');
        this.$activeScoreCounterA = $('.a_score_active');
        this.$activeScoreCounterB = $('.b_score_active');
        this.$settingsEntries = $('.setting_entry.boolean input');
        this.$urlOutputContainer = $('.url_output_container');
        this.$urlOutput = $('.url_output');
        this.$logoutButton = $('#logout');
        this.$scoreHistoryContainer = $('.score_history');
        this.$matchStatisticsContainer = $('.match_statistics');
        this.$matchPreviewContainer = $('.match_preview');
        this.$lockIcons = $('.lock-icon');
        this.$toggleSwitches = $('.toggle-switch input[type="checkbox"]')
        
        // Stored variables
        this.channel = Number(channel);
        this.theme = theme;
        this.settings = {
            "show_player_names": 1,
            "show_color": 1,
            "show_flag": 0,
            "show_club_logo": 0,
            "show_team_logo": 0,
            "show_group_score": 0,
            "show_serve_indicator": 0,
            "show_score_history": 0,
            "show_score_history_chart": 0,
            "show_match_statistics": 0,
            "show_match_preview": 0,
            "match_stats_type": "match",
            // "manual" (typed in) or "auto" (counted from the linked squad subgames, see AutoSquadScore)
            "group_score_mode": "manual",
        };
        // Raw teams_info.team_x.name/flag as last received from Firebase -
        // kept independently of the DOM so applyFlag() can fall back to
        // resolveFlag(name) whenever an explicit flag code isn't set,
        // regardless of which of the two paths arrives first on a given update.
        this.teamNames = { a: '', b: '' };
        this.teamFlags = { a: '', b: '' };
        // teams_info.team_x.player_1/2_club_logo and teams_info.team_x.logo,
        // for the club logo / team logo indicators (see applyLogos())
        this.teamClubLogos = { a: ['', ''], b: ['', ''] };
        this.teamLogos = { a: '', b: '' };
        this.active_set = 1;
        // { type: "timeout"|"medical"|"break", startedAt: <epoch ms> } | null -
        // mirrors match-<channel>/timer, see processDataAndUpdateFields().
        this.timerState = null;
        this.scoreChart = null;
        this.event_history = [];
        // Unsubscribe function of the active Firebase listener (subscribeToChannel())
        this.unsubscribeMatch = null;
        // requestRender() batches several changes into one updateUI()
        this.renderScheduled = false;
        // Only runs while a timer is active (see syncTimerTicker())
        this.timer_interval = null;
        // Pending show/hide timeouts of the overlays, see toggleOverlay()
        this.overlayTimeouts = new Map();
        // match-<channel>/playerzone = { game_id, main_game_id, event_id } of the selected court, or null
        this.playerzoneLink = null;
        // match-<channel>/active_set as last seen from Firebase - a write that
        // raises it ends a set (see uploadData())
        this.remoteActiveSet = null;
        // Input only: game picker of the "Playerzone" container (see playerzone.js)
        this.playerzonePicker = null;
        // Input only: watches the subgames of the linked squad game while the squad score is automatic
        this.autoSquad = null;
        // Live data as last applied to the page, per flattened path - an
        // update only touches the fields whose value actually changed
        // (processDataAndUpdateFields()). Cleared on a channel switch.
        this.lastAppliedValues = new Map();
        // [fb-data] elements by path, collected once (fieldElements())
        this.fieldElementsByPath = null;
        // Text fields waiting for their debounced upload: element -> timeout
        this.pendingUploads = new Map();
        // Flag sizes are measured from the layout - only redone when that may have changed
        this.layoutDirty = true;
        
        // Game settings
        this.gameSettings = {
            "win_points": 15, // Standard winning score
            "min_win_margin": 2, // Minimum points difference to win
            "set_mode": "3", // Set mode (e.g., "3", "5", "Best of 3")
            "hardcap": 21
        };
        
        // Init function
        this.init();
    }


    /* ==============================================================================
     * Initialize the scoreboard with event listeners and data synchronization
     * Renders on demand instead of on a fixed tick (requestRender()): on new
     * data from Firebase, on local input, on resize and once fonts have loaded
     * (the flag sizes depend on the font metrics).
     * Input: Daten-Listener erst nach Login (startDataSync()), um Permission denied zu vermeiden
     * ============================================================================== */
    init() {
        this.initEventListeners();
        this.populateFlagSelects();

        const relayout = () => {
            this.layoutDirty = true;
            this.requestRender();
        };
        $(window).on('resize', relayout);
        if (document.fonts) {
            document.fonts.ready.then(relayout);
            document.fonts.addEventListener('loadingdone', relayout);
        }

        if (this.type === 'input') {
            this.playerzonePicker = new PlayerzonePicker($('.container.playerzone'), (gameId) => this.loadPlayerzoneGame(gameId));
            this.autoSquad = new AutoSquadScore((update) => this.applyAutoSquadScore(update));
            // Closing the tab: best-effort interim result for the linked game
            window.addEventListener('pagehide', () => {
                this.flushPendingUploads();
                if (this.playerzoneLink?.game_id && this.canWriteChannel()) sendSyncBeacon(this.playerzoneLink.game_id);
            });
            // Render local input (scores, selects, toggles, ...) right away -
            // including input that doesn't upload anything (yet), e.g. before login.
            $(document).on('input change', () => this.requestRender());
            // Input: Daten-Listener erst nach Login starten (main.js ruft startDataSync() auf)
        } else {
            // Output: listen to the channel live right away
            this.subscribeToChannel();
            // No match to show (invalid ?org=&court= link): nothing to wait for
            if (!this.channel) this.markLoaded('data');
            // Whatever is missing by then, show the page anyway
            setTimeout(() => $('html').removeClass('is-loading'), 6000);
        }

        // Set theme for output type
        if (this.type === 'output') {
            this.setTheme(this.theme);
        }

        this.requestRender();
    }

    /**
     * Startet den Daten-Listener für Input-Modus (nach erfolgreichem Login).
     * Wird von main.js aufgerufen, sobald der User eingeloggt ist.
     */
    startDataSync() {
        if (this.type !== 'input' || this.unsubscribeMatch !== null) return;
        if (window.AUTH_DEBUG) console.log("[Scoreboard] startDataSync aufgerufen");
        this.subscribeToChannel();
    }

    /**
     * (Re-)subscribe the Firebase listener to the current channel. Replaces the
     * old polling via get() every 500ms/2s: Firebase now reports changes itself
     * as soon as they happen.
     */
    subscribeToChannel() {
        if (this.unsubscribeMatch) this.unsubscribeMatch();
        this.unsubscribeMatch = null;
        // The new channel's data has to be applied in full
        this.lastAppliedValues.clear();
        // Input: dimmed with a spinner until this channel's data is in
        if (this.type === 'input' && this.channel) this.setInputLoading(true);
        this.layoutDirty = true;
        const channel = this.channel;
        if (!channel) return;
        this.unsubscribeMatch = subscribeToMatch(channel, (data) => {
            // Ignore late events from a previous channel
            if (channel !== this.channel) return;
            this.processDataAndUpdateFields(data);
            if (this.type === 'input') {
                this.remoteActiveSet = Number(data?.active_set) || null;
                this.updatePlayerzoneLink(data);
                this.updateAutoSquadScore();
            }
            this.sanitizeStartingSelections();
            this.requestRender();
            // Shown once this first data is rendered
            if (this.type === 'output') queueMicrotask(() => this.markLoaded('data'));
            else queueMicrotask(() => this.setInputLoading(false));
        });
    }

    /**
     * Input page: loading state (html.is-loading - spinner next to the title,
     * content dimmed and locked, see style_input.css). Lifted after 8s at the
     * latest, so a slow or failing connection never locks the panel for good.
     */
    setInputLoading(loading) {
        clearTimeout(this.inputLoadingTimeout);
        $('html').toggleClass('is-loading', loading);
        if (loading) this.inputLoadingTimeout = setTimeout(() => this.setInputLoading(false), 8000);
    }

    /**
     * Output page: reveals it (removes html.is-loading, see display.html) once
     * both the theme's stylesheet and the first match data are in.
     */
    markLoaded(part) {
        this.loaded = this.loaded || new Set();
        this.loaded.add(part);
        if (this.loaded.has('theme') && this.loaded.has('data')) $('html').removeClass('is-loading');
    }

    /**
     * Schedules an updateUI() right after the current task. Several calls
     * before that (e.g. a Firebase event and an input event at the same time)
     * result in a single render pass. Deliberately not requestAnimationFrame:
     * that pauses as soon as the browser considers the page invisible (covered
     * window in an OBS window capture, inactive browser source), and the
     * scoreboard would freeze.
     */
    requestRender() {
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        queueMicrotask(() => {
            this.renderScheduled = false;
            this.updateUI();
        });
    }


    /* ==============================================================================
     * Update all UI components in a single pass for performance
     * ============================================================================== */
    updateUI() {
        this.updateSets();
        this.updateSetScore();
        this.updateActiveScore();
        this.updateIndicators();
        this.updateSettings();
        this.updateTimerDisplay();
        this.updateCurrentPlayersDisplay();
        this.syncTimerTicker();
        
        // Only update score history for output type
        if (this.type === 'output') {
            this.updateScoreHistory();
            this.updateScoreHistoryChart();
            this.updateMatchStatistics();
            this.updateTeamRGX();
        }

        // Pages building on the board (spectator.js) catch up after each render
        this.onRender?.();
    }


    /** ==============================================================================     
     * Apply theme styling and HTML structure based on theme configuration
     * ============================================================================== */
    setTheme(theme) {
        // Displays without a (known) theme show the spectator board - also old
        // ?theme=full links, the theme it replaced
        if (!(theme in themes)) {
            theme = this.type === 'output' ? 'spectator' : 'rg';
            this.theme = theme;
        }

        const html_structure = themes[theme].html_structure;
        const css_path = themes[theme].css_path;
        // Spectator view: overlays opened by the viewer, not the court's settings (see setViewerSettings())
        this.isSpectator = this.type === 'output' && !!themes[theme].spectator;
        $('html').attr('data-theme', theme);
        const extensionIndex = css_path.lastIndexOf('.');
        const css_path_input = css_path.slice(0, extensionIndex) + "_input" + css_path.slice(extensionIndex);

        // Only swap the theme-specific stylesheet(s) - base.css and
        // style-output.css are already correctly loaded from the page's own
        // <head> and never change between themes, so they're left alone.
        // This used to remove every stylesheet <link> (including those two)
        // and re-add them via '../css/...' - a relative path inconsistent
        // with css_path's own 'css/...' (no '../'), which 404s depending on
        // how the page is actually served, and even when it doesn't 404,
        // forces a re-fetch of CSS that was already loaded, briefly leaving
        // the page unstyled (raw HTML, in normal flow, no opacity:0/
        // position:fixed on .overlay) while the new links load.
        // The 'css/style-v' half of the selector is what clears the theme link
        // that display.html ships in its own <head>; [theme-stylesheet] catches
        // the ones this method appended on an earlier call, whatever they're
        // named (style-irf.css doesn't match the 'style-v' pattern, and
        // without this a theme switch would leave the old sheet behind).
        $('link[rel="stylesheet"][href*="css/style-v"], link[theme-stylesheet]').remove();
        // Once the sheet is in, layout and fonts change - re-render so the
        // JS-measured sizes (flags, timer widget position) pick that up.
        // display.html stays hidden (html.is-loading) until the theme's sheet
        // is in, instead of first loading a default theme and then swapping
        $('<link>').attr('rel', 'stylesheet').attr('type', 'text/css').attr('theme-stylesheet', '').attr('href', css_path)
            .on('load', () => {
                this.markLoaded('theme');
                this.layoutDirty = true;
                this.requestRender();
            })
            .on('error', () => this.markLoaded('theme'))
            .appendTo('head');

        // Federation logo in the overlay headers - per-theme, falling back to
        // the RG badge for themes that don't define one.
        $('.brand_logo').attr('src', themes[theme].brand_logo || DEFAULT_BRAND_LOGO);

        // Fixed event mark ahead of the event name, in the cut that suits
        // the ground each copy sits on - the board's strip is dark, the
        // overlay headers are light. Most themes don't have one; for those
        // the attribute is removed rather than set to '', since an empty src
        // makes the browser re-request the page itself.
        const eventLogo = themes[theme].event_logo || {};
        ['dark_bg', 'light_bg'].forEach((ground) => {
            const $el = $(`.event_logo_${ground}`);
            if (eventLogo[ground]) {
                $el.attr('src', eventLogo[ground]);
            } else {
                $el.removeAttr('src');
            }
        });

        if (this.type === 'input') {
            $('<link>').attr('rel', 'stylesheet').attr('type', 'text/css').attr('theme-stylesheet', '').attr('href', css_path_input).appendTo('head');
        } else if (this.type === 'output') {
            // Set corresponding html
            $('.scoreboard').hide();
            $(`.scoreboard[theme="${html_structure}"]`).show();

            // Spectator view: the overlays' placeholder texts (player clubs, RGX, ...)
            // would show as real data wherever a court has none - start them empty.
            // Runs before the first data is applied (the listener answers asynchronously).
            if (this.isSpectator) $('.overlay [fb-data]').not('img, input, select').text('');

            const overlays = html_structure === 'vertical_score' || this.isSpectator;
            $('.score_history').toggleClass('hidden', !overlays);
            $('.match_statistics').toggleClass('hidden', !overlays);
            $('.match_preview').toggleClass('hidden', !overlays);
        }
    }


    /** ==============================================================================  
     * Initialize all event listeners for user interactions
     * Handles score changes, set navigation, settings updates and more
     * ============================================================================== */
    initEventListeners() {
        // Channel input dropdown listener
        this.$channelInput.change((event) => {
            // Text still being typed belongs to the court it was typed on
            this.flushPendingUploads();
            this.channel = Number($(event.target).val());
            this.subscribeToChannel();
            this.requestRender();
        });

        // Playerzone: remove the linked game from the PZ live view
        $('#pz_end_game').click(() => this.endPlayerzoneGame());

        // Starting team dropdown listener
        this.$html_frame.find('.starting_team_selector select').change((event) => {
            const $target = $(event.target);
            const uploadTargets = [$target];

            // If the server was just changed onto the same team as the
            // already-selected receiver, auto-correct the receiver to the
            // opposing team - a same-team combo has no valid serve order
            // and used to freeze score input entirely (see getServingPlayerAtPoint).
            const fbData = $target.attr('fb-data') || '';
            if (fbData.includes('starting_server')) {
                const setMatch = fbData.match(/set_(\d+)/);
                const set = setMatch ? setMatch[1] : null;
                if (set) {
                    const $receiverSel = this.$html_frame.find(`[fb-data="score.set_${set}.starting_receiver"]`).first();
                    const server = $target.val();
                    const receiver = $receiverSel.val();
                    if (server && receiver && $receiverSel.is('select') && this.getPlayerTeam(server) === this.getPlayerTeam(receiver)) {
                        $receiverSel.val(this.getPlayerTeam(server) === 'a' ? 'c' : 'a');
                        uploadTargets.push($receiverSel);
                    }
                }
            }

            this.updateIndicators();
            this.uploadData(uploadTargets);
        });

        // Flag country picker listener (input.html only - see populateFlagSelects())
        this.$html_frame.find('.flag-select').change((event) => {
            const $select = $(event.target);
            const fbData = $select.attr('fb-data') || '';
            const team = fbData.includes('team_a') ? 'a' : fbData.includes('team_b') ? 'b' : null;

            if (team) {
                this.teamFlags[team] = $select.val() || '';
                this.applyFlag(team); // instant preview - harmless if flags mode is currently off, see applyFlag()
            }

            this.uploadData([$select]);
        });

        // Output Theme input dropdown listener
        this.$themeInput.change((event) => {
            this.theme = $(event.target).val();
            this.updateUrlOutput();
        });

        // URL output container click handler
        this.$urlOutputContainer.find('.trailing-icon').click((e) => {
            e.preventDefault();
            const text = this.$urlOutput.attr('href');
            copyToClipboard(text);
            showToast('📋', 'URL copied to clipboard');
        });

        // Initialize lock icons functionality
        this.$lockIcons.off('click').on('click', (e) => {
            e.preventDefault();
            const $icon = $(e.currentTarget);
            const $input = $icon.closest('.input-with-trailing-icon').find('input');
            const fieldId = $input.attr('id');
            
            // Toggle lock state
            if ($icon.hasClass('locked')) {
                $icon.removeClass('locked').text('lock_open');
                console.log(`Unlocked field: ${fieldId}`);
            } else {
                $icon.addClass('locked').text('lock');
                console.log(`Locked field: ${fieldId}`);
            }
        });

        // Score input handler
        // Score fields only - not the "Show Score History" toggles, whose paths contain "score" too.
        // +1/-1 buttons and the number field's arrows (keys or spinner) count
        // right away; typed digits wait for the next keystroke, so typing "15"
        // over a 10 doesn't first record a 1 (see SCORE_TYPING_DELAY_MS).
        // Typing comes as an InputEvent with an inputType, the arrows don't.
        const $scoreFields = this.$scoreboardInputs.filter('[fb-data^="score."][fb-data$="_score"]');
        $scoreFields.on('input', (event) => {
            const $target = $(event.target);
            const elem = event.target;
            clearTimeout(this.pendingUploads.get(elem));
            this.pendingUploads.delete(elem);
            // An emptied field (operator about to type a new number) isn't a score yet
            if ($target.val().trim() === '') return;

            const typed = !!event.originalEvent?.inputType;
            if (event.isTrigger || !typed) {
                this.commitScore($target);
            } else {
                this.pendingUploads.set(elem, setTimeout(() => {
                    this.pendingUploads.delete(elem);
                    this.commitScore($target);
                }, SCORE_TYPING_DELAY_MS));
            }
        });
        // Leaving the field (or Enter) counts a typed score right away - an
        // empty field gets its last score back instead
        $scoreFields.on('change', (event) => {
            const $target = $(event.target);
            const elem = event.target;
            const pending = this.pendingUploads.has(elem);
            clearTimeout(this.pendingUploads.get(elem));
            this.pendingUploads.delete(elem);
            if ($target.val().trim() === '') {
                $target.val(this.recordedScore($target));
                this.requestRender();
            } else if (pending) {
                this.commitScore($target);
            }
        });

        // Non-score input handler
        this.$scoreboardInputs.not('[fb-data*="score"]').on('input', (event) => {
            const $target = $(event.target);
            if (isTextField($target)) this.scheduleUpload($target);
            else this.uploadData([$target]);
        });
        // Leaving a text field saves it right away
        this.$scoreboardInputs.not('[fb-data*="score"]').on('change', (event) => {
            const elem = event.target;
            if (!this.pendingUploads.has(elem)) return;
            clearTimeout(this.pendingUploads.get(elem));
            this.pendingUploads.delete(elem);
            this.uploadData([$(elem)]);
        });

        // Score change buttons handler
        this.$scoreChangeButtons.click((event) => {
            const $scoreButton = $(event.target);
            const $activeSetElem = $('.set.active');
            const team = $scoreButton.attr('team');
            const change = Number($scoreButton.attr('change'));
            const $scoreElem = $activeSetElem.find(`.score[fb-data*="team_${team}"]`);
            const currentScore = Number($scoreElem.val());

            if (currentScore + change >= 0) {
                $scoreElem.val(currentScore + change).trigger('input');
            }
        });

        // Set counter input handler - the counter's value is the new active set
        // (typed, or set by the +1/-1 buttons below before they trigger this)
        this.$setCounter.on('input', () => {
            const value = Number(this.$setCounter.val());
            if (value >= 1 && value <= 7) this.active_set = value;
            this.updateSets();
            const set = this.active_set;
            this.updateEventHistory((list) => list.push({ type: 'set', set }));
        });

        // Set change buttons handler
        this.$setChangeButtons.click((event) => {
            const $setButton = $(event.target);
            const change = Number($setButton.attr('change'));
            const currentSet = Number(this.$setCounter.val());
            const newSet = currentSet + change;

            if (newSet > 0 && newSet <= 7) {
                // Auto-start the shared break timer on a forward set
                // transition, mirroring the LED board's own
                // ScoreActions::apply() "nextset" logic (score_actions.h) -
                // BO1 never, 2-sets always, BO3 only while the match isn't
                // already decided - computed BEFORE active_set advances
                // (getSetScore()/setWinner() below both read it) so the
                // countdown appears here too even on a channel with no
                // physical board attached to independently trigger it.
                if (change > 0) {
                    const format = setModeToFormat(this.gameSettings.set_mode);
                    const winner = this.setWinner(currentSet);
                    const setsA = this.getSetScore('a') + (winner === 'a' ? 1 : 0);
                    const setsB = this.getSetScore('b') + (winner === 'b' ? 1 : 0);
                    const matchOver = setsA >= 2 || setsB >= 2;
                    if (format === 1 || (format === 2 && !matchOver)) {
                        this.startTimer('break');
                    }
                }

                // Set the counter first: trigger('input') also runs the generic
                // input handler, which uploads the counter's current value -
                // a stale one there would be written back and, via the
                // listener, reset active_set.
                this.active_set = newSet;
                this.$setCounter.val(newSet).trigger('input');
                this.updateSets();
                this.uploadData([this.$setCounter]);
            }
        });

        // Settings entries handler
        this.$settingsEntries.click((event) => {
            const $trigger = $(event.target);
            // Controls without their own setting (e.g. the team indicator toggle, handled below)
            if (!$trigger.attr('fb-data')) return;
            const value = $trigger.prop('checked') ? 1 : 0;
            const part = $trigger.attr('fb-data').split('.').pop();
            this.settings[part] = value;
            this.updateSettings();
            this.uploadData([$trigger]);
        });

        // Toggle switch handler
        this.$toggleSwitches.change((event) => {
            const $checkbox = $(event.target);
            const $toggleSwitch = $checkbox.closest('.toggle-switch');
            const value = $checkbox.prop('checked') ? 1 : 0;
            const fbData = $checkbox.attr('fb-data') || '';
            const isAdminSetting = fbData.startsWith('admin_settings.');
            const part = fbData.split('.').pop();
            const uploadTargets = [$checkbox];

            // Update toggle switch appearance
            $toggleSwitch.toggleClass('active', $checkbox.prop('checked'));

            // No setting of its own (team indicator toggle, see below)
            if (!fbData) return;

            if (isAdminSetting) {
                this.settings[part] = value;
                this.updateSettings();
            }

            this.uploadData(uploadTargets);
        });
        
        // Team indicator: select (color / flag / club logo) + toggle. Stored as
        // the show_color / show_flag / show_club_logo / show_team_logo settings, at most
        // one of them on - so the stored settings never disagree with what's shown.
        // Already on 'input': a real click renders in between 'input' and 'change'
        // (requestRender() runs as a microtask), and that render would set the
        // controls back from the not yet updated settings - 'change' then saw the
        // old state and the toggle couldn't be switched. 'change' stays for
        // browsers without 'input' on checkboxes; an unchanged state uploads nothing.
        $('#Team_Indicator_Type, #Show_Team_Indicator').on('input change', () => {
            const mode = $('#Team_Indicator_Type').val();
            const isOn = $('#Show_Team_Indicator').prop('checked');
            const next = TEAM_INDICATOR_MODES.map((key) => (isOn && key === mode ? 1 : 0));
            if (TEAM_INDICATOR_MODES.every((key, i) => Number(this.settings[key] || 0) === next[i])) return;
            const uploadTargets = TEAM_INDICATOR_MODES.map((key, i) => {
                this.settings[key] = next[i];
                return $(`input[fb-data="admin_settings.${key}"]`).prop('checked', next[i] === 1);
            });
            this.updateSettings();
            this.uploadData(uploadTargets);
        });

        // Squad score mode: typed in or counted from the linked subgames
        $('#Squad_Score_Mode').change((event) => {
            this.settings.group_score_mode = $(event.target).val();
            this.uploadData([$(event.target)]);
            this.updateAutoSquadScore();
        });

        // Match stats type selector handler
        $('#Match_Stats_Type').change((event) => {
            const value = $(event.target).val();
            this.settings.match_stats_type = value;
            this.updateSettings();
            this.uploadData([$(event.target)]);
        });

        // Winning score handler
        this.$winPoints.on('input', (event) => {
            const value = Number($(event.target).val());
            this.gameSettings.win_points = value;
        });
        this.$winPoints.add(this.$hardcap).on('input', () => this.warnIfHardcapInvalid());

        // Hardcap score handler
        this.$hardcap.on('input', (event) => {
            const value = Number($(event.target).val());
            this.gameSettings.hardcap = value;
        });

        // Reset scores button handler
        this.$resetScoresButton.click(async () => {
            if (!this.canWriteChannel()) {
                showToast("❌", "You don't have access to this court");
                return;
            }
            // Keep the linked game's score in the PZ before it's gone
            await this.syncLinkedPlayerzoneGame(this.channel);
            this.resetScores();
        });

        // Shared timer buttons - see writeTimerState() in main.js for the
        // RTDB side of this. Fixed durations (TIMER_DURATIONS_MS above)
        // match the LED board's own hardcoded ones, so no duration is sent.
        this.$startTimeoutButton.click(() => this.startTimer('timeout'));
        this.$startMedicalButton.click(() => this.startTimer('medical'));
        this.$cancelTimerButton.click(() => this.cancelTimer());

        // Logout button handler (nutzt User.logout() für Firebase signOut)
        this.$logoutButton.click(() => {
            if (this.user && typeof this.user.logout === 'function') {
                this.user.logout();
            } else {
                localStorage.clear();
                location.reload();
            }
        });
    }


    /* ==============================================================================
     * Reset all scores and the event history, then upload everything
     * ("Reset Scores & New Game", also offered when loading another PZ game)
     * ============================================================================== */
    resetScores() {
        let $elems = $('[fb-data*="score"]:not(select)');
        $elems.val(0);
        this.active_set = 1;
        this.updateSets();
        this.updateEventHistory((list) => {
            list.length = 0;
            list.push({ type: 'reset' });
        });
        this.uploadData();
    }


    /* ==============================================================================
     * Import a game data object (match-<channel> format, e.g. from the Playerzone)
     * into the form fields - locked fields are skipped - and return the
     * elements it touched, for uploadData()
     * @param {Object} data - Data object to import
     * @returns {Array} jQuery elements matching the imported paths
     * ============================================================================== */
    importData(data) {
        this.processDataAndUpdateFields(data, true);

        const updatedElements = [];
        $.each(Object.keys(getPathsAndValues(data)), (_, path) => {
            const $elem = this.fieldElements(path);
            if ($elem.length > 0) {
                updatedElements.push($elem);
            }
        });
        return updatedElements;
    }


    /* ==============================================================================
     * Automatic squad score: while admin_settings.group_score_mode is 'auto' and
     * the court carries a Playerzone subgame, AutoSquadScore watches the other
     * subgames of its main game, and the result is written as this court's
     * score.squad_score - so every display shows it like a typed-in one. The
     * subgame results are kept in match-<channel>/squad_auto as well, so a
     * subgame still counts after "End game" (see squadGroups.js).
     * ============================================================================== */
    autoSquadMainGame() {
        if (this.type !== 'input' || this.settings.group_score_mode !== 'auto' || !this.canWriteChannel()) return null;
        return Number(this.playerzoneLink?.main_game_id) || null;
    }

    /** (Re)starts or stops the watcher and locks the squad score fields while it's set to automatic. */
    updateAutoSquadScore() {
        if (!this.autoSquad) return;
        const mainGameId = this.autoSquadMainGame();
        this.autoSquad.watch(mainGameId ? this.channel : null, mainGameId);
        // Locked as soon as it's automatic - to type it in, switch back to manual
        const auto = this.settings.group_score_mode === 'auto';
        $('#A_Score_Team, #B_Score_Team')
            .prop('readonly', auto)
            .attr('tabindex', auto ? -1 : null)
            .attr('title', !auto ? null : mainGameId
                ? 'Counted automatically from the squad game\'s subgames'
                : 'Automatic - counted once a Playerzone subgame is loaded on this court (switch to manual to type it in)');
    }

    /** Writes the counted squad score (and the known subgame results) if they changed. */
    applyAutoSquadScore({ channel, mainGameId, results, own }) {
        if (channel !== this.channel || mainGameId !== this.autoSquadMainGame()) return;
        const names = { a: own.teams_info?.team_a?.name, b: own.teams_info?.team_b?.name };
        const score = squadScoreFromResults(results, names);
        const current = own.score?.squad_score || {};
        const updates = {};

        if (Number(current.team_a_score) !== score.a || Number(current.team_b_score) !== score.b) {
            updates[`/match-${channel}/score/squad_score/team_a_score`] = score.a;
            updates[`/match-${channel}/score/squad_score/team_b_score`] = score.b;
            this.updateEventHistory((list) => {
                recordSquadScore(list, { team: 'a', score: score.a });
                recordSquadScore(list, { team: 'b', score: score.b });
            });
        }

        // Key order differs between Firebase and here - compare a canonical form
        const canonical = (list) => Object.entries(list || {})
            .map(([gameId, result]) => `${gameId}:${result?.side}:${result?.winner || ''}`).sort().join('|');
        const stored = own.squad_auto;
        if (Number(stored?.main_game_id) !== mainGameId || canonical(stored?.results) !== canonical(results)) {
            updates[`/match-${channel}/squad_auto`] = { main_game_id: mainGameId, results };
        }

        if (Object.keys(updates).length) writeData(updates);
    }

    /** True if the signed-in account may write the selected court. */
    canWriteChannel() {
        return !!(this.user && this.channel && this.user.channels.includes(Number(this.channel)));
    }

    /**
     * Changes the event history: right away on this page, and atomically in
     * Firebase (see changeEventHistory() in main.js) if this account may
     * write the selected court.
     */
    updateEventHistory(mutate) {
        mutate(this.event_history);
        if (this.canWriteChannel()) changeEventHistory(this.channel, mutate);
    }

    /** Score of a score field as last recorded (event history, squad score: last stored value). */
    recordedScore($field) {
        const path = $field.attr('fb-data');
        const { team, set } = this.getScoreElemDetails($field);
        if (!path.includes('squad_score') && team && set) return historyScore(this.event_history, team, set);
        return Number(this.lastAppliedValues.get(path)) || 0;
    }

    /** Records a score field's value: event history first, then the score itself. */
    commitScore($field) {
        if ($field.val().trim() === '') return;
        const { team, set } = this.getScoreElemDetails($field);
        const score = Number($field.val()) || 0;
        if ($field.attr('fb-data').includes('squad_score')) {
            this.updateEventHistory((list) => recordSquadScore(list, { team, score }));
        } else {
            this.updateEventHistory((list) => reconcileScore(list, { team, set, score }));
        }
        this.updateCurrentPlayersDisplay();
        this.uploadData([$field]);
    }

    /** Uploads a text field after a short pause in typing - see TEXT_UPLOAD_DELAY_MS. */
    scheduleUpload($elem) {
        const elem = $elem[0];
        clearTimeout(this.pendingUploads.get(elem));
        this.pendingUploads.set(elem, setTimeout(() => {
            this.pendingUploads.delete(elem);
            this.uploadData([$elem]);
        }, TEXT_UPLOAD_DELAY_MS));
    }

    /** Uploads every field still waiting for its debounced upload (text or typed score), now. */
    flushPendingUploads() {
        if (!this.pendingUploads.size) return;
        const elems = [...this.pendingUploads.keys()];
        this.pendingUploads.forEach((timeout) => clearTimeout(timeout));
        this.pendingUploads.clear();
        const isScore = (elem) => /^score\..*_score$/.test(elem.getAttribute('fb-data') || '');
        elems.filter(isScore).forEach((elem) => this.commitScore($(elem)));
        const others = elems.filter((elem) => !isScore(elem));
        if (others.length) this.uploadData(others.map((elem) => $(elem)));
    }

    /** True if any set on the selected court has points. */
    hasPoints() {
        return this.$html_frame.find('input[fb-data^="score.set_"][fb-data$="_score"]').toArray()
            .some((elem) => Number($(elem).val()) > 0);
    }


    /* ==============================================================================
     * Load a Playerzone game onto the selected court: fetch it, import it
     * like a manual import (locked fields stay) and link it for the PZ live
     * view (match-<channel>/playerzone, live_games/<game_id>)
     * @param {number} gameId - PZ game id (from the picker or pasted)
     * @returns {Promise<boolean>} true once loaded and linked
     * ============================================================================== */
    async loadPlayerzoneGame(gameId) {
        if (!this.canWriteChannel()) {
            showToast("❌", "You don't have access to this court");
            return false;
        }
        const channel = this.channel;

        let data;
        try {
            data = await fetchGame(gameId);
        } catch (err) {
            showToast("❌", err.message);
            return false;
        }
        const { playerzone, ...gameData } = data || {};
        if (!playerzone?.game_id) {
            showToast("❌", "Invalid response from Playerzone");
            return false;
        }
        // Event name like the game description (locked fields stay) - from the
        // picker's event list while the PZ doesn't send it yet
        if (!gameData.tournament_name) {
            const eventName = this.playerzonePicker?.eventName(playerzone.event_id);
            if (eventName) gameData.tournament_name = eventName;
        }

        // Game currently on this court, and wherever the new game is listed as live right now
        let oldGameId, existingEntry;
        try {
            [oldGameId, existingEntry] = await Promise.all([
                readData(`match-${channel}/playerzone/game_id`),
                readData(`live_games/${playerzone.game_id}`),
            ]);
        } catch (err) {
            console.error("[Playerzone] reading the current link failed", err);
            showToast("❌", "Couldn't read the current court data - please try again.");
            return false;
        }
        // The court was switched while loading
        if (channel !== this.channel) return false;

        const isOtherGame = Number(oldGameId) !== Number(playerzone.game_id);
        const reset = isOtherGame && this.hasPoints()
            && confirm('There are still points on this court. Reset the scores for the new game?');

        // Save the previous game's score in the PZ while the court still carries it
        if (isOtherGame && oldGameId) {
            await syncToPlayerzone(oldGameId);
            if (channel !== this.channel) return false;
        }

        const updatedElements = this.importData(gameData);
        if (reset) {
            this.resetScores(); // uploads every field, the imported ones included
        } else if (updatedElements.length > 0) {
            this.uploadData(updatedElements);
        }

        const linked = await this.linkPlayerzoneGame(channel, playerzone, oldGameId, existingEntry);
        const teams = `${gameData.teams_info?.team_a?.name || '?'} – ${gameData.teams_info?.team_b?.name || '?'}`;
        if (linked === 'foreign') {
            showToast("⚠️", `Loaded ${teams} - but it's already live on another organisation's court, so the Playerzone won't show it as live here.`, 8000);
        } else if (linked) {
            showToast("✅", `Loaded ${teams}`, 3000);
        }
        return !!linked;
    }

    /**
     * One multi-path update: match-<channel>/playerzone and live_games/<game_id>
     * for the new game, and the old game's live_games entry removed - but only
     * if it still points at this court (it may be running on another one by now).
     * @returns {Promise<boolean|'foreign'>} true if saved, 'foreign' if saved without
     *          the live_games entry because another org's court holds it
     */
    async linkPlayerzoneGame(channel, playerzone, oldGameId, existingEntry) {
        const gameId = Number(playerzone.game_id);
        const mainGameId = playerzone.main_game_id ?? null;
        const court = this.user.courtForChannel(channel);
        const updates = {
            [`/match-${channel}/playerzone`]: { game_id: gameId, main_game_id: mainGameId, event_id: playerzone.event_id ?? null },
            // Otherwise the PZ would go by the previous game's last change and could hide this one right away
            [`/match-${channel}/updated_at`]: serverTimestamp(),
        };

        // Listed as live on a court of another org: that entry isn't ours to take over
        const foreignChannel = existingEntry && Number(existingEntry.channel) !== channel
            && !this.user.isAdmin && !this.user.channels.includes(Number(existingEntry.channel));
        if (!foreignChannel) {
            updates[`/live_games/${gameId}`] = {
                channel,
                main_game_id: mainGameId,
                org: court?.org ?? null,
                court: court?.court ?? null,
                since: serverTimestamp(),
            };
        }

        if (oldGameId != null && Number(oldGameId) !== gameId) {
            try {
                const oldEntry = await readData(`live_games/${Number(oldGameId)}`);
                if (oldEntry && Number(oldEntry.channel) === channel) updates[`/live_games/${Number(oldGameId)}`] = null;
            } catch (err) {
                console.warn("[Playerzone] reading the old live_games entry failed", err);
            }
        }

        const saved = await writeData(updates);
        return saved && foreignChannel ? 'foreign' : saved;
    }

    /* ==============================================================================
     * "End game": remove the linked game from the PZ live view of this court
     * ============================================================================== */
    async endPlayerzoneGame() {
        if (!this.canWriteChannel()) {
            showToast("❌", "You don't have access to this court");
            return;
        }
        const channel = this.channel;
        // From Firebase rather than this tab's state - the game may have been loaded elsewhere
        const gameId = await this.syncLinkedPlayerzoneGame(channel);
        const updates = { [`/match-${channel}/playerzone`]: null };
        if (gameId) {
            try {
                const entry = await readData(`live_games/${gameId}`);
                if (entry && Number(entry.channel) === channel) updates[`/live_games/${gameId}`] = null;
            } catch (err) {
                console.warn("[Playerzone] reading the live_games entry failed", err);
            }
        }
        if (await writeData(updates)) showToast("✅", "Game ended - no longer shown as live in the Playerzone", 3000);
    }

    /**
     * Store the score of the game linked to a court as interim result in the
     * PZ. The game id is read from Firebase, not this tab's state, so a game
     * loaded in another tab or on another device is saved too.
     * @returns {Promise<number|null>} the linked game id
     */
    async syncLinkedPlayerzoneGame(channel) {
        let gameId = null;
        try {
            gameId = Number(await readData(`match-${channel}/playerzone/game_id`)) || null;
        } catch (err) {
            console.warn("[Playerzone] reading the linked game failed", err);
            gameId = Number(this.playerzoneLink?.game_id) || null;
        }
        if (gameId) await syncToPlayerzone(gameId);
        return gameId;
    }

    /** Shows the PZ game linked to the selected court (from the live match data). */
    updatePlayerzoneLink(data) {
        const link = data?.playerzone?.game_id ? data.playerzone : null;
        this.playerzoneLink = link;
        const $linked = $('.playerzone .pz_linked');
        $linked.toggleClass('hidden', !link);
        if (link) {
            const teamA = data.teams_info?.team_a?.name || 'Team A';
            const teamB = data.teams_info?.team_b?.name || 'Team B';
            $linked.find('.pz_linked_teams').text(`${teamA} – ${teamB}`).attr('title', `${teamA} – ${teamB}`);
            $linked.find('.pz_linked_id').text(`Game ID ${link.game_id}`);
        }
        this.playerzonePicker?.setLinkedGame(link?.game_id);
    }


    /** ============================================================================== 
     * Process data object and update form fields
     * Common function used by both live data insertion and JSON import
     * @param {Object} data - Data object to process
     * @param {boolean} isImport - Whether this is an import operation (affects special handling)
     * ============================================================================== */
    processDataAndUpdateFields(data, isImport = false) {
        // Set directly from `data.timer` rather than through the flattened
        // path loop below: that loop only ever fires for keys actually
        // PRESENT in `data`, so it has no way to represent "the timer node
        // was deleted" (natural expiry/cancel) - only a direct check against
        // its absence can. Skipped for JSON imports, which are one-off
        // partial payloads a user pastes in (almost certainly with no
        // `timer` key at all) - those shouldn't blow away a genuinely active
        // synced timer just because the import didn't mention it.
        if (!isImport) {
            this.timerState = (data && data.timer && data.timer.type)
                ? { type: data.timer.type, startedAt: data.timer.started_at || null }
                : null;
        }

        // event_history is taken as a whole (array, or object once it has gaps) -
        // a court without one has none, rather than keeping the previous court's
        const { event_history: eventHistory, ...fields } = data || {};
        if (!isImport) this.event_history = normalizeEventHistory(eventHistory);

        const pathsAndValues = getPathsAndValues(fields);

        // Process each path and value - live data only where it changed since the last update
        $.each(Object.entries(pathsAndValues), (_, [path, value]) => {
            if (!isImport) {
                const key = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
                if (this.lastAppliedValues.has(path) && this.lastAppliedValues.get(path) === key) return;
                this.lastAppliedValues.set(path, key);
                if (path.startsWith('teams_info') || path.startsWith('admin_settings')) this.layoutDirty = true;
            }
            const $allElements = this.fieldElements(path);

            // Only cached here - the <img>s with this fb-data (player cards)
            // are still filled by the branches below
            const clubLogo = path.match(/^teams_info\.team_([ab])\.player_([12])_club_logo$/);
            const teamLogo = path.match(/^teams_info\.team_([ab])\.logo$/);
            const isLocked = isImport && $allElements.toArray().some((el) => this.isFieldLocked($(el)));
            if (clubLogo && !isLocked) this.teamClubLogos[clubLogo[1]][Number(clubLogo[2]) - 1] = value || '';
            if (teamLogo && !isLocked) this.teamLogos[teamLogo[1]] = value || '';

            // event_history is handled above, before the per-path loop
            if (path.includes('admin_settings')) {
                this.insertAdminSetting(path, value);
            } else if (path.includes('teams_info') && path.includes('color')) {
                this.insertColor($allElements.first(), path, value);
            } else if (path.includes('teams_info') && path.endsWith('.flag')) {
                // Only cache the raw code here - do NOT touch .flag-indicator
                // visibility/src from the data path. That used to make the
                // flag flash visible on every data update regardless of "Show
                // as Flags", since it raced against
                // updateColorIndicatorVisibility() re-hiding it. applyFlag() is
                // now only ever called from there, which is also the sole
                // owner of visibility.
                const team = path.includes('team_a') ? 'a' : path.includes('team_b') ? 'b' : null;
                if (team) this.teamFlags[team] = value || '';
                $allElements.each((_, elem) => {
                    const $elem = $(elem);
                    if (!(isImport && this.isFieldLocked($elem))) this.setElementValue($elem, value);
                });
            } else if (path.includes('teams_info') && path.endsWith('.name')) {
                const team = path.includes('team_a') ? 'a' : path.includes('team_b') ? 'b' : null;
                if (team) this.teamNames[team] = value || '';
                $allElements.each((_, elem) => {
                    const $elem = $(elem);
                    if (!(isImport && this.isFieldLocked($elem))) this.setElementValue($elem, value);
                });
            } else if (path.includes('active_set')) {
                this.active_set = value;
            } else if (path.includes('starting_server') || path.includes('starting_receiver')) {
                $allElements.each((_, elem) => {
                    const $elem = $(elem);
                    if ($elem.is('input') || $elem.is('select')) {
                        $elem.val(value);
                    } else {
                        $elem.text(value);
                    }
                });
            } else if (path.includes('game_settings')) {
                // Handle game settings (winning score, set mode, hardcap, etc.)
                const settingKey = path.split('.').pop();
                
                if (settingKey === 'set_mode') {
                    this.gameSettings[settingKey] = value;
                } else {
                    this.gameSettings[settingKey] = Number(value);
                }

                // Update the UI
                $allElements.each((_, elem) => {
                    const $elem = $(elem);
                    if ($elem.is('input') || $elem.is('select')) {
                        $elem.val(value);
                    } else {
                        $elem.text(value);
                    }
                });
            } else if (path.includes('_is_pro')) {
                let $rgxElem = this.fieldElements(path.replace('_is_pro', '_rgx'));
                $rgxElem.toggleClass('pro', value === 1 || value === true);
                $rgxElem.closest('.rgx').toggleClass('pro', value === 1 || value === true);

                $allElements.each((_, elem) => {
                    const $elem = $(elem);
                    
                    // Check if this is a manual import and the field is locked
                    if (isImport && this.isFieldLocked($elem)) {
                        console.log(`Skipping locked field: ${$elem.attr('id') || $elem.attr('fb-data')}`);
                    } else {
                        this.setElementValue($elem, value);
                    }                   
                });
                
            } else {
                // Handle elements with and without part attributes
                $allElements.each((_, elem) => {
                    const $elem = $(elem);
                    
                    // Check if this is a manual import and the field is locked
                    if (isImport && this.isFieldLocked($elem)) {
                        console.log(`Skipping locked field: ${$elem.attr('id') || $elem.attr('fb-data')}`);
                    } else {
                        this.setElementValue($elem, value);
                    }                   
                });
            }
        });        
    }


    /**
     * The [fb-data] elements for a data path. Collected once into a lookup
     * table: cheaper than an attribute selector per field and update, and a
     * key from the database never ends up inside a selector.
     */
    fieldElements(path) {
        if (!this.fieldElementsByPath) {
            const byPath = new Map();
            $('[fb-data]').each((_, elem) => {
                const key = elem.getAttribute('fb-data');
                if (!byPath.has(key)) byPath.set(key, []);
                byPath.get(key).push(elem);
            });
            this.fieldElementsByPath = new Map([...byPath].map(([key, elems]) => [key, $(elems)]));
        }
        return this.fieldElementsByPath.get(path) || $();
    }

    /** ============================================================================== 
     * Set value on an element based on its type
     * @param {jQuery} $elem - Element to update
     * @param {*} value - Value to set
     * ============================================================================== */
    setElementValue($elem, value) {
        // Check if element has a part attribute for name splitting
        const part = $elem.attr('part');
        if (part && (part === 'prename' || part === 'surname')) {
            // Split the full name at the first space
            const nameParts = String(value).split(' ');
            if (nameParts.length === 1) {
                // Only one name part: set only surname, leave prename empty
                if (part === 'prename') {
                    $elem.text('');
                } else if (part === 'surname') {
                    $elem.text(nameParts[0] || '');
                }
            } else {
                if (part === 'prename') {
                    // Set the first part (everything before the first space)
                    $elem.text(nameParts[0] || '');
                } else if (part === 'surname') {
                    // Set everything after the first space (join remaining parts)
                    $elem.text(nameParts.slice(1).join(' ') || '');
                }
            }
            return;
        }

        if ($elem.is('img')) { // Handle image elements - set src attribute
            $elem.attr('src', value || '');
            return;
        } else if ($elem.is('input[type="checkbox"]')) { // Handle checkboxes
            const isChecked = value === 1 || value === true;
            $elem.prop('checked', isChecked);
            // Ensure toggle-switch visuals reflect state for any checkbox (admin or non-admin)
            const $toggleSwitch = $elem.closest('.toggle-switch');
            if ($toggleSwitch.length > 0) {
                $toggleSwitch.toggleClass('active', isChecked);
            }
        } else if ($elem.is('input[type="color"]')) {
            $elem.val(value);
        } else if ($elem.is('input') || $elem.is('select')) {
            $elem.val(value);
        } else {
            $elem.text(value);
        }        
    }


    /** ============================================================================== 
     * Insert admin setting value into local settings object
     * @param {string} path - Firebase path containing the setting
     * @param {*} value - Setting value to store
     * ============================================================================== */
    async insertAdminSetting(path, value) {
        const part = path.split('.').pop();
        if (this.isSpectator && VIEWER_SETTINGS.includes(part)) return;
        this.settings[part] = value;
        
        // Special handling for match statistics type
        if (part === 'match_stats_type') {
            $('#Match_Stats_Type').val(value);
        }
        if (part === 'group_score_mode') {
            $('#Squad_Score_Mode').val(value === 'auto' ? 'auto' : 'manual');
        }
    }

    /** ==============================================================================
     * Resolve and render a team's flag: prefers an explicit teams_info.team_x.flag
     * ISO2 code (written by the Fwango bridge, or set manually on the input page)
     * and falls back to deriving one from the team name via the same resolveFlag()
     * tiers TournamentLiveScores uses, so both tools show the same flag for the
     * same team. Only paints .flag-indicator elements - visibility (colors vs
     * flags) is handled separately by updateColorIndicatorVisibility().
     *
     * On input.html, a fallback-derived code also gets written back to
     * teams_info.team_x.flag, so it becomes the same kind of explicit fact a
     * manual pick would be - other consumers of that field (display.html, a
     * second admin's browser, TournamentLiveScores/Fwango) then see it
     * directly instead of each re-deriving their own guess from the name,
     * and the country <select> picks it up as its selected option on the
     * next data update instead of sitting on "Auto-detect" forever. Not done on
     * output.html: it has no write auth, so writeData() there would just
     * fail silently against Firebase's own rules (there are none here, so it
     * would actually succeed, but a read-only display page has no business
     * writing match data).
     * @param {string} team - Team identifier ('a' or 'b')
     * ============================================================================== */
    applyFlag(team) {
        const explicit = (this.teamFlags[team] || '').trim();
        const isExplicit = /^[A-Za-z]{2}$/.test(explicit);
        const code = isExplicit ? explicit.toUpperCase() : resolveFlag(this.teamNames[team] || '');
        const $flagElems = $(`.flag-indicator.team_${team}`);

        // Only called from updateColorIndicatorVisibility(), which already
        // confirmed flags should be visible right now - this only decides
        // per-team whether there's actually a flag to show.
        if (code) {
            const src = `https://flagcdn.com/${code.toLowerCase()}.svg`;
            $flagElems.each((_, el) => {
                if (el.getAttribute('src') !== src) {
                    el.setAttribute('src', src);
                    this.layoutDirty = true;
                }
            });
            $flagElems.show();
        } else {
            $flagElems.removeAttr('src').hide();
        }

        if (!isExplicit && code && this.type === 'input' && this.user && this.user.channels.includes(Number(this.channel))) {
            // Set locally right away so the next render already sees an
            // explicit value and doesn't fire the same write again while the
            // round-trip through Firebase is still in flight.
            this.teamFlags[team] = code;
            writeData({ [`/match-${this.channel}/teams_info/team_${team}/flag`]: code });
        }
    }

    /** ==============================================================================
     * Fill every .flag-select (input.html's manual country picker, replacing
     * the old free-text ISO-code field) with an "Auto-detect" option plus
     * every country resolveFlag() can match, sourced from the same table so
     * a manually-picked country always round-trips correctly. No-op when
     * there are no .flag-select elements on the page (output.html).
     * ============================================================================== */
    populateFlagSelects() {
        const $selects = this.$html_frame.find('.flag-select');
        if (!$selects.length) return;

        const countries = getCountryList();
        $selects.each((_, sel) => {
            const $sel = $(sel);
            $sel.append($('<option></option>').val('').text('Auto-detect from name'));
            countries.forEach(({ code, name }) => {
                $sel.append($('<option></option>').val(code).text(`${name} (${code})`));
            });
        });
    }

    /** ==============================================================================
     * Set .flag-indicator-wrap's total height (select + gap + flag, stacked)
     * in px to match its sibling .details column (teamname + player names) -
     * input.html only, no-op elsewhere. The select keeps its natural height;
     * the flag <img> gets whatever's left, so together they exactly fill
     * .details' height. Deliberately measured in JS rather than done with CSS
     * percentage/flex sizing on the image: that made the flag's height and
     * the wrapper's height circularly dependent on each other (the wrapper's
     * hypothetical size, computed before its height is resolved, came from
     * the img's own percentage height resolving to auto -> the img's large
     * intrinsic SVG size -> which then became the "tallest child" the whole
     * row and the wrapper sized against), which is the actual cause of the
     * flags rendering huge. .details and the select never depend on the flag,
     * so measuring them directly and applying explicit heights breaks the cycle.
     * ============================================================================== */
    syncFlagWrapHeights() {
        const gap = 4; // matches .flag-indicator-wrap's CSS gap
        this.$html_frame.find('.teams .team').each((_, teamEl) => {
            const $team = $(teamEl);
            const $details = $team.find('.details').first();
            const $wrap = $team.find('.flag-indicator-wrap').first();
            const $select = $wrap.find('.flag-select').first();
            const $img = $wrap.find('.flag-indicator').first();
            if (!$details.length || !$wrap.length) return;

            const totalHeight = $details.outerHeight();
            $wrap.css('height', totalHeight + 'px');

            if ($select.length && $img.length) {
                const flagHeight = Math.max(0, totalHeight - $select.outerHeight() - gap);
                $img.css('height', flagHeight + 'px');
            }
        });
    }

    /** ==============================================================================
     * Process team color updates with brightness calculations
     * Applies CSS variables and light/dark class adjustments
     * @param {jQuery} $elem - Color input element
     * @param {string} path - Firebase path containing color data
     * @param {string} value - Color value (hex or rgb)
     * ============================================================================== */
    async insertColor($elem, path, value) {
        var color = value;
        var brightness = getColorBrightness(rgb2hex(value));

        // Clip at dark values to prevent complete black
        if (brightness <= 23) {
            color = '#222222';
        }

        // Determine team from path
        const team = path.includes('team_a') ? 'a' : path.includes('team_b') ? 'b' : null;
        if (!team) return;

        if ($elem.is('input')) {
            $elem.val(value);
        } else {
            // Add color to CSS variable
            $('html').css(`--${team.toUpperCase()}_Color`, color);

            const $teamElems = $(`.team.team_${team}`);

            // Simplified brightness logic
            if (brightness >= 230) {
                $elem.addClass('light');
                $teamElems.addClass('light');
            } else if (brightness >= 150) {
                $elem.removeClass('light');
                $teamElems.addClass('light');
            } else {
                $elem.removeClass('light');
                $teamElems.removeClass('light');
            }
        }
    }

    /** ==============================================================================
     * Upload data to Firebase with authentication checks
     * Processes element values and converts them to appropriate database format
     * @param {Array} elemList - List of jQuery elements to upload (optional, uploads all if undefined)
     * ============================================================================== */
    async uploadData(elemList) {
        // Check if selected channel is allowed
        if (!this.user || !this.channel || !this.user.channels.includes(Number(this.channel))) {
            if (this.channel) {
                showToast("❌", "You don't have access to this court");
            }
            return;
        }

        // Upload all if there are no specific elements
        if (typeof elemList === 'undefined') {
            elemList = $("*[fb-data]:not([db-read-only])");
        }

        // Prepare data for upload
        const newData = {};
        const channel = this.channel;
        const previousActiveSet = this.remoteActiveSet;
        // event_history isn't part of this - it's changed atomically on its own (updateEventHistory())
        // The Playerzone hides a live game whose court hasn't changed for a while
        newData[`/match-${this.channel}/updated_at`] = serverTimestamp();

        // Process each element
        $.each(elemList, (_, elem) => {
            const $elem = $(elem);
            const fbDataAttr = $elem.attr("fb-data");
            
            if (!fbDataAttr) return;

            // Get value based on element type
            const value = $elem.is(":checkbox") ? ($elem.is(":checked") ? 1 : 0) : $elem.val();

            // Create database path
            const dbSelector = fbDataAttr.replace(/\./g, '/');
            const pathToVariable = `/match-${this.channel}/${dbSelector}`;

            // Convert to integer for score and active_set paths, but not for starting_team or admin_settings
            let finalValue = value;
            if ((pathToVariable.includes('score') || pathToVariable.includes('active_set')) && 
                !pathToVariable.includes('starting_server') && 
                !pathToVariable.includes('starting_receiver') && 
                !pathToVariable.includes('admin_settings')) {
                finalValue = parseInt(value, 10);
                // An emptied field: leave the stored value alone - NaN would make Firebase reject the whole update
                if (Number.isNaN(finalValue)) return;
            }

            newData[pathToVariable] = finalValue;
        });

        const saved = await writeData(newData);

        // A set just ended (active_set raised): interim result for the linked PZ game
        const activeSet = newData[`/match-${channel}/active_set`];
        if (saved && previousActiveSet && activeSet > previousActiveSet && this.playerzoneLink?.game_id && channel === this.channel) {
            syncToPlayerzone(this.playerzoneLink.game_id);
        }
    }

    /** ==============================================================================
     * Start a shared timeout/medical timer - writes match-<channel>/timer via
     * writeTimerState() (main.js), picked up by the LED board (directly, or
     * via the manager server's Firebase bridge) and this page's own output
     * display alike. No duration is sent - every reader keeps the same
     * fixed durations locally (TIMER_DURATIONS_MS above, matching
     * led_scoreboard's score_actions.h).
     * @param {string} type - 'timeout' or 'medical'
     * ============================================================================== */
    startTimer(type) {
        if (!this.user || !this.channel || !this.user.channels.includes(Number(this.channel))) {
            showToast("❌", "You don't have access to this court");
            return;
        }
        // Set locally right away, same reasoning as applyFlag(): the next UI
        // tick already reflects it instead of waiting on the round trip.
        this.timerState = { type, startedAt: Date.now() };
        writeTimerState(this.channel, type);
    }

    /** ==============================================================================
     * Cancel the currently active shared timer (timeout/medical/break) from
     * either tool - deletes match-<channel>/timer.
     * ============================================================================== */
    cancelTimer() {
        if (!this.user || !this.channel || !this.user.channels.includes(Number(this.channel))) {
            showToast("❌", "You don't have access to this court");
            return;
        }
        this.timerState = null;
        writeTimerState(this.channel, null);
    }

    /** ==============================================================================
     * Render the shared timer, both as input.html's inline status text (next
     * to the Timers buttons) and, for output.html, the .timer_widget card -
     * both driven by this.timerState, which processDataAndUpdateFields()
     * keeps in sync with match-<channel>/timer. Also toggles input.html's
     * Cancel button. Ticks down locally via syncTimerTicker() while a timer
     * is running, then hides itself once time's up. Purely a reader: the RTDB node itself is only ever cleared
     * by whichever board/bridge is authoritative for it (fixed durations
     * mean the board that started/adopted a timer knows exactly when it
     * ends) - this never writes back on natural expiry.
     * ============================================================================== */
    updateTimerDisplay() {
        const state = this.timerState;
        const duration = state && TIMER_DURATIONS_MS[state.type];
        const remainingMs = duration && state.startedAt ? duration - (Date.now() - state.startedAt) : 0;
        const active = !!duration && remainingMs > 0;

        this.$cancelTimerButton.toggleClass('hidden', !active);
        this.$timerStatus.toggleClass('hidden', !active);

        if (!active) {
            this.$timerWidget.removeClass('visible');
            return false;
        }

        const totalSec = Math.ceil(remainingMs / 1000);
        const mm = Math.floor(totalSec / 60);
        const ss = totalSec % 60;
        const timeText = `${mm}:${String(ss).padStart(2, '0')}`;
        const label = TIMER_LABELS[state.type] || state.type;

        this.$timerStatus.text(`${label} ${timeText}`);

        if (this.type !== 'output' || !this.$timerWidget.length) return true;

        // Sit at the same vertical level as, and just to the right of,
        // whichever theme's .board is actually visible right now (setTheme()
        // shows exactly one .wrapper[theme] at a time) - measured fresh each
        // tick so it tracks the board across theme switches/resizes instead
        // of sitting at a fixed viewport position.
        const $board = $('.board:visible').first();
        if ($board.length) {
            const rect = $board[0].getBoundingClientRect();
            this.$timerWidget.css({
                top: (rect.top + rect.height / 2) + 'px',
                left: (rect.right + 24) + 'px',
            });
        }

        this.$timerWidget
            .attr('data-timer-type', state.type)
            .addClass('visible');
        this.$timerWidget.find('.timer_widget_label').text(label);
        this.$timerWidget.find('.timer_widget_time').text(timeText);
        return true;
    }

    /**
     * The countdown has to keep running without new data - so it gets its own
     * small tick that only calls updateTimerDisplay() and only exists while a
     * timer is running. Called from updateUI().
     */
    syncTimerTicker() {
        if (this.timerState && !this.timer_interval) {
            this.timer_interval = setInterval(() => {
                if (!this.updateTimerDisplay()) {
                    clearInterval(this.timer_interval);
                    this.timer_interval = null;
                }
            }, 250);
        }
    }

    /** ==============================================================================
     * Get score history for a specific set, filtering from last reset event
     * @param {number} set - Set number to get history for (defaults to active set)
     * @returns {Array} Filtered array of score events
     * ============================================================================== */
    getScoreHistory(set = this.active_set) {
        // Find the last reset event
        let startIndex = this.getLastResetIndex();

        const slicedEventHistory = this.event_history.slice(startIndex + 1);
        const events = slicedEventHistory.filter(event =>
            event.type === 'score' &&
            event.set == set &&
            event.team &&
            typeof event.team === 'string' &&
            event.score !== undefined
        );
        // Read robustly even if the stored history is off (old data, a board
        // scoring without events): rising scores only, none above the actual one
        // (no limit while a field is empty or missing - NaN, not 0)
        const finalScore = (team) => {
            const $elem = this.getScoreElem(set, team).first();
            const raw = String($elem.is('input') ? $elem.val() : $elem.text()).trim();
            return raw === '' ? NaN : Number(raw);
        };
        return cleanScoreEvents(events, { a: finalScore('a'), b: finalScore('b') });
    }

    /** ==============================================================================
     * Convert score history to team points list for chart visualization
     * Maintains last known score for each team across all events
     * @param {Array} slicedEventHistory - Filtered event history
     * @param {string} team - Team identifier ('a' or 'b')
     * @returns {Array} Array of score values for chart data
     * ============================================================================== */
    scoreHistoryToTeamPoints(slicedEventHistory, team) {
        const teamPointsList = [];
        let lastScore = 0;

        $.each(slicedEventHistory, (i, event) => {
            if (event.type === 'score' && event.team && typeof event.team === 'string') {
                if (event.team.toLowerCase() === team.toLowerCase()) {
                    lastScore = Number(event.score);
                }
                teamPointsList.push(lastScore);
            }
        });

        return teamPointsList;
    }


    /** ==============================================================================
     * Get current data from the scoreboard
     * @returns {Object} Current data object
     * ============================================================================== */
    getCurrentRGXData() {
        const data = {
            teams_info: {
                team_a: {},
                team_b: {}
            }
        };
        
        // Extract team A data
        data.teams_info.team_a.player_1_rgx = $('[fb-data="teams_info.team_a.player_1_rgx"]').first().text();
        data.teams_info.team_a.player_2_rgx = $('[fb-data="teams_info.team_a.player_2_rgx"]').first().text();
        data.teams_info.team_a.player_1_is_pro = $('[fb-data="teams_info.team_a.player_1_rgx"]').first().hasClass('pro');
        data.teams_info.team_a.player_2_is_pro = $('[fb-data="teams_info.team_a.player_2_rgx"]').first().hasClass('pro');
        
        // Extract team B data
        data.teams_info.team_b.player_1_rgx = $('[fb-data="teams_info.team_b.player_1_rgx"]').first().text();
        data.teams_info.team_b.player_2_rgx = $('[fb-data="teams_info.team_b.player_2_rgx"]').first().text();
        data.teams_info.team_b.player_1_is_pro = $('[fb-data="teams_info.team_b.player_1_rgx"]').first().hasClass('pro');
        data.teams_info.team_b.player_2_is_pro = $('[fb-data="teams_info.team_b.player_2_rgx"]').first().hasClass('pro');
        
        return data;
    }


    /** ==============================================================================
     * Calculate and update team RGX values and pro classes
     * This method is called after processing all data to ensure all player RGX and pro values are available
     * ============================================================================== */
    updateTeamRGX() {
        // Get current data to calculate team values
        const data = this.getCurrentRGXData();
        
        if (!data.teams_info) return;

        // Process Team A
        if (data.teams_info.team_a) {
            const teamA = data.teams_info.team_a;
            const player1RGX = parseInt(teamA.player_1_rgx) || 0;
            const player2RGX = parseInt(teamA.player_2_rgx) || 0;
            const player1Pro = teamA.player_1_is_pro === 1 || teamA.player_1_is_pro === true;
            const player2Pro = teamA.player_2_is_pro === 1 || teamA.player_2_is_pro === true;
            
            const teamRGX = player1RGX + player2RGX;
            const isTeamPro = player1Pro && player2Pro;
            
            // Update team RGX display
            $(`[fb-data="teams_info.team_a.team_rgx"]`).each((_, elem) => {
                const $elem = $(elem);
                $elem.text(teamRGX);
                $elem.closest('.rgx').toggleClass('pro', isTeamPro);
            });
        }
        
        // Process Team B
        if (data.teams_info.team_b) {
            const teamB = data.teams_info.team_b;
            const player1RGX = parseInt(teamB.player_1_rgx) || 0;
            const player2RGX = parseInt(teamB.player_2_rgx) || 0;
            const player1Pro = teamB.player_1_is_pro === 1 || teamB.player_1_is_pro === true;
            const player2Pro = teamB.player_2_is_pro === 1 || teamB.player_2_is_pro === true;
            
            const teamRGX = player1RGX + player2RGX;
            const isTeamPro = player1Pro && player2Pro;
            
            // Update team RGX display
            $(`[fb-data="teams_info.team_b.team_rgx"]`).each((_, elem) => {
                const $elem = $(elem);
                $elem.text(teamRGX);
                $elem.closest('.rgx').toggleClass('pro', isTeamPro);
            });
        }
    }


    /** ==============================================================================
     * Get all played sets (sets before the current active set)
     * @returns {Array} Array of jQuery set elements
     * ============================================================================== */
    getPlayedSets() {
        const playedSets = [];
        $.each(this.$sets, (i, set) => {
            if (i + 1 < this.active_set) {
                playedSets.push(set);
            }
        });
        return playedSets;
    }


    /** ==============================================================================
     * Get score element for a specific set and team
     * @param {number} set - Set number (1-7)
     * @param {string} team - Team identifier ('a' or 'b')
     * @returns {jQuery} Score element
     * ============================================================================== */
    getScoreElem(set, team) {
        return $(this.$sets[set - 1]).find(`[fb-data*="score"][fb-data*="team_${team}"]`);
    }


    /** ==============================================================================
     * Extract team and set information from score element
     * @param {jQuery} $score_elem - Score element to analyze
     * @returns {Object|null} Object with team and set properties, or null if invalid
     * ============================================================================== */
    getScoreElemDetails($score_elem) {
        const fbDataAttr = $score_elem.attr('fb-data');

        if (!fbDataAttr) {
            return null;
        }

        // Determine team from attribute
        const team = fbDataAttr.includes('team_a') ? 'a' : fbDataAttr.includes('team_b') ? 'b' : null;

        // Extract set number with regex
        const setMatch = fbDataAttr.match(/set_(\d+)/);
        const set = setMatch ? setMatch[1] : null;

        return { team, set };
    }

    /** ==============================================================================
     * Get current score for a specific set and team
     * @param {number} set - Set number (1-7)
     * @param {string} team - Team identifier ('a' or 'b')
     * @returns {number} Current score
     * ============================================================================== */
    getScore(set, team) {
        const $scoreElem = this.getScoreElem(set, team);
        return Number($scoreElem.is('input') ? $scoreElem.val() : $scoreElem.text());
    }


    /** ==============================================================================
     * Get the score for a specific team at a given point index in a set
     * @param {number} set - Set number (1-7)
     * @param {string} team - Team identifier ('a' or 'b')
     * @param {number} pointIndex - Point index (0-based)
     * @returns {number} Score at the specified point index
     * ============================================================================== */
    getScoreAtPointIndex(set, team, pointIndex) {
        const scoreHistory = this.getScoreHistory(set);
        const teamPointsList = this.scoreHistoryToTeamPoints(scoreHistory, team);
        
        // If pointIndex is beyond the available history, return the current score
        if (pointIndex >= teamPointsList.length) {
            return this.getScore(set, team);
        }
        
        // Return the score at the specified point index
        return teamPointsList[pointIndex] || 0;
    }
    

    /** ==============================================================================
     * Calculate total sets won by a team
     * @param {string} team - Team identifier ('a' or 'b')
     * @returns {number} Number of sets won
     * ============================================================================== */
    getSetScore(team) {
        let setScore = 0;
        const playedSets = this.getPlayedSets();
        
        $.each(playedSets, (i, set) => {
            if (this.setWinner(i + 1) === team) {
                setScore += 1;
            }
        });

        return setScore;
    }

    updateSets() {
        this.$setCounter.val(this.active_set);
        this.updateSetsVisibility();
        this.updateSetWinners();
    }

    updateSetsVisibility() {

        // Find all unique parent elements that contain .set elements
        const setGroups = [];
        this.$sets.each(function () {
            const parent = $(this).parent()[0];
            if (parent && !setGroups.includes(parent)) {
                setGroups.push(parent);
            }
        });

        setGroups.forEach((groupElem) => {
            const $groupSets = $(groupElem).children('.set');
            $groupSets.each((i, set) => {
                const $set = $(set);
                const setNumber = i + 1; // Counter is local to this group

                $set.hide().removeClass('active completed');

                if (setNumber <= this.active_set) {
                    $set.show();
                    if (setNumber === this.active_set) {
                        $set.addClass('active');
                    }
                }

                // Add 'completed' class if the set is already decided
                if (this.setWinner && this.setWinner(setNumber) != null) {
                    $set.addClass('completed');
                }
            });
        });
    }

    updateSetWinners() {
        const $scoreElems = $('[fb-data*="score"]');

        $.each($scoreElems, (i, elem) => {
            const $scoreElem = $(elem);
            const details = this.getScoreElemDetails($scoreElem);
            let { team, set } = details

            if (!details || (details.set == this.active_set && this.setWinner(details.set) == null)) {
                $scoreElem.removeClass('winner loser');
                $scoreElem.parent().removeClass('winner loser');
                return;
            }

            const winner = this.setWinner(details.set);
            if (winner == details.team) {
                $scoreElem.removeClass('loser').addClass('winner');
                $scoreElem.parent().removeClass('loser').addClass('winner');
            } else if (winner !== null) {
                $scoreElem.removeClass('winner').addClass('loser');
                $scoreElem.parent().removeClass('winner').addClass('loser');
            } else {
                $scoreElem.removeClass('winner loser');
                $scoreElem.parent().removeClass('winner loser');
            }
        });
    }

    updateSetScore() {
        this.$setScoreCounterA.text(this.getSetScore('a'));
        this.$setScoreCounterB.text(this.getSetScore('b'));
    }

    updateActiveScore() {
        this.$activeScoreCounterA.text(this.getScore(this.active_set, 'a'));
        this.$activeScoreCounterB.text(this.getScore(this.active_set, 'b'));
    }

    getCompletedSetsCount() {
        const setGroups = [];
        this.$sets.each(function () {
            const parent = $(this).parent()[0];
            if (parent && !setGroups.includes(parent)) {
                setGroups.push(parent);
            }
        });
        const completedCount = $(setGroups[0]).find('.set.completed').length;
        return completedCount;
    }

    /** ==============================================================================
     * Check if a set is won by a team
     * Takes into account overtime rules (2-point margin required or hardcap reached)
     * @param {number} set - Set number to check (defaults to active set)
     * @returns {string|null} Team identifier ('a', 'b') or null if set not won
     * ============================================================================== */
    setWinner(set = this.active_set) {
        const scoreA = this.getScore(set, 'a');
        const scoreB = this.getScore(set, 'b');

        // Check if hardcap is reached by either team. Only meaningful as a
        // sudden-death ceiling *above* the win score - if it's misconfigured
        // at or below win_points, honoring it here would lock in a winner
        // (on a tie, arbitrarily 'b') before the match ever reaches its real
        // target score, making that intended final score impossible to record.
        if (this.gameSettings.hardcap > this.gameSettings.win_points &&
            scoreA !== scoreB && (scoreA >= this.gameSettings.hardcap || scoreB >= this.gameSettings.hardcap)) {
            return scoreA > scoreB ? 'a' : 'b';
        }

        // Check if winning score is reached
        if (scoreA >= this.gameSettings.win_points || scoreB >= this.gameSettings.win_points) {
            const scoreDifference = Math.abs(scoreA - scoreB);
            
            // Check if 2-point margin is met
            if (scoreDifference >= this.gameSettings.min_win_margin) {
                return scoreA > scoreB ? 'a' : 'b';
            }
        }

        return null;
    }

    /** ==============================================================================
     * Warn the operator when Hardcap is configured at or below Win Score - in
     * that state the hardcap rule is ignored (see setWinner()), since honoring
     * it would end the set before the real target score is ever reached.
     * ============================================================================== */
    warnIfHardcapInvalid() {
        if (this.gameSettings.hardcap <= this.gameSettings.win_points) {
            showToast("⚠️", "Hardcap should be higher than Win Score, otherwise it's ignored.", 3000);
        }
    }


    /** ==============================================================================
     * Get the team that a player belongs to
     * @param {string} player - Player identifier ('a', 'b', 'c', 'd')
     * @returns {string|null} Team identifier ('a' or 'b') or null
     * ============================================================================== */
    getPlayerTeam(player) {
        if (player === 'a' || player === 'b') {
            return 'a';
        } else if (player === 'c' || player === 'd') {
            return 'b';
        }
        return null;
    }


    /** ==============================================================================
     * Auto-correct any set whose starting server and receiver ended up on the
     * same team (e.g. both left at their default "A" selection) - that combo
     * has no valid serve order and used to permanently freeze score input for
     * the set (see the guards in getServingPlayerAtPoint/getReceivingPlayerAtPoint).
     * Idempotent: no-op once the receiver is on the opposing team, so it's
     * safe to call on every data update as a self-healing pass against stale data.
     * ============================================================================== */
    sanitizeStartingSelections() {
        if (this.type !== 'input') return;

        for (let set = 1; set <= 7; set++) {
            const $receiverSel = this.$html_frame.find(`[fb-data="score.set_${set}.starting_receiver"]`).first();
            if (!$receiverSel.is('select')) continue;

            const server = this.getStartingServer(set);
            const receiver = $receiverSel.val();
            if (!server || !receiver) continue;

            if (this.getPlayerTeam(server) === this.getPlayerTeam(receiver)) {
                $receiverSel.val(this.getPlayerTeam(server) === 'a' ? 'c' : 'a');
                this.uploadData([$receiverSel]);
            }
        }
    }


    /** ==============================================================================
     * Get the player name by player identifier
     * @param {string} playerId - Player identifier ('a', 'b', 'c', 'd')
     * @returns {string} Player name or fallback
     * ============================================================================== */
    getPlayerName(playerId) {
        const playerMap = {
            'a': 'A_Player_1',
            'b': 'A_Player_2', 
            'c': 'B_Player_1',
            'd': 'B_Player_2'
        };
        
        const inputId = playerMap[playerId];
        if (inputId) {
            const $input = $(`#${inputId}`);
            if ($input.length > 0) {
                const value = $input.val();
                return value && value.trim() !== '' ? value : `Player ${playerId.toUpperCase()}`;
            }
        }
        
        return `Player ${playerId.toUpperCase()}`;
    }


    playerLocationTransformation(input, inputType, set) {
        const startingServer = this.getStartingServer(set);
        const startingReceiver = this.getStartingReceiver(set);
        
        let list;
        if (startingServer == 'a' && startingReceiver == 'c') {
            list = {
                a: 'b',
                b: 'a',
                c: 'd',
                d: 'c'
            }
        } else if (startingServer == 'a' && startingReceiver == 'd') {
            list = {
                a: 'b',
                b: 'a',
                c: 'c',
                d: 'd'
            }
        } else if (startingServer == 'b' && startingReceiver == 'c') {
            list = {
                a: 'a',
                b: 'b',
                c: 'd',
                d: 'c'
            }
        } else if (startingServer == 'b' && startingReceiver == 'd') {
            list = {
                a: 'a',
                b: 'b',
                c: 'c',
                d: 'd'
            }
        } else if (startingServer == 'c' && startingReceiver == 'a') {
            list = {
                a: 'd',
                b: 'c',
                c: 'b',
                d: 'a'
            }
        } else if (startingServer == 'c' && startingReceiver == 'b') {
            list = {
                a: 'c',
                b: 'd',
                c: 'b',
                d: 'a'
            }
        } else if (startingServer == 'd' && startingReceiver == 'a') {
            list = {
                a: 'd',
                b: 'c',
                c: 'a',
                d: 'b'
            }
        } else if (startingServer == 'd' && startingReceiver == 'b') {
            list = {
                a: 'c',
                b: 'd',
                c: 'a',
                d: 'b'
            }
        }
        
        if (inputType == 'player') {
            for (const [key, value] of Object.entries(list)) {
                if (value === input) {
                    return String(key);
                }
            }
        } else if (inputType == 'location') {
            return list[input];
        }
    }
    

    /** ==============================================================================
     * Check if a field is locked (should not be overwritten during manual import)
     * @param {jQuery} $elem - The element to check
     * @returns {boolean} True if the field is locked
     * ============================================================================== */
    isFieldLocked($elem) {
        // Find the lock icon that belongs to this input field
        const $lockIcon = $elem.closest('.input-with-trailing-icon').find('.lock-icon');
        return $lockIcon.hasClass('locked');
    }


    /** ==============================================================================
     * Get the team that should be serving based on new rules
     * Serve alternates every 2 serves regardless of point outcome
     * In overtime mode (when winning score is reached but 2-point margin not met), serve changes after every point
     * @returns {Object|null} Object with team and serve number, or null if no serve data
     * ============================================================================== */
    getServeInfo() {
        // Shared with the live overview (matchStatus.js)
        const set = this.active_set;
        const info = serveInfo(this.getScore(set, 'a'), this.getScore(set, 'b'), this.getStartingServer(set), {
            winPoints: this.gameSettings.win_points,
            hardcap: this.gameSettings.hardcap,
            minMargin: this.gameSettings.min_win_margin,
        });
        return info && { team: info.team, serveNumber: info.serveNumber, isOvertime: info.single && this.getTotalPointsInSet(set) > 0 };
    }

    /** ==============================================================================
     * Check if a set is in overtime mode
     * Overtime occurs when winning score is reached but 2-point margin is not met
     * OR when hardcap is reached by either team
     * @param {number} set - Set number to check (defaults to active set)
     * @returns {boolean} True if set is in overtime
     * ============================================================================== */
    isInOvertime(set = this.active_set, pointIndex = null) {
        let scoreA, scoreB;
        if (pointIndex == null) {
            scoreA = this.getScore(set, 'a');
            scoreB = this.getScore(set, 'b');
        } else {
            scoreA = this.getScoreAtPointIndex(set, 'a', pointIndex);
            scoreB = this.getScoreAtPointIndex(set, 'b', pointIndex);
        }
        // console.log(pointIndex, scoreA, scoreB);

        // Check if hardcap is reached by either team (see setWinner() for why
        // this only applies when hardcap is configured above win_points).
        if (this.gameSettings.hardcap > this.gameSettings.win_points &&
            scoreA !== scoreB && (scoreA >= this.gameSettings.hardcap || scoreB >= this.gameSettings.hardcap)) {
            return true;
        }

        // Check if winning score is reached
        if (scoreA >= this.gameSettings.win_points || scoreB >= this.gameSettings.win_points) {
            // Check if 2-point margin is met
            const scoreDifference = Math.abs(scoreA - scoreB);
            return scoreDifference < this.gameSettings.min_win_margin;
        }
        
        return false;
    }


    /** ==============================================================================
     * Get the starting server for a specific set
     * @param {number} set - Set number (1-7), defaults to active set
     * @returns {string|null} Player identifier ('a', 'b', 'c', 'd') or null if not set
     * ============================================================================== */
    getStartingServer(set = this.active_set) {
        const startingServerData = this.$html_frame.find(`[fb-data="score.set_${set}.starting_server"]`).first();
        return startingServerData.is('select') ? startingServerData.val() : startingServerData.text();
    }

    /** ==============================================================================
     * Get the starting receiver for a specific set
     * @param {number} set - Set number (1-7), defaults to active set
     * @returns {string|null} Player identifier ('a', 'b', 'c', 'd') or null if not set
     * ============================================================================== */
    getStartingReceiver(set = this.active_set) {
        const startingReceiverData = this.$html_frame.find(`[fb-data="score.set_${set}.starting_receiver"]`).first();
        return startingReceiverData.is('select') ? startingReceiverData.val() : startingReceiverData.text();
    }

    /** ==============================================================================
     * Get the team that has the starting serve for a specific set
     * @param {number} set - Set number (1-7), defaults to active set
     * @returns {string|null} Team identifier ('a' or 'b') or null if not set
     * ============================================================================== */
    getStartingTeam(set = this.active_set) {
        const startingServer = this.getStartingServer(set);
        if (startingServer) {
            // Map player values to team values
            return (startingServer === 'a' || startingServer === 'b') ? 'a' : 'b';
        }
        return null;
    }

    /** ==============================================================================
     * Count total points in a specific set
     * @param {number} set - Set number (1-7), defaults to active set
     * @returns {number} Total number of points
     * ============================================================================== */
    getTotalPointsInSet(set = this.active_set) {
        const scoreA = this.getScore(set, 'a');
        const scoreB = this.getScore(set, 'b');
        return scoreA + scoreB;
    }

    updateIndicators() {
        this.updateServeIndicator();
    }

    updateServeIndicator() {
        const serveInfo = this.getServeInfo();
        const $serverIndicators = $('.serve_indicator');
        
        // Check if set is already won - if so, hide all serve indicators
        const setWinner = this.setWinner();
        if (setWinner) {
            $serverIndicators.removeClass('active serve_1 serve_2 single_serve overtime');
            $serverIndicators.hide();
            return;
        }
        
        // Show serve indicators if set is not won
        $serverIndicators.show();
        
        // Remove all active classes first
        $serverIndicators.removeClass('active serve_1 serve_2 single_serve overtime');
        
        if (serveInfo) {
            const { team, serveNumber, isOvertime } = serveInfo;
            const $teamIndicators = $serverIndicators.filter(`.team_${team}`);
            
            // Add active class and serve number class
            $teamIndicators.addClass('active');

            const totalPoints = this.getTotalPointsInSet();
            if (totalPoints === 0 || isOvertime) {
                $teamIndicators.addClass('single_serve');
            }
            
            if (serveNumber === 1) {
                $teamIndicators.addClass('serve_1');
            } else if (serveNumber === 2) {
                $teamIndicators.addClass('serve_2');
            }
        }
    }

    updateSettings() {
        // Update checkbox states
        $.each(Object.entries(this.settings), (_, [key, value]) => {
            const $settingsEntry = this.$settingsEntries.filter(`[fb-data*="${key}"]`);
            $settingsEntry.prop('checked', value === 1);
        });

        // Update toggle switch states
        $.each(Object.entries(this.settings), (_, [key, value]) => {
            const $toggleSwitch = $(`.toggle-switch input[fb-data*="${key}"]`).closest('.toggle-switch');
            $toggleSwitch.toggleClass('active', value === 1);
        });

        // Team indicator row: the select shows the active mode; while none is
        // on it keeps the last pick, so switching the toggle on restores it
        const activeIndicator = TEAM_INDICATOR_MODES.find((key) => this.settings[key] === 1);
        if (activeIndicator) $('#Team_Indicator_Type').val(activeIndicator);
        $('#Show_Team_Indicator').prop('checked', !!activeIndicator)
            .closest('.toggle-switch').toggleClass('active', !!activeIndicator);

        // Update visibility states
        this.updateGroupScoreVisibility();
        this.updateColorIndicatorVisibility();
        this.updatePlayerNamesVisibility();
        this.updateServeIndicatorVisibility();
        this.updateUrlOutput();
        this.updateScoreHistoryVisibility();
        this.updateScoreHistoryChartVisibility();
        this.updateMatchStatisticsVisibility();
        this.updateMatchPreviewVisibility();
    }

    updateGroupScoreVisibility() {
        const isVisible = this.settings.show_group_score === 1;
        $('.group_score, .group-indicator').toggle(isVisible);
    }

    updateColorIndicatorVisibility() {
        // Club logos or the team logo - both in the flag's slot
        const logoMode = this.settings.show_club_logo === 1 ? 'club' : this.settings.show_team_logo === 1 ? 'team' : null;
        const showColor = this.settings.show_color === 1 && !logoMode;
        const showFlag = this.settings.show_flag === 1 && !logoMode;
        // Colors and flags are two independent settings, but mutually
        // exclusive by choice - flags wins if a stale channel somehow has
        // both set (the toggle-switch handler keeps them exclusive going
        // forward, but old data or a second admin editing concurrently could
        // still leave both at 1). Previously this required show_color AND
        // show_flag to both be on for flags to appear at all, which made
        // "flags on, colors off" show neither.
        const flagsOn = showFlag;

        // .color_indicator (underscore) is the overlays' own bar - a separate
        // class from the board's .color-indicator, which is why it used to
        // ignore this setting entirely and stayed on even in flags mode.
        $('.color-indicator, .overlay .color_indicator').toggle(showColor && !showFlag);
        $('.flag-indicator').toggle(flagsOn);
        // .flag-indicator-wrap (input.html only) stays visible whenever
        // flags mode is on regardless of whether a flag currently resolves,
        // since it also holds the country <select> - applyFlag() below only
        // hides the <img> inside it when there's nothing to show. Uses
        // .css('display', ...) rather than .toggle()/.show(), which would
        // restore the tag's generic default display ('block' for a div)
        // instead of the 'flex' the CSS layout needs.
        $('.flag-indicator-wrap').css('display', flagsOn ? 'flex' : 'none');

        if (flagsOn) {
            this.applyFlag('a');
            this.applyFlag('b');
            // Explicit pixel sizing, not CSS - see syncFlagWrapHeights()/
            // syncOutputFlagSizes(). Measuring forces a layout, so only when
            // something it depends on may have changed (resize, fonts, theme,
            // team data, settings - see layoutDirty).
            if (this.layoutDirty || !this.flagsWereOn) {
                this.syncFlagWrapHeights();
                this.syncOutputFlagSizes();
                this.layoutDirty = false;
            }
        }
        this.flagsWereOn = flagsOn;

        // Logos take the flags' place (same slot, same size)
        this.ensureLogoIndicators();
        $('.logo-indicator').toggleClass('visible', !!logoMode);
        if (logoMode) {
            this.applyLogos('a', logoMode);
            this.applyLogos('b', logoMode);
            this.syncOutputFlagSizes();
        }
    }

    /** ==============================================================================
     * One .logo-indicator per team next to every .flag-indicator of an
     * output page (board, overlays, score history), and next to the color
     * picker on input.html - created once, so display.html doesn't need a
     * second copy of every flag slot.
     * ============================================================================== */
    ensureLogoIndicators() {
        if (this.logoIndicatorsCreated) return;
        this.logoIndicatorsCreated = true;
        const create = (team, extraClass = '') =>
            $('<span class="logo-indicator" aria-hidden="true"></span>').addClass(`team_${team} ${extraClass}`.trim());

        if (this.type === 'input') {
            ['a', 'b'].forEach((team) => {
                this.$html_frame.find(`.teams .team .color-indicator.${team}_color`).after(create(team));
            });
            return;
        }
        $('.flag-indicator').each((_, el) => {
            const $flag = $(el);
            const team = $flag.hasClass('team_a') ? 'a' : $flag.hasClass('team_b') ? 'b' : null;
            if (team) $flag.after(create(team, $flag.hasClass('overlay_flag') ? 'overlay_flag' : ''));
        });
    }

    /** ==============================================================================
     * Fill a team's .logo-indicator elements - mode 'club': its players' club
     * logos, one if both play for the same club (or only one has a logo), two
     * slightly overlapping ones otherwise, like the Playerzone shows them;
     * mode 'team': the team logo (teams_info.team_x.logo).
     * @param {string} team - Team identifier ('a' or 'b')
     * @param {string} mode - 'club' or 'team'
     * ============================================================================== */
    applyLogos(team, mode) {
        const urls = mode === 'team' ? [this.teamLogos[team]] : this.teamClubLogos[team];
        const logos = [...new Set(urls.map((url) => (url || '').trim()).filter(Boolean))];
        const key = logos.join(' ');
        $(`.logo-indicator.team_${team}`).each((_, el) => {
            const $indicator = $(el);
            $indicator.toggleClass('empty', !logos.length);
            if ($indicator.attr('data-logos') === key) return; // unchanged - don't reload the images
            $indicator.attr('data-logos', key).empty();
            logos.forEach((url) => $('<img alt="">').attr('src', url).appendTo($indicator));
        });
    }

    /** ==============================================================================
     * Set every .flag-indicator <img> on an output page (display.html) to an
     * explicit height (scaled by FLAG_HEIGHT_SCALE) with a proportional
     * width via a plain 4:3 multiplication done in JS - not left to CSS
     * height:77%/aspect-ratio + !important, which kept getting silently
     * defeated per-theme across several rounds with no way to verify live.
     * The spectator board's flag sits in a .teamname-row like the stream
     * themes' main board, so it's measured the same way.
     *
     * Main scoreboard branch measures .teamname's cap-height (top of a
     * capital letter to the baseline), not .name, .team, or .teamname's own
     * box. .teamname's box is a line box - it includes the font's internal
     * leading above and below the glyphs, which is why a flag sized off of
     * it (via outerHeight()) still looked visibly taller than the letters
     * themselves even though the numbers matched. measureCapHeight() below
     * reads the font's actual glyph metrics instead via Canvas, and
     * .teamname-row aligns the row by CSS baseline (see style-output.css),
     * so the flag's bottom lands on the text baseline and its height reaches
     * exactly to the cap top - flush with both edges of the visible letters.
     * Measuring cap-height off a fixed reference glyph ("H") rather than the
     * team name's own text also keeps the flag a stable size regardless of
     * whether the current name has descenders (e.g. switching from "ITALY"
     * to "Germany" no longer changes the flag's height.) .name and .team
     * both contain the flag being sized, so measuring either of those (like
     * this method used to) would reintroduce the circular convergence this
     * method had when it measured .team: an un-sized flag briefly renders at
     * its raw SVG intrinsic size (large) on first paint, inflating the
     * measured container, which produces a too-large height that shrinks a
     * bit on each render instead of landing on the right size
     * immediately.
     * ============================================================================== */
    syncOutputFlagSizes() {
        const SCORE_HISTORY_FLAG_SCALE = 0.65; // relative to the legend's fixed 22px slot

        $('.flag-indicator, .logo-indicator').each((_, el) => {
            const $flag = $(el);
            const isLogo = $flag.hasClass('logo-indicator');
            // input.html sizes its logos in CSS
            if (isLogo && this.type === 'input') return;
            // input.html's flag <img> lives inside .flag-indicator-wrap and
            // is already sized (relative to .details, not .team) by
            // syncFlagWrapHeights() - skip it here to avoid the two fighting
            // over the same element with conflicting target heights.
            if ($flag.closest('.flag-indicator-wrap').length) return;

            let heightPx;
            if ($flag.closest('.match_statistics .score_history_in_stats').length) {
                // Fixed in this context (see the matching .color-indicator
                // rule in style-output.css), not relative to anything.
                heightPx = 22 * SCORE_HISTORY_FLAG_SCALE;
            } else if ($flag.hasClass('overlay_flag')) {
                // Overlay team headers carry the name in an <h4>, not a
                // .teamname, and the statistics overlay's header isn't inside
                // a .team either - so neither lookup below applies. The <h4>
                // is always the flag's next sibling (see display.html).
                const $reference = $flag.nextAll('h4').first();
                if (!$reference.length) return;
                heightPx = this.measureCapHeight($reference[0]);
            } else {
                const $team = $flag.closest('.team');
                if (!$team.length) return;
                const $reference = $team.find('.teamname').first();
                if (!$reference.length) return;
                heightPx = this.measureCapHeight($reference[0]);
            }
            if (!heightPx) return;

            if (isLogo) {
                // Square slots; a second logo overlaps the first by 40%
                $flag[0].style.setProperty('--logo-size', `${heightPx}px`);
                return;
            }
            $flag[0].style.setProperty('height', `${heightPx}px`, 'important');
            $flag[0].style.setProperty('width', `${heightPx * 4 / 3}px`, 'important');
        });
    }

    /**
     * Cap-height (top of a capital letter to the baseline) of an element's
     * rendered font, via Canvas measureText's actualBoundingBoxAscent on a
     * flat-topped reference glyph ("H", no descender to bias the reading) -
     * see syncOutputFlagSizes() for why this is measured off a fixed
     * reference glyph rather than the element's own text or box.
     */
    measureCapHeight(el) {
        const ctx = this._capHeightCtx || (this._capHeightCtx = document.createElement('canvas').getContext('2d'));
        const cs = getComputedStyle(el);
        ctx.font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return ctx.measureText('H').actualBoundingBoxAscent;
    }

    updatePlayerNamesVisibility() {
        const isVisible = this.settings.show_player_names === 1;
        $('body').attr('players', isVisible ? 'show' : 'hidden');
        $('.player_names').toggle(isVisible);
    }

    updateServeIndicatorVisibility() {
        const isVisible = this.settings.show_serve_indicator === 1;
        $('.serve_indicator').toggle(isVisible);
    }

    updateScoreHistoryVisibility() {
        const isVisible = this.settings.show_score_history === 1;
        $('.score_history').toggle(isVisible);
    }

    updateScoreHistoryChartVisibility() {
        const isVisible = this.settings.show_score_history_chart === 1;
        const $chartContainer = $('.chartContainer');
        
        if (isVisible && $chartContainer.is(':hidden')) {
            $chartContainer.slideDown(400, "easeOutCubic");
            this.scoreChart?.update();
        } else if (!isVisible && $chartContainer.is(':visible')) {
            $chartContainer.slideUp(300, "easeOutCubic");
        }
    }

    /** ==============================================================================
     * True for themes whose layout has room for the Match Statistics/Preview
     * overlays - mirrors setTheme()'s own condition (it force-hides both
     * containers whenever html_structure isn't 'vertical_score'). Compares
     * html_structure rather than the theme name directly: "small" uses the
     * same vertical_score layout as "rg"/"france"/"eura", even though its
     * name doesn't say so.
     * ============================================================================== */
    supportsOverlays() {
        const themeConfig = themes[this.theme];
        return !!themeConfig && (themeConfig.html_structure === 'vertical_score' || !!themeConfig.spectator);
    }

    /** ==============================================================================
     * Spectator view: the overlays are opened by the viewer, so the court's own
     * settings for them (set for the stream in the input panel) are ignored
     * there - see insertAdminSetting(). Everything else (colors, names, serve)
     * still follows the court.
     * ============================================================================== */
    setViewerSettings(values) {
        Object.assign(this.settings, values);
        this.updateSettings();
        this.requestRender();
    }

    updateMatchStatisticsVisibility() {
        // Previously checked theme name (`!= 'full' && != 'small'`) instead of
        // structure - since "small" is a vertical_score theme like "rg", that
        // skipped this entirely for it, so once shown, Match Statistics could
        // never be hidden again on that theme (setTheme() doesn't force-hide
        // vertical_score themes either - it defers to this toggle).
        if (!this.supportsOverlays()) return;

        this.toggleOverlay(this.$matchStatisticsContainer, this.settings.show_match_statistics === 1);
    }

    updateMatchPreviewVisibility() {
        if (!this.supportsOverlays()) return;

        this.toggleOverlay(this.$matchPreviewContainer, this.settings.show_match_preview === 1);
    }

    /**
     * Shows/hides an overlay with its animation. A still pending timeout of a
     * previous call is cancelled - otherwise a quick off/on (e.g. a first render
     * with defaults, immediately followed by the real data) could remove the
     * 'animate' class again afterwards.
     */
    toggleOverlay($container, isVisible) {
        const el = $container[0];
        if (!el) return;
        // Same target state as last call: leave its pending timeout alone,
        // otherwise back-to-back renders would keep pushing the 'show' back.
        const pending = this.overlayTimeouts.get(el);
        if (pending && pending.isVisible === isVisible) return;
        if (pending) clearTimeout(pending.id);

        if (isVisible) {
            // Add animation class first, then show
            $container.addClass('animate');

            // Small delay to ensure CSS is applied before showing
            this.overlayTimeouts.set(el, { isVisible, id: setTimeout(() => {
                $container.addClass('show').removeClass('hidden');
            }, 400) });
        } else {
            $container.removeClass('animate');
            this.overlayTimeouts.set(el, { isVisible, id: setTimeout(() => {
                $container.removeClass('animate show').addClass('hidden');
            }, 300) });
        }
    }

    updateUrlOutput() {
        const baseUrl = window.location.origin + window.location.pathname;
        const newUrl = baseUrl.replace("input.html", "display.html");
        // Org/court link as long as the channel belongs to a court - it stays
        // valid even if the internal channel number changes at some point.
        const court = this.user?.courtForChannel(this.channel);
        let urlOutput = court
            ? `${newUrl}?org=${encodeURIComponent(court.org)}&court=${court.court}`
            : `${newUrl}?channel=${this.channel}`;

        if (this.theme) {
            urlOutput += `&theme=${this.theme}`;
        }

        this.$urlOutput.text(urlOutput).attr('href', urlOutput);
    }

    /**
     * Court selection after login: one option per court (value = internal
     * channel number). Admins see the courts of all orgs, grouped by org.
     */
    updateAvailableChannels() {
        this.$channelInput.empty();

        if (!this.user || this.user.courts.length === 0) return;

        const orgIds = [...new Set(this.user.courts.map((c) => c.org))];
        orgIds.forEach((orgId) => {
            const courts = this.user.courts.filter((c) => c.org === orgId);
            const $target = orgIds.length > 1
                ? $('<optgroup></optgroup>').attr('label', courts[0].orgName).appendTo(this.$channelInput)
                : this.$channelInput;
            courts.forEach((c) => {
                $('<option></option>').val(c.channel).text(c.court).attr('title', `match-${c.channel}`).appendTo($target);
            });
        });

        if (!this.user.courtForChannel(this.channel)) {
            const requested = this.channel;
            this.channel = this.user.courts[0].channel;
            // Only report it if a specific channel was requested (e.g. via ?channel=)
            if (requested) {
                setTimeout(() => {
                    showToast("ℹ️", `You don't have access to channel ${requested} - switched to Court ${this.user.courts[0].court}.`, 3000);
                }, 2200);
            }
        }
        this.$channelInput.val(this.channel);
    }

    
    /** ==============================================================================
     * Update the current server and receiver display
     * ============================================================================== */
    updateCurrentPlayersDisplay() {
        const totalPoints = this.getTotalPointsInSet(this.active_set)
        const server = this.getServingPlayerAtPoint(totalPoints, this.active_set)
        const receiver = this.getReceivingPlayerAtPoint(totalPoints, this.active_set)
        
        if (server && receiver) {
            const serverName = this.getPlayerName(server);
            const receiverName = this.getPlayerName(receiver);
            $('#current_server_name').text(serverName);
            $('#current_receiver_name').text(receiverName);
        } else {
            $('#current_server_name').text('-');
            $('#current_receiver_name').text('-');
        }
    }


    /** ==============================================================================
     * Get the player that was serving at a specific point in the score history
     * @param {number} pointIndex - Index of the point (0-based)
     * @param {number} set - Set number (defaults to active set)
     * @returns {string|null} Player identifier ('a', 'b', 'c', 'd') or null if not available
     * ============================================================================== */
    getServingPlayerAtPoint(pointIndex, set = this.active_set) {
        const startingServer = this.getStartingServer(set);
        const startingReceiver = this.getStartingReceiver(set);
        const isOvertime = this.isInOvertime(set, pointIndex);

        let serveOrder;
        if (startingServer == 'a' && startingReceiver == 'c') {
            serveOrder = ['a', 'd', 'b', 'c'];
        } else if (startingServer == 'a' && startingReceiver == 'd') {
            serveOrder = ['a', 'c', 'b', 'd'];
        } else if (startingServer == 'b' && startingReceiver == 'c') {
            serveOrder = ['b', 'd', 'a', 'c'];
        } else if (startingServer == 'b' && startingReceiver == 'd') {
            serveOrder = ['b', 'c', 'a', 'd'];
        } else if (startingServer == 'c' && startingReceiver == 'a') {
            serveOrder = ['c', 'b', 'd', 'a'];
        } else if (startingServer == 'c' && startingReceiver == 'b') {
            serveOrder = ['c', 'a', 'd', 'b'];
        } else if (startingServer == 'd' && startingReceiver == 'a') {
            serveOrder = ['d', 'b', 'c', 'a'];
        } else if (startingServer == 'd' && startingReceiver == 'b') {
            serveOrder = ['d', 'a', 'c', 'b'];
        }

        // Same-team combo (see matching guard in getReceivingPlayerAtPoint) -
        // no valid serve order, so bail out instead of crashing below.
        if (!serveOrder) return null;

        const startIndex = serveOrder.indexOf(startingServer);
        // const startIndex = serveOrder.indexOf(this.playerLocationTransformation(startingServer, 'player', set));
        if (pointIndex === 0) {
            return startingServer;
        } else {
            let player, steps, pointsTillOvertime;
            if (!isOvertime) {
                steps = Math.floor(((pointIndex + 1) / 2) % 4);
                player = serveOrder[(startIndex + steps) % 4];
            } else {
                pointsTillOvertime = this.gameSettings.win_points * 2 - 2;
                steps = Math.floor(((((pointsTillOvertime + 1) / 2) % 4) + (pointIndex - pointsTillOvertime) % 4) % 4);
                player = serveOrder[(startIndex + steps) % 4];
            }
            
            return player;
            // return this.playerLocationTransformation(serveOrder[(startIndex + steps) % 4], 'location', set);
        }
    }


    /** ==============================================================================
     * Get the receiving player at a specific point in a set
     * @param {number} pointIndex - Point index (0-based)
     * @param {number} set - Set number
     * @returns {string|null} Player identifier ('a', 'b', 'c', 'd') or null
     * ============================================================================== */
    getReceivingPlayerAtPoint(pointIndex, set) {
        const startingServer = this.getStartingServer(set);
        const startingReceiver = this.getStartingReceiver(set);
        const isOvertime = this.isInOvertime(set, pointIndex);

        let receivingOrder, overtimeOrder15, overtimeOrder21;
        if (startingServer == 'a' && startingReceiver == 'c') {
            receivingOrder = ['c', 'b', 'a', 'c', 'd', 'a', 'b', 'd'];
            overtimeOrder15 = ['a', 'd', 'b', 'c'];
            overtimeOrder21 = ['b', 'd', 'a', 'c'];
        } else if (startingServer == 'a' && startingReceiver == 'd') {
            receivingOrder = ['d', 'b', 'a', 'd', 'c', 'a', 'b', 'c'];
            overtimeOrder15 = ['a', 'c', 'b', 'd'];
            overtimeOrder21 = ['b', 'c', 'a', 'd'];
        } else if (startingServer == 'b' && startingReceiver == 'c') {
            receivingOrder = ['c', 'a', 'b', 'c', 'd', 'b', 'a', 'd'];
            overtimeOrder15 = ['b', 'c', 'a', 'd'];
            overtimeOrder21 = ['a', 'd', 'b', 'c'];
        } else if (startingServer == 'b' && startingReceiver == 'd') {
            receivingOrder = ['d', 'a', 'b', 'd', 'c', 'b', 'a', 'c'];
            overtimeOrder15 = ['b', 'd', 'a', 'c'];
            overtimeOrder21 = ['a', 'c', 'b', 'd'];
        } else if (startingServer == 'c' && startingReceiver == 'a') {
            receivingOrder = ['a', 'd', 'c', 'a', 'b', 'c', 'd', 'b'];
            overtimeOrder15 = ['c', 'b', 'd', 'a'];
            overtimeOrder21 = ['d', 'b', 'c', 'a'];
        } else if (startingServer == 'c' && startingReceiver == 'b') {
            receivingOrder = ['b', 'd', 'c', 'b', 'a', 'c', 'd', 'a'];
            overtimeOrder15 = ['c', 'a', 'd', 'b'];
            overtimeOrder21 = ['d', 'a', 'c', 'b'];
        } else if (startingServer == 'd' && startingReceiver == 'a') {
            receivingOrder = ['a', 'c', 'd', 'a', 'b', 'd', 'c', 'b'];
            overtimeOrder15 = ['d', 'b', 'c', 'a'];
            overtimeOrder21 = ['c', 'b', 'd', 'a'];
        } else if (startingServer == 'd' && startingReceiver == 'b') {
            receivingOrder = ['b', 'c', 'd', 'b', 'a', 'd', 'c', 'a'];
            overtimeOrder15 = ['d', 'a', 'c', 'b'];
            overtimeOrder21 = ['c', 'a', 'd', 'b'];
        }

        // Starting server/receiver from the same team (e.g. both default to
        // 'a' before an operator sets the receiver) has no valid serve order -
        // bail out instead of leaving receivingOrder undefined, which would
        // throw on the next line and abort updateCurrentPlayersDisplay()
        // before it reaches uploadData(), silently blocking every score input.
        if (!receivingOrder) return null;

        // TODO: fix overtime
        const startIndex = receivingOrder.indexOf(startingReceiver);
        if (pointIndex === 0) {
            return startingReceiver;
        } else {
            let steps, pointsTillOvertime;
            if (!isOvertime) {
                steps = Math.floor((pointIndex) % 8);
                return receivingOrder[(startIndex + steps) % 8];
            } else {
                steps = Math.floor((pointIndex - 1) % 4);
                // pointsTillOvertime = this.gameSettings.win_points * 2 - 2;
                // let lastReceiver = receivingOrder[(startIndex + Math.floor((pointsTillOvertime) % 8)) % 8];
                // let preLastReceiver = receivingOrder[(startIndex + Math.floor((pointsTillOvertime - 1) % 8)) % 8]
                // let prePreLastReceiver = receivingOrder[(startIndex + Math.floor((pointsTillOvertime - 2) % 8)) % 8]
                // let lastReceiverTeam = this.getPlayerTeam(lastReceiver);
                // let preLastReceiverTeam = this.getPlayerTeam(preLastReceiver);
                // let prePreLastReceiverTeam = this.getPlayerTeam(prePreLastReceiver);

                // let overtimeOrder = [];
                // if (lastReceiverTeam == 'a' && preLastReceiverTeam == 'a') {
                //     prePreLastReceiver == 'c' ? overtimeOrder.push('c') : overtimeOrder.push('d')
                // } else if (lastReceiverTeam == 'b' && preLastReceiverTeam == 'b') {
                //     prePreLastReceiver == 'a' ? overtimeOrder.push('a') : overtimeOrder.push('b')
                // }
                
                // overtimeOrder.push(lastReceiver)
                // if (this.getPlayerTeam(overtimeOrder[0]) == 'a') {
                //     prePreLastReceiver == 'a' ? overtimeOrder.push('b') : overtimeOrder.push('a')
                // } else if (this.getPlayerTeam(overtimeOrder[0]) == 'b') {
                //     prePreLastReceiver == 'c' ? overtimeOrder.push('d') : overtimeOrder.push('c')
                // }
                // if (this.getPlayerTeam(overtimeOrder[1]) == 'a') {
                //     this.getPlayerTeam(overtimeOrder[1]) == 'a' ? overtimeOrder.push('b') : overtimeOrder.push('a'); 
                // } else if (this.getPlayerTeam(overtimeOrder[1]) == 'b') {
                //     this.getPlayerTeam(overtimeOrder[1]) == 'c' ? overtimeOrder.push('d') : overtimeOrder.push('c'); 
                // }

                // console.log(pointIndex, pointsTillOvertime)
                // console.log('last receivers: ', prePreLastReceiver, preLastReceiver, lastReceiver)
                // console.log(overtimeOrder, overtimeOrder15, overtimeOrder21);

                if (this.gameSettings.win_points == 15) {
                    return overtimeOrder15[(startIndex + steps) % 4];
                } else {
                    return overtimeOrder21[(startIndex + steps) % 4];
                }
            }
            
        }
    }

    /** ==============================================================================
     * Update score history display with visual indicators
     * Shows score progression and active streaks for each team
     * ============================================================================== */
    updateScoreHistory() {
        if (this.settings.show_score_history == 1) {
            // Update main score history
            $.each(this.$scoreHistoryContainer.find('.scores .team'), (i, container) => {
                this.updateScoreHistoryForContainer($(container)), this.active_set;
            });
        };        
        
        if (this.settings.show_match_statistics == 1) {
            // Update score history in match statistics based on selected type
            if (this.settings.match_stats_type === 'match') {

                let completedSetsCountArray;
                if (this.settings.match_stats_type == 'match') {
                    let completedSetsCount = this.getCompletedSetsCount();
                    completedSetsCountArray = Array.from({length: completedSetsCount}, (_, i) => i);
                    // const completedSetsCount = this.active_set;
                    if (this.active_set != completedSetsCount && this.getScore(this.active_set, 'a') + this.getScore(this.active_set, 'b') > 0) {
                        completedSetsCountArray.push(this.active_set - 1)
                    }
                } else {
                    completedSetsCountArray = this.settings.match_stats_type === 'active_set' ? [this.active_set - 1] : [this.settings.match_stats_type - 1];
                }

                this.$matchStatisticsContainer.find('.score_history_in_stats .scores .set').hide();
                $.each(this.$matchStatisticsContainer.find('.score_history_in_stats .scores .set'), (i, set_container) => {
                    if (i in completedSetsCountArray) {
                        $(set_container).show()
                        $.each($(set_container).find('.team'), (j, container) => {
                            this.updateScoreHistoryForContainer($(container), i + 1);
                        });
                    }
                });
            } else {
                // Show only the selected set
                let targetSet = 1;
                if (this.settings.match_stats_type === 'active_set') {
                    targetSet = this.active_set;
                } else if (Number.isInteger(Number(this.settings.match_stats_type))) {
                    targetSet = Number(this.settings.match_stats_type);
                }
                
                // Hide all sets first
                this.$matchStatisticsContainer.find('.score_history_in_stats .scores .set').hide();
                
                // Show only the target set
                const $targetSet = this.$matchStatisticsContainer.find(`.score_history_in_stats .scores .set#set_${targetSet}`);
                if ($targetSet.length) {
                    $targetSet.show();
                    $.each($targetSet.find('.team'), (j, container) => {
                        this.updateScoreHistoryForContainer($(container), targetSet);
                    });
                }
            }

            // count score items in score_history_in_stats and set it as attribute to .scores
            let score_items_count;
            if (this.settings.match_stats_type === 'match') {
                score_items_count = this.$matchStatisticsContainer.find('.score_history_in_stats .scores .set .team_rows .score_item').length / 2;
            } else {
                // For single set, only count visible set
                let targetSet = 1;
                if (this.settings.match_stats_type === 'active_set') {
                    targetSet = this.active_set;
                } else if (Number.isInteger(Number(this.settings.match_stats_type))) {
                    targetSet = Number(this.settings.match_stats_type);
                }
                score_items_count = this.$matchStatisticsContainer.find(`.score_history_in_stats .scores .set#set_${targetSet} .team_rows .score_item`).length / 2;
            }
            
            this.$matchStatisticsContainer.find('.score_history_in_stats .scores').attr('score_items_count', score_items_count);
            if (score_items_count >= 72) {
                this.$matchStatisticsContainer.find('.score_history_in_stats .scores').addClass('full');
            } else {
                this.$matchStatisticsContainer.find('.score_history_in_stats .scores').removeClass('full');
            }
        };
        

        // let score_sum = this.getScore(this.active_set, 'a') + this.getScore(this.active_set, 'b');
        // console.log(this.getServingPlayerAtPoint(score_sum), this.getReceivingPlayerAtPoint(score_sum));
    }

    /** ==============================================================================
     * Update score history for a specific container
     * @param {jQuery} $container - Container element to update
     * ============================================================================== */
    updateScoreHistoryForContainer($container, set = this.active_set) {
        const team = $container.attr('team');
        let scoresList;
        scoresList = this.scoreHistoryToTeamPoints(this.getScoreHistory(set), team);
        
        $container.empty();
        
        let streak = 0;
        $.each(scoresList, (i, score) => {
            const isActive = score > (i > 0 ? scoresList[i - 1] : 0);
            streak = isActive ? streak + 1 : 0;
            const status = isActive ? 'active' : '';
            
            // Calculate if this was a break point
            let breakAttribute = '';
            if (isActive) {
                const servingPlayer = this.getServingPlayerAtPoint(i, set);
                const servingTeam = this.getPlayerTeam(servingPlayer);
                const isBreak = servingTeam == team;
                breakAttribute = isBreak ? ' break' : '';
            }
            
            const element = `<div class="score_item ${status}" streak="${streak}"${breakAttribute}><p class="score_number">${score}</p></div>`;
            $container.append(element);
        });
    }

    /** ==============================================================================
     * Update Chart.js visualization of score progression
     * Creates line chart showing both teams' score progression over time
     * Uses team colors and provides visual feedback for score changes
     * The chart is created only once; after that only its data is swapped.
     * The colors are scriptable and re-read the team colors from the CSS
     * variables on every update(), so color changes still come through.
     * ============================================================================== */
    updateScoreHistoryChart() {
        const scoresTeamA = this.scoreHistoryToTeamPoints(this.getScoreHistory(), 'a');
        const scoresTeamB = this.scoreHistoryToTeamPoints(this.getScoreHistory(), 'b');
        const labels = scoresTeamA.map((_, i) => `${i + 1}`);

        if (this.scoreChart) {
            this.scoreChart.data.labels = labels;
            this.scoreChart.data.datasets[0].data = scoresTeamA;
            this.scoreChart.data.datasets[1].data = scoresTeamB;
            this.scoreChart.update();
            return;
        }

        const ctx = document.getElementById('scoreChart').getContext('2d');
        const teamColor = (team) => getComputedStyle(document.documentElement).getPropertyValue(`--${team}_Color`).trim();

        this.scoreChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: "Team A",
                        data: scoresTeamA,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        segment: {
                            borderColor: () => teamColor('A'),
                            backgroundColor: ctx => {
                                if (!ctx.p1 || !ctx.chart.data.datasets[1]) return '#000000';
                                const dataset2Value = ctx.chart.data.datasets[1].data[ctx.p0DataIndex];
                                return ctx.p1.parsed.y > dataset2Value ?
                                    `${teamColor('A')}44` :
                                    `${teamColor('B')}44`;
                            },
                        },
                        fill: '+1',
                    },
                    {
                        label: "Team B",
                        data: scoresTeamB,
                        borderColor: () => teamColor('B'),
                        backgroundColor: () => `${teamColor('B')}22`,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        fill: "false"
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 0
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                },
                scales: {
                    x: {
                        display: false,
                        title: { display: false, text: 'Punkt' },
                        grid: { display: false }
                    },
                    y: {
                        display: false,
                        title: { display: false, text: 'Punkte' },
                        grid: { display: false },
                        beginAtZero: true
                    }
                }
            }
        });
    }


    /** ==============================================================================
     * Update match statistics overlay with calculated statistics
     * Shows break percentages, sideout percentages, and player-specific stats
     * ============================================================================== */
    updateMatchStatistics() {
        if (this.settings.show_match_statistics !== 1) return;

        // Update the title based on selected type
        this.updateMatchStatisticsTitle();

        // Calculate statistics based on selected type
        let stats;
        let setNumber = null;
        
        if (this.settings.match_stats_type === 'match') {
            stats = this.calculateStatistics('game');
        } else if (this.settings.match_stats_type === 'active_set') {
            stats = this.calculateStatistics('set', this.active_set);
            setNumber = this.active_set;
        } else if (Number.isInteger(Number(this.settings.match_stats_type))) {
            setNumber = Number(this.settings.match_stats_type);
            stats = this.calculateStatistics('set', setNumber);
        }
        
        if (!stats) return;
        
        // Update team break percentages
        const breakPercentageA = stats.teamA.breakPercentage;
        const breakPercentageB = stats.teamB.breakPercentage;
        $('#team_a_break_percentage').text(`${breakPercentageA}`);
        $('#team_b_break_percentage').text(`${breakPercentageB}`);
        
        // Update team break absolute values
        $('#team_a_break_absolute').text(`(${stats.teamA.breaks}/${stats.teamA.breakOpportunities})`);
        $('#team_b_break_absolute').text(`(${stats.teamB.breaks}/${stats.teamB.breakOpportunities})`);
        // Remove 'best' class from both first
        $('#team_a_break_percentage').closest('.stat_item').removeClass('best');
        $('#team_b_break_percentage').closest('.stat_item').removeClass('best');
        // Add 'best' class to the element with the higher break percentage (if not equal)
        if (breakPercentageA > breakPercentageB) {
            $('#team_a_break_percentage').closest('.stat_item').addClass('best');
        } else if (breakPercentageB > breakPercentageA) {
            $('#team_b_break_percentage').closest('.stat_item').addClass('best');
        }
        
        this.updatePlayerStatistics(stats);
        this.updatePlayerSetStatistics();
        this.updateSetScoresDisplay(setNumber);
    }

    updateMatchStatisticsTitle() {
        let title = 'Match Statistics';
        
        if (this.settings.match_stats_type === 'active_set') {
            title = `Set ${this.active_set} Statistics`;
        } else if (Number.isInteger(Number(this.settings.match_stats_type))) {
            const setNumber = Number(this.settings.match_stats_type);
            title = `Set ${setNumber} Statistics`;
        }
        
        this.$matchStatisticsContainer.find('.center h3').text(title);
    }

    /**
     * Set scores in the statistics: all of them for the match, the other sets
     * dimmed for a single set - dimmed rather than hidden, so switching
     * between match and set doesn't move anything.
     */
    updateSetScoresDisplay(setNumber) {
        const $counters = this.$matchStatisticsContainer.find('.set_stats .counter');
        if (this.settings.match_stats_type === 'match' || !(setNumber >= 1 && setNumber <= 7)) {
            $counters.removeClass('dimmed');
            return;
        }
        $counters.addClass('dimmed');
        this.$matchStatisticsContainer.find(`.set_stats .counter:nth-child(${setNumber})`).removeClass('dimmed');
    }

    getLastResetIndex(event_history = this.event_history) {
        let startIndex = -1;
        $.each(event_history.slice().reverse(), (i, event) => {
            if (event.type === 'reset') {
                startIndex = event_history.length - 1 - i;
                return false; // break the loop
            }
        });
        return startIndex;
    }

    /** ==============================================================================
     * Calculate overall match statistics from event history
     * @returns {Object} Object containing team and player statistics
     * ============================================================================== */
    calculateStatistics(type = 'game', set = this.active_set) {
        const stats = {
            teamA: { breaks: 0, breakOpportunities: 0, breakPercentage: 0 },
            teamB: { breaks: 0, breakOpportunities: 0, breakPercentage: 0 },
            players: {
                a: { sideouts: 0, sideoutOpportunities: 0, breaks: 0, breakOpportunities: 0, sideoutPercentage: 0, breakPercentage: 0 },
                b: { sideouts: 0, sideoutOpportunities: 0, breaks: 0, breakOpportunities: 0, sideoutPercentage: 0, breakPercentage: 0 },
                c: { sideouts: 0, sideoutOpportunities: 0, breaks: 0, breakOpportunities: 0, sideoutPercentage: 0, breakPercentage: 0 },
                d: { sideouts: 0, sideoutOpportunities: 0, breaks: 0, breakOpportunities: 0, sideoutPercentage: 0, breakPercentage: 0 }
            }
        };

        // Find the last reset event
        let lastResetIndex = this.getLastResetIndex();
        let scoreEvents;
        // Get score events since last reset (all sets) of specific set
        if (type === 'game') {
            scoreEvents = this.event_history.slice(lastResetIndex + 1).filter(event => event.type === 'score');
        } else if (set !== null) {
            scoreEvents = this.getScoreHistory(set);
        } else {
            console.error('No set or game type specified');
            return;
        }

        // Optimiert: Nur die Event-Liste je nach Typ unterschiedlich erzeugen, die Auswertung ist identisch
        let eventsToProcess = [];
        if (type === 'game') {
            // Gruppiere die Score-Events nach Satz und füge sie mit setIndex hinzu
            const eventsBySet = {};
            scoreEvents.forEach(event => {
                if (!event.set) return;
                if (!eventsBySet[event.set]) eventsBySet[event.set] = [];
                eventsBySet[event.set].push(event);
            });
            Object.keys(eventsBySet).forEach(setKey => {
                // Same cleaned events as the single-set view
                const setEvents = this.getScoreHistory(setKey);
                setEvents.forEach((event, setIndex) => {
                    // Wir merken uns den Index innerhalb des Satzes
                    eventsToProcess.push({ event, index: setIndex, set: event.set });
                });
            });
        } else {
            // Einzelner Satz: Index ist einfach der Array-Index
            scoreEvents.forEach((event, index) => {
                eventsToProcess.push({ event, index, set: event.set });
            });
        }

        // Gemeinsame Auswertung
        eventsToProcess.forEach(({ event, index, set }) => {
            if (!event.team || !set) return;

            const team = event.team.toLowerCase();

            const servingPlayer = this.getServingPlayerAtPoint(index, set);
            const receivingPlayer = this.getReceivingPlayerAtPoint(index, set);
            const servingTeam = this.getPlayerTeam(servingPlayer);
            const isBreak = (team == servingTeam);

            // set break opportunities and sideout opportunities for team and player
            stats[`team${servingTeam.toUpperCase()}`].breakOpportunities++;
            stats.players[servingPlayer].breakOpportunities++;
            stats.players[receivingPlayer].sideoutOpportunities++;

            // set breaks and sideouts for team and player
            if (isBreak) {
                stats[`team${team.toUpperCase()}`].breaks++;
                stats.players[servingPlayer].breaks++;   
            } else {
                stats.players[receivingPlayer].sideouts++;
            }
        });
        
        // Calculate percentages
        stats.teamA.breakPercentage = stats.teamA.breakOpportunities > 0 ? 
            Math.round((stats.teamA.breaks / stats.teamA.breakOpportunities) * 100) : 0;
        stats.teamB.breakPercentage = stats.teamB.breakOpportunities > 0 ? 
            Math.round((stats.teamB.breaks / stats.teamB.breakOpportunities) * 100) : 0;

        // Calculate sideout and break percentages for each player
        Object.keys(stats.players).forEach(player => {
            const playerStats = stats.players[player];
            playerStats.sideoutPercentage = playerStats.sideoutOpportunities > 0 ?
                Math.round((playerStats.sideouts / playerStats.sideoutOpportunities) * 100) : 0;
            playerStats.breakPercentage = playerStats.breakOpportunities > 0 ?
                Math.round((playerStats.breaks / playerStats.breakOpportunities) * 100) : 0;
        });
        
        return stats;
    }

    /** ==============================================================================
     * Update player statistics in the UI
     * @param {Object} stats - Overall statistics object
     * ============================================================================== */
    updatePlayerStatistics(stats) {
        const players = ['a', 'b', 'c', 'd'];
        
        players.forEach(player => {
            const playerStats = stats.players[player];
            const sideoutPercentage = playerStats.sideoutPercentage;
            const breakPercentage = playerStats.breakPercentage;

            const allSideoutPercentages = players.map(p => stats.players[p].sideoutPercentage);
            const allBreakPercentages = players.map(p => stats.players[p].breakPercentage);
            const maxSideout = Math.max(...allSideoutPercentages);
            const maxBreak = Math.max(...allBreakPercentages);

            // Update UI and add/remove "best" class accordingly
            const $sideoutElem = $(`#player_${player}_sideout_percentage`);
            const $breakElem = $(`#player_${player}_break_percentage`);
            const $sideoutAbsoluteElem = $(`#player_${player}_sideout_absolute`);
            const $breakAbsoluteElem = $(`#player_${player}_break_absolute`);

            $sideoutElem.text(`${sideoutPercentage}`);
            $breakElem.text(`${breakPercentage}`);
            $sideoutAbsoluteElem.text(`(${playerStats.sideouts}/${playerStats.sideoutOpportunities})`);
            $breakAbsoluteElem.text(`(${playerStats.breaks}/${playerStats.breakOpportunities})`);

            if (sideoutPercentage === maxSideout && maxSideout > 0) {
                $sideoutElem.closest('.stat_item').addClass('best');
            } else {
                $sideoutElem.closest('.stat_item').removeClass('best');
            }

            if (breakPercentage === maxBreak && maxBreak > 0) {
                $breakElem.closest('.stat_item').addClass('best');
            } else {
                $breakElem.closest('.stat_item').removeClass('best');
            }
        });
    }

    /** ==============================================================================
     * Update set-specific player statistics in the UI
     * ============================================================================== */
    updatePlayerSetStatistics() {
        // Every set played so far gets its line - also for a single set, where
        // the other sets are only dimmed (see below), so switching between
        // match and set doesn't change the height and nothing moves
        let completedSetsCount = this.getCompletedSetsCount();
        const completedSetsCountArray = Array.from({length: completedSetsCount}, (_, i) => i);
        if (this.active_set != completedSetsCount && this.getScore(this.active_set, 'a') + this.getScore(this.active_set, 'b') > 0) {
            completedSetsCountArray.push(this.active_set - 1)
        }
        // The set the statistics are about (null: the whole match)
        const selectedSet = this.settings.match_stats_type === 'match' ? null
            : this.settings.match_stats_type === 'active_set' ? this.active_set
                : Number(this.settings.match_stats_type);

        // Build a map from set index to stats, so we can reference by set index directly
        const setsStats = {};
        $.each(completedSetsCountArray, (_, setIdx) => {
            // setIdx is the set index (0-based)
            const setNumber = setIdx + 1;
            setsStats[setNumber] = this.calculateStatistics('set', setNumber);
        });

        const players = ['a', 'b', 'c', 'd'];
        players.forEach(player => {
            // playerStatsBySetNum: { [setNumber]: playerStats }
            const playerStatsBySetNum = {};
            Object.keys(setsStats).forEach(setNumber => {
                playerStatsBySetNum[setNumber] = setsStats[setNumber].players[player];
            });

            // Find the max sideout/break percentage for this player across their sets
            const allSideoutPercentages = Object.values(playerStatsBySetNum).map(s => s.sideoutPercentage);
            const allBreakPercentages = Object.values(playerStatsBySetNum).map(s => s.breakPercentage);
            const maxSideout = Math.max(...allSideoutPercentages);
            const maxBreak = Math.max(...allBreakPercentages);

            // For each setNumber, update the UI for that set
            Object.entries(playerStatsBySetNum).forEach(([setNumber, setPlayerStats]) => {
                const sideoutPercentage = setPlayerStats.sideoutPercentage;
                const breakPercentage = setPlayerStats.breakPercentage;
                const $sideoutElem = $(`#player_${player}_sideout_percentage_set_${setNumber}`);
                const $breakElem = $(`#player_${player}_break_percentage_set_${setNumber}`);
                $sideoutElem.text(`${sideoutPercentage}`);
                $breakElem.text(`${breakPercentage}`);
                // Set the width of the .fill inside the sibling .bar_stat according to the percentage
                $sideoutElem.closest('.line_stat').find('.bar_stat .fill').css('width', `${sideoutPercentage}%`);
                $breakElem.closest('.line_stat').find('.bar_stat .fill').css('width', `${breakPercentage}%`);
                // Add or remove "best" class for the highest sideout % in this player's sets
                if (sideoutPercentage === maxSideout && maxSideout > 0) {
                    $sideoutElem.closest('.line_stat').addClass('best');
                } else {
                    $sideoutElem.closest('.line_stat').removeClass('best');
                }
                if (breakPercentage === maxBreak && maxBreak > 0) {
                    $breakElem.closest('.line_stat').addClass('best');
                } else {
                    $breakElem.closest('.line_stat').removeClass('best');
                }
            });

            // Show/hide .line_stat for each set according to completedSetsCountArray
            $(`[id^="player_${player}_sideout_percentage_set_"], [id^="player_${player}_break_percentage_set_"]`).each(function() {
                const id = $(this).attr('id');
                const match = id.match(/set_(\d+)$/);
                if (match) {
                    const setNum = parseInt(match[1], 10);
                    const $line = $(this).closest('.line_stat');
                    $line.toggle(completedSetsCountArray.includes(setNum - 1));
                    $line.toggleClass('dimmed', selectedSet != null && setNum !== selectedSet);
                }
            });
        });
    }

}


