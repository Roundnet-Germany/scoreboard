import { themes, readData, getPathsAndValues, getColorBrightness, rgb2hex, writeData, showToast, copyToClipboard } from "./main.js";

/**
 * Scoreboard class manages the live scoreboard functionality for both input and output modes.
 * Handles real-time data synchronization, UI updates, event history, and theme management.
 */
export class Scoreboard {
    /**
     * Initialize the Scoreboard with configuration and DOM elements
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
        this.$scoreboardInputs = this.$html_frame.find($('input:not([type=submit]), textarea'));
        this.$setCounter = $('#Set_Count');
        this.$winPoints = $('#win_points');
        this.$resetScoresButton = $('#reset_scores');
        this.$sets = $('.set');
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
        
        // Stored variables
        this.channel = Number(channel);
        this.theme = theme;
        this.settings = {
            "show_player_names": 1,
            "show_color": 1,
            "show_group_score": 0,
            "show_serve_indicator": 0,
            "show_score_history": 0,
            "show_score_history_chart": 0,
            "show_match_statistics": 0,
        };
        this.active_set = 1;
        this.ScoreHistoryChart = null;
        this.event_history = [];
        this.data_interval = null;
        this.update_interval = null;
        
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

    /**
     * Initialize the scoreboard with event listeners and data synchronization
     * Sets up intervals for UI updates and data fetching based on board type
     */
    init() {
        this.initEventListeners();
        this.insertLiveData();
        
        // Update UI every 300ms for smooth real-time updates
        this.update_interval = setInterval(() => {
            this.updateUI();
        }, 300);
        // TODO: reset this interval to 300

        // Simplified interval logic - removed redundant code
        // Input mode: slower updates (1500ms) since admin controls the data
        // Output mode: faster updates (300ms) for real-time display
        const dataIntervalDelay = this.type === 'input' ? 1500 : 300;
        this.data_interval = setInterval(() => {
            this.insertLiveData();
        }, dataIntervalDelay);

        // Set theme for output type
        if (this.type === 'output') {
            this.setTheme(this.theme);
        }
    }

    /**
     * Update the starting team selector to show the current set's starting team
     */
    updateStartingTeamSelector() {
        // Update all starting server selectors for all sets
        // for (let setNumber = 1; setNumber <= 7; setNumber++) {
        //     const $serverSelector = this.$html_frame.find(`#starting_server_${setNumber}`);
        //     if ($serverSelector.length > 0) {
        //         const currentStartingServer = this.getStartingServer(setNumber);
        //         if (currentStartingServer) {
        //             $serverSelector.val(currentStartingServer);
        //         }
        //     }
            
        //     const $receiverSelector = this.$html_frame.find(`#starting_receiver_${setNumber}`);
        //     if ($receiverSelector.length > 0) {
        //         const currentStartingReceiver = this.getStartingReceiver(setNumber);
        //         if (currentStartingReceiver) {
        //             $receiverSelector.val(currentStartingReceiver);
        //         }
        //     }
        // }
        
        // Update hidden starting_server and starting_receiver fields in output.html to reflect current set
        // if (this.type === 'output') {
        //     this.$html_frame.find(`[fb-data*="score.set_"][fb-data*=".starting_server"]`).each((index, element) => {
        //         const $element = $(element);
        //         $element.attr('fb-data', `score.set_${this.active_set}.starting_server`);
        //     });
            
        //     this.$html_frame.find(`[fb-data*="score.set_"][fb-data*=".starting_receiver"]`).each((index, element) => {
        //         const $element = $(element);
        //         $element.attr('fb-data', `score.set_${this.active_set}.starting_receiver`);
        //     });
        // }
    }

    /**
     * Update all UI components in a single pass for performance
     * Only updates score history for output mode to avoid unnecessary processing
     */
    updateUI() {
        this.updateSets();
        this.updateSetScore();
        this.updateActiveScore();
        this.updateIndicators();
        this.updateSettings();
        this.updateStartingTeamSelector();
        this.handleEventHistory();
        this.updateOldScoreInputCounter();
        
        // Only update score history for output type
        if (this.type === 'output') {
            this.updateScoreHistory();
            this.updateScoreHistoryChart();
            this.updateMatchStatistics();
        }
    }

    /**
     * Apply theme styling and HTML structure based on theme configuration
     * @param {string} theme - Theme identifier from themes object
     */
    setTheme(theme) {
        // console.log("setting theme to ", theme);
        // Simplified fallback logic
        if (!(theme in themes)) {
            theme = this.type === 'output' ? 'full' : 'rg';
            this.theme = theme;
        }

        // console.log("theme is ", theme);

        const css_path = themes[theme].css_path;
        const extensionIndex = css_path.lastIndexOf('.');
        const css_path_input = css_path.slice(0, extensionIndex) + "_input" + css_path.slice(extensionIndex);

        // Remove all stylesheets
        $('link[rel="stylesheet"]').remove();

        // Add relevant stylesheets
        $('<link>').attr('rel', 'stylesheet').attr('type', 'text/css').attr('href', '../css/base.css').appendTo('head');
        $('<link>').attr('rel', 'stylesheet').attr('type', 'text/css').attr('href', css_path).appendTo('head');
        
        if (this.type === 'input') {
            $('<link>').attr('rel', 'stylesheet').attr('type', 'text/css').attr('href', css_path_input).appendTo('head');
        } else if (this.type === 'output') {
            // Set corresponding html
            const html_structure = themes[theme].html_structure;
            $('.scoreboard').hide();
            $(`.scoreboard[theme="${html_structure}"]`).show();
            
            // Simplified conditional logic
            $('.score_history').toggleClass('hidden', html_structure !== 'vertical_score');
            $('.match_statistics').toggleClass('hidden', html_structure !== 'vertical_score');
        }
    }


    /**
     * Initialize all event listeners for user interactions
     * Handles score changes, set navigation, settings updates, and data synchronization
     */
    initEventListeners() {
        // Theme input dropdown listener
        this.$themeInput.change((event) => {
            this.theme = $(event.target).val();
            this.updateUrlOutput();
        });

        // Channel input dropdown listener
        this.$channelInput.change((event) => {
            this.channel = $(event.target).val();
            this.insertLiveData();
            this.updateUI();
        });

        // Starting team dropdown listener
        this.$html_frame.find('.starting_team_selector select').change((event) => {
            this.updateIndicators();
            this.uploadData([$(event.target)]);
        });

        // Update starting team selector when set changes
        this.$setCounter.on('input', () => {
            this.updateStartingTeamSelector();
        });

        // URL output container click handler
        this.$urlOutputContainer.click(() => {
            const text = this.$urlOutput.attr('href');
            copyToClipboard(text);
            showToast('📋', 'Copied url to clipboard');
        });

        // Data import button handler
        $('#import_data').click(() => {
            this.importDataFromJson();
        });

        // Score input handler with simplified logic
        this.$scoreboardInputs.filter('[fb-data*="score"]').on('input', (event) => {
            const $target = $(event.target);
            const { team, set } = this.getScoreElemDetails($target);
            const newScore = Number($target.val()) || 0; // Default to 0 if NaN
            const oldScore = Number(this.$html_frame.find('.team_score').attr(`score_${team}`)) || 0;
            const isSquadScore = $target.attr('fb-data').includes('squad_score');

            // Only add to event history if we have valid scores
            if (!isNaN(newScore) && !isNaN(oldScore)) {
                // Handle score decrease (remove history events)
                if (newScore < oldScore && !isSquadScore) {
                    this.removeScoreHistoryEvents(team, newScore, set);
                } else {
                    // Add new event to history
                    const eventData = {
                        type: isSquadScore ? 'squad_score' : 'score',
                        team: team,
                        score: newScore,
                    };
                    
                    if (!isSquadScore) {
                        eventData.set = Number(set);
                    }
                    
                    this.event_history.push(eventData);
                    // console.log(this.event_history);
                }
            }

            this.updateOldScoreInputCounter();
            this.uploadData([$target]);
        });

        // Non-score input handler
        this.$scoreboardInputs.not('[fb-data*="score"]').on('input', (event) => {
            this.uploadData([$(event.target)]);
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

        // Set counter input handler
        this.$setCounter.on('input', () => {
            this.updateSets();
            this.event_history.push({
                type: 'set',
                set: this.active_set,
            });
        });

        // Set change buttons handler
        this.$setChangeButtons.click((event) => {
            const $setButton = $(event.target);
            const change = Number($setButton.attr('change'));
            const currentSet = Number(this.$setCounter.val());
            const newSet = currentSet + change;

            if (newSet > 0 && newSet <= 7) {
                this.active_set = newSet;
                this.$setCounter.trigger('input');
                this.updateSets();
                this.uploadData([this.$setCounter]);
            }
        });

        // Settings entries handler
        this.$settingsEntries.click((event) => {
            const $trigger = $(event.target);
            const value = $trigger.prop('checked') ? 1 : 0;
            const part = $trigger.attr('fb-data').split('.').pop();
            this.settings[part] = value;
            this.updateSettings();
            this.uploadData([$trigger]);
        });

        // Toggle switch handler
        $('.toggle-switch input[type="checkbox"]').change((event) => {
            const $checkbox = $(event.target);
            const $toggleSwitch = $checkbox.closest('.toggle-switch');
            const value = $checkbox.prop('checked') ? 1 : 0;
            const part = $checkbox.attr('fb-data').split('.').pop();
            
            // Update toggle switch appearance
            $toggleSwitch.toggleClass('active', $checkbox.prop('checked'));
            
            // Update settings
            this.settings[part] = value;
            this.updateSettings();
            this.uploadData([$checkbox]);
        });

        // Winning score handler
        this.$winPoints.on('input', (event) => {
            const value = Number($(event.target).val());
            this.gameSettings.win_points = value;
            this.uploadData([$(event.target)]);
        });

        // Reset scores button handler
        this.$resetScoresButton.click(() => {
            $('[fb-data*="score"]:not(select)').val(0);
            this.active_set = 1;
            this.updateSets();
            this.event_history.push({ type: 'reset' });
            this.uploadData();
        });

        // Logout button handler
        this.$logoutButton.click(() => {
            localStorage.clear();
            location.reload();
        });
    }

    /**
     * Import data from JSON format in the textarea
     * Parses JSON data and applies it to the form fields
     */
    importDataFromJson() {
        const jsonText = $('#Data_Import').val().trim();
        
        if (!jsonText) {
            showToast("❌", "Please enter JSON data in the textarea");
            return;
        }

        try {
            const data = JSON.parse(jsonText);
            
            // Check if data has the expected structure
            if (!data || typeof data !== 'object') {
                showToast("❌", "Invalid JSON format");
                return;
            }

            // Process the data and update form fields using the common function
            this.processDataAndUpdateFields(data, true);

            // Find all updated elements for database upload
            const updatedElements = [];
            const pathsAndValues = getPathsAndValues(data);

            $.each(Object.entries(pathsAndValues), (_, [path, value]) => {
                const $elem = $(`[fb-data="${path}"]`);
                if ($elem.length > 0) {
                    updatedElements.push($elem);
                }
            });

            // Upload the imported data to database
            if (updatedElements.length > 0) {
                this.uploadData(updatedElements);
                showToast("✅", `Successfully imported ${updatedElements.length} fields`);
                
                // Clear the textarea after successful import
                $('#Data_Import').val('');
            } else {
                showToast("⚠️", "No matching fields found for the imported data");
            }

        } catch (error) {
            console.error("JSON parsing error:", error);
            showToast("❌", "Invalid JSON format: " + error.message);
        }
    }

    /**
     * Remove score history events when score is decreased
     * This maintains accurate event history for undo functionality
     * @param {string} team - Team identifier ('a' or 'b')
     * @param {number} newScore - The new score value
     */
    removeScoreHistoryEvents(team, newScore, set = this.active_set) {
        const reversedHistory = this.event_history.slice().reverse();
        $.each(reversedHistory, (index, event) => {
            if (event.type === 'score' && event.team === team && event.score > newScore && event.set == set) {
                this.event_history.splice(this.event_history.length - 1 - index, 1);
                return false; // break the loop
            }
        });
    }

    /**
     * Fetch and process live data from Firebase
     * Handles different data types: event history, admin settings, team colors, and general values
     */
    async insertLiveData() {
        console.log("inserting live data for channel ", this.channel);

        // Receive data from firebase
        const data = await readData(this.channel);
        this.processDataAndUpdateFields(data);
    }

    /**
     * Process data object and update form fields
     * Common function used by both live data insertion and JSON import
     * @param {Object} data - Data object to process
     * @param {boolean} isImport - Whether this is an import operation (affects special handling)
     */
    processDataAndUpdateFields(data, isImport = false) {
        const pathsAndValues = getPathsAndValues(data);

        // Process each path and value
        $.each(Object.entries(pathsAndValues), (_, [path, value]) => {
            const $allElements = $(`[fb-data="${path}"]`);

            if (path.includes('event_history')) {
                this.event_history = Array.isArray(value) ? value : [];
            } else if (path.includes('admin_settings')) {
                this.insertAdminSetting(path, value);
            } else if (path.includes('teams_info') && path.includes('color')) {
                this.insertColor($allElements.first(), path, value);
            } else if (path.includes('active_set')) {
                this.active_set = value;
            } else if (path.includes('starting_server') || path.includes('starting_receiver')) {
                // Handle starting team setting
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
                
                // Handle different data types for different settings
                if (settingKey === 'set_mode') {
                    // set_mode is a string, don't convert to number
                    this.gameSettings[settingKey] = value;
                } else {
                    // Other settings are numbers
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
            } else {
                // Handle elements with and without part attributes
                $allElements.each((_, elem) => {
                    const $elem = $(elem);
                    this.setElementValue($elem, value);
                });
            }
        });
    }

    /**
     * Set value on an element based on its type
     * @param {jQuery} $elem - Element to update
     * @param {*} value - Value to set
     */
    setElementValue($elem, value) {
        // Check if element has a part attribute for name splitting
        const part = $elem.attr('part');
        if (part && (part === 'prename' || part === 'surname')) {
            // Split the full name at the first space
            const nameParts = String(value).split(' ');
            if (part === 'prename') {
                // Set the first part (everything before the first space)
                $elem.text(nameParts[0] || '');
            } else if (part === 'surname') {
                // Set everything after the first space (join remaining parts)
                $elem.text(nameParts.slice(1).join(' ') || '');
            }
            return;
        }

        // Handle image elements - set src attribute
        if ($elem.is('img')) {
            $elem.attr('src', value || '');
            return;
        } else if ($elem.is('input[type="checkbox"]')) {
            $elem.prop('checked', value === 1 || value === true);
        } else if ($elem.is('input[type="color"]')) {
            $elem.val(value);
        } else if ($elem.is('input') || $elem.is('select')) {
            $elem.val(value);
        } else {
            $elem.text(value);
        }
    }

    /**
     * Insert admin setting value into local settings object
     * @param {string} path - Firebase path containing the setting
     * @param {*} value - Setting value to store
     */
    async insertAdminSetting(path, value) {
        const part = path.split('.').pop();
        this.settings[part] = value;
    }

    /**
     * Process team color updates with brightness calculations
     * Applies CSS variables and light/dark class adjustments
     * @param {jQuery} $elem - Color input element
     * @param {string} path - Firebase path containing color data
     * @param {string} value - Color value (hex or rgb)
     */
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

    /**
     * Upload data to Firebase with authentication checks
     * Processes element values and converts them to appropriate database format
     * @param {Array} elemList - List of jQuery elements to upload (optional, uploads all if undefined)
     */
    async uploadData(elemList) {
        // Check if selected channel is allowed
        if (!this.user || !this.channel || !this.user.channels.includes(Number(this.channel))) {
            if (this.channel) {
                showToast("❌", "You're not authenticated for this channel");
            }
            return;
        }

        // Upload all if there are no specific elements
        if (typeof elemList === 'undefined') {
            elemList = $("*[fb-data]");
        }

        // Prepare data for upload
        const newData = {};
        this.handleEventHistory();
        newData[`/match-${this.channel}/event_history`] = this.event_history;

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
                try {
                    finalValue = parseInt(value);
                } catch (error) {
                    console.error(value, " can't be converted to integer");
                    return;
                }
            }

            newData[pathToVariable] = finalValue;
        });

        writeData(newData);
        console.log("uploaded data to firebase", newData);
    }

    /**
     * Get all played sets (sets before the current active set)
     * @returns {Array} Array of jQuery set elements
     */
    getPlayedSets() {
        const playedSets = [];
        $.each(this.$sets, (i, set) => {
            if (i + 1 < this.active_set) {
                playedSets.push(set);
            }
        });
        return playedSets;
    }

    /**
     * Get score element for a specific set and team
     * @param {number} set - Set number (1-7)
     * @param {string} team - Team identifier ('a' or 'b')
     * @returns {jQuery} Score element
     */
    getScoreElem(set, team) {
        return $(this.$sets[set - 1]).find(`[fb-data*="score"][fb-data*="team_${team}"]`);
    }

    /**
     * Extract team and set information from score element
     * @param {jQuery} $score_elem - Score element to analyze
     * @returns {Object|null} Object with team and set properties, or null if invalid
     */
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

    /**
     * Get current score for a specific set and team
     * @param {number} set - Set number (1-7)
     * @param {string} team - Team identifier ('a' or 'b')
     * @returns {number} Current score
     */
    getScore(set, team) {
        const $scoreElem = this.getScoreElem(set, team);
        return Number($scoreElem.is('input') ? $scoreElem.val() : $scoreElem.text());
    }

    /**
     * Get the score for a specific team at a given point index in a set
     * @param {number} set - Set number (1-7)
     * @param {string} team - Team identifier ('a' or 'b')
     * @param {number} pointIndex - Point index (0-based)
     * @returns {number} Score at the specified point index
     */
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

    /**
     * Calculate total sets won by a team
     * @param {string} team - Team identifier ('a' or 'b')
     * @returns {number} Number of sets won
     */
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
        // The counter (setNumber) should be local to each group of set elements,
        // i.e., for each parent element containing a group of .set elements, the counter restarts.
        // We'll iterate over each parent group, then over its .set children.

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

    /**
     * Get the team that should be serving based on new rules
     * Serve alternates every 2 serves regardless of point outcome
     * In overtime mode (when winning score is reached but 2-point margin not met), serve changes after every point
     * @returns {Object|null} Object with team and serve number, or null if no serve data
     */
    getServingTeam() {
        // Get the starting team for this set from database
        const startingTeam = this.getStartingTeam(this.active_set);
        if (!startingTeam) return null;
        
        // Count total points in this set
        const totalPoints = this.getTotalPointsInSet(this.active_set);
        
        // Check if we're in overtime mode
        const isOvertime = this.isInOvertime(this.active_set);
        
        if (isOvertime) {
            // Overtime rules: serve changes after every point
            const servingTeam = totalPoints % 2 === 0 ? startingTeam : (startingTeam === 'a' ? 'b' : 'a');
            return {
                team: servingTeam,
                serveNumber: 1, // Always single serve in overtime
                isOvertime: true
            };
        }
        
        // Normal rules: first serve is single, then alternates every 2 points
        let servingTeam, serveNumber;
        if (totalPoints === 0) {
            servingTeam = startingTeam;
            serveNumber = 1;
        } else {
            const servesAfterFirst = totalPoints - 1;
            const serveGroup = Math.floor(servesAfterFirst / 2);
            const isStartingTeamServe = serveGroup % 2 === 0;
            servingTeam = isStartingTeamServe ? (startingTeam === 'a' ? 'b' : 'a') : startingTeam;
            serveNumber = (servesAfterFirst % 2) + 1;
        }
        
        return {
            team: servingTeam,
            serveNumber: serveNumber,
            isOvertime: false
        };
    }

    /**
     * Check if a set is in overtime mode
     * Overtime occurs when winning score is reached but 2-point margin is not met
     * OR when hardcap is reached by either team
     * @param {number} set - Set number to check (defaults to active set)
     * @returns {boolean} True if set is in overtime
     */
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
        
        // Check if hardcap is reached by either team
        if (scoreA >= this.gameSettings.hardcap || scoreB >= this.gameSettings.hardcap) {
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

    /**
     * Check if a set is won by a team
     * Takes into account overtime rules (2-point margin required or hardcap reached)
     * @param {number} set - Set number to check (defaults to active set)
     * @returns {string|null} Team identifier ('a', 'b') or null if set not won
     */
    setWinner(set = this.active_set) {
        const scoreA = this.getScore(set, 'a');
        const scoreB = this.getScore(set, 'b');
        
        // Check if hardcap is reached by either team
        if (scoreA >= this.gameSettings.hardcap || scoreB >= this.gameSettings.hardcap) {
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

    /**
     * Get the starting server for a specific set
     * @param {number} set - Set number (1-7), defaults to active set
     * @returns {string|null} Player identifier ('a', 'b', 'c', 'd') or null if not set
     */
    getStartingServer(set = this.active_set) {
        const startingServerData = this.$html_frame.find(`[fb-data="score.set_${set}.starting_server"]`).first();
        return startingServerData.is('input') ? startingServerData.val() : startingServerData.text();
    }

    /**
     * Get the starting receiver for a specific set
     * @param {number} set - Set number (1-7), defaults to active set
     * @returns {string|null} Player identifier ('a', 'b', 'c', 'd') or null if not set
     */
    getStartingReceiver(set = this.active_set) {
        const startingReceiverData = this.$html_frame.find(`[fb-data="score.set_${set}.starting_receiver"]`).first();
        return startingReceiverData.is('input') ? startingReceiverData.val() : startingReceiverData.text();
    }

    /**
     * Get the team that has the starting serve for a specific set
     * @param {number} set - Set number (1-7), defaults to active set
     * @returns {string|null} Team identifier ('a' or 'b') or null if not set
     */
    getStartingTeam(set = this.active_set) {
        const startingServer = this.getStartingServer(set);
        if (startingServer) {
            // Map player values to team values
            return (startingServer === 'a' || startingServer === 'b') ? 'a' : 'b';
        }
        return null;
    }

    /**
     * Count total points in a specific set
     * @param {number} set - Set number (1-7), defaults to active set
     * @returns {number} Total number of points
     */
    getTotalPointsInSet(set = this.active_set) {
        const scoreA = this.getScore(set, 'a');
        const scoreB = this.getScore(set, 'b');
        return scoreA + scoreB;
    }

    updateIndicators() {
        this.updateServeIndicator();
    }

    updateServeIndicator() {
        const serveInfo = this.getServingTeam();
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

        // Update visibility states
        this.updateGroupScoreVisibility();
        this.updateColorIndicatorVisibility();
        this.updatePlayerNamesVisibility();
        this.updateServeIndicatorVisibility();
        this.updateUrlOutput();
        this.updateScoreHistoryVisibility();
        this.updateScoreHistoryChartVisibility();
        this.updateMatchStatisticsVisibility();
    }

    updateGroupScoreVisibility() {
        const isVisible = this.settings.show_group_score === 1;
        $('.group_score, .group-indicator').toggle(isVisible);
    }

    updateColorIndicatorVisibility() {
        const isVisible = this.settings.show_color === 1;
        $('.color-indicator').toggle(isVisible);
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

    updateMatchStatisticsVisibility() {
        if (this.theme != 'full') {
            const isVisible = this.settings.show_match_statistics === 1;
        
            if (isVisible) {
                this.$matchStatisticsContainer.addClass('show').removeClass('hidden');
                if (this.type == 'output') {
                    // this.$html_frame.addClass('hidden');
                    // $('#score_history_individual').addClass('hidden');
                }
            } else {
                this.$matchStatisticsContainer.removeClass('show').addClass('hidden');
                if (this.type == 'output') {
                    // this.$html_frame.removeClass('hidden');
                    // $('#score_history_individual').removeClass('hidden');
                }
            }
        }
    }

    updateUrlOutput() {
        const baseUrl = window.location.origin + window.location.pathname;
        const newUrl = baseUrl.replace("input.html", "output.html");
        let urlOutput = `${newUrl}?channel=${this.channel}`;

        if (this.theme) {
            urlOutput += `&theme=${this.theme}`;
        }

        this.$urlOutput.text(urlOutput).attr('href', urlOutput);
    }

    updateAvailableChannels() {
        this.$channelInput.empty();

        if (!this.user) return;

        let channelExists = false;

        $.each(this.user.channels, (i, channel) => {
            this.$channelInput.append($('<option></option>').val(channel).html(channel));
            if (channel === this.channel) {
                channelExists = true;
            }
        });

        if (channelExists) {
            this.$channelInput.val(this.channel);
        } else {
            this.channel = this.user.channels[0];
            this.$channelInput.val(this.channel);
            setTimeout(() => {
                showToast("ℹ️", `Due to authentification the channel got changed to "${this.user.channels[0]}".`, 2000);
            }, 2200);
        }
    }

    updateOldScoreInputCounter() {
        this.$html_frame.find('.team_score')
            .attr('score_a', this.getScore(this.active_set, 'a'))
            .attr('score_b', this.getScore(this.active_set, 'b'));
    }

    handleEventHistory() {
        if (this.event_history.length > 200) {
            this.event_history = this.event_history.slice(-200);
        }
    }

    /**
     * Get score history for a specific set, filtering from last reset event
     * @param {number} set - Set number to get history for (defaults to active set)
     * @returns {Array} Filtered array of score events
     */
    getScoreHistory(set = this.active_set) {
        // Find the last reset event
        let startIndex = this.getLastResetIndex();

        const slicedEventHistory = this.event_history.slice(startIndex + 1);
        return slicedEventHistory.filter(event => 
            event.type === 'score' && 
            event.set == set && 
            event.team && 
            typeof event.team === 'string' &&
            event.score !== undefined
        );
    }

    /**
     * Convert score history to team points list for chart visualization
     * Maintains last known score for each team across all events
     * @param {Array} slicedEventHistory - Filtered event history
     * @param {string} team - Team identifier ('a' or 'b')
     * @returns {Array} Array of score values for chart data
     */
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

    /**
     * Get the player that was serving at a specific point in the score history
     * @param {number} pointIndex - Index of the point (0-based)
     * @param {number} set - Set number (defaults to active set)
     * @returns {string|null} Player identifier ('a', 'b', 'c', 'd') or null if not available
     */
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
        // let serveOrder = ['b', 'c', 'a', 'd'];
        // let serveOrderOvertime = ['d', 'a', 'c', 'b'];
        
        
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
                if (startingServer == 'a' || startingServer == 'b') {
                    player = player == 'a' ? 'b' : player == 'b' ? 'a' : player;
                } else if (startingServer == 'c' || startingServer == 'd') {
                    player = player == 'c' ? 'd' : player == 'd' ? 'c' : player;
                }
                // console.log(isOvertime, player, steps, pointsTillOvertime, pointIndex);
            }
            
            return player;
            // return this.playerLocationTransformation(serveOrder[(startIndex + steps) % 4], 'location', set);
        }
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

    /**
     * Get the receiving player at a specific point in a set
     * @param {number} pointIndex - Point index (0-based)
     * @param {number} set - Set number
     * @returns {string|null} Player identifier ('a', 'b', 'c', 'd') or null
     */
    getReceivingPlayerAtPoint(pointIndex, set) {
        const startingServer = this.getStartingServer(set);
        const startingReceiver = this.getStartingReceiver(set);
        const isOvertime = this.isInOvertime(set);

        let receivingOrder, overtimeOrder;
        if (startingServer == 'a' && startingReceiver == 'c') {
            receivingOrder = ['c', 'b', 'a', 'c', 'd', 'a', 'b', 'd'];
            overtimeOrder = ['a', 'd', 'b', 'c'];
        } else if (startingServer == 'a' && startingReceiver == 'd') {
            receivingOrder = ['d', 'b', 'a', 'd', 'c', 'a', 'b', 'c'];
            overtimeOrder = ['a', 'c', 'b', 'd'];
        } else if (startingServer == 'b' && startingReceiver == 'c') {
            receivingOrder = ['c', 'a', 'b', 'c', 'd', 'b', 'a', 'd'];
            overtimeOrder = ['b', 'd', 'a', 'c'];
        } else if (startingServer == 'b' && startingReceiver == 'd') {
            receivingOrder = ['d', 'a', 'b', 'd', 'c', 'b', 'a', 'c'];
            overtimeOrder = ['b', 'c', 'a', 'd'];
        } else if (startingServer == 'c' && startingReceiver == 'a') {
            receivingOrder = ['a', 'd', 'c', 'a', 'b', 'c', 'd', 'b'];
            overtimeOrder = ['c', 'b', 'd', 'a'];
        } else if (startingServer == 'c' && startingReceiver == 'b') {
            receivingOrder = ['b', 'd', 'c', 'b', 'a', 'c', 'd', 'a'];
            overtimeOrder = ['c', 'a', 'd', 'b'];
        } else if (startingServer == 'd' && startingReceiver == 'a') {
            receivingOrder = ['a', 'c', 'd', 'a', 'b', 'd', 'c', 'b'];
            overtimeOrder = ['d', 'b', 'c', 'a'];
        } else if (startingServer == 'd' && startingReceiver == 'b') {
            receivingOrder = ['b', 'c', 'd', 'b', 'a', 'd', 'c', 'a'];
            overtimeOrder = ['d', 'a', 'c', 'b'];
        }

        // receivingOrder = []
        // receivingOrder.push(startingReceiver);
        // receivingOrder.push(this.getPlayerTeam(startingReceiver) == 'a' ? '' : 'd');

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
                return overtimeOrder[(startIndex + steps) % 4];
                
                // pointsTillOvertime = this.gameSettings.win_points * 2 - 2;
                // steps = Math.floor(((pointsTillOvertime) % 8) + (pointIndex - pointsTillOvertime));
            }
            
        }
    }

    /**
     * Update score history display with visual indicators
     * Shows score progression and active streaks for each team
     */
    updateScoreHistory() {
        // Update main score history
        $.each(this.$scoreHistoryContainer.find('.scores .team'), (i, container) => {
            this.updateScoreHistoryForContainer($(container)), this.active_set;
        });
        
        // Update score history in match statistics
        $.each(this.$matchStatisticsContainer.find('.score_history_in_stats .scores .set'), (i, set_container) => {
            $.each($(set_container).find('.team'), (j, container) => {
                this.updateScoreHistoryForContainer($(container), i + 1);
            });
        });

        // count score items in score_history_in_stats and set it as attribute to .scores
        const score_items_count = this.$matchStatisticsContainer.find('.score_history_in_stats .scores .set .team_rows .score_item').length / 2;
        this.$matchStatisticsContainer.find('.score_history_in_stats .scores').attr('score_items_count', score_items_count);
        if (score_items_count >= 70) {
            this.$matchStatisticsContainer.find('.score_history_in_stats .scores').addClass('full');
        } else {
            this.$matchStatisticsContainer.find('.score_history_in_stats .scores').removeClass('full');
        }

        // let score_sum = this.getScore(this.active_set, 'a') + this.getScore(this.active_set, 'b');
        // console.log(this.getServingPlayerAtPoint(score_sum), this.getReceivingPlayerAtPoint(score_sum));
    }

    /**
     * Update score history for a specific container
     * @param {jQuery} $container - Container element to update
     */
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
                const servingPlayer = this.getServingPlayerAtPoint(i);
                const servingTeam = this.getPlayerTeam(servingPlayer);
                const isBreak = servingTeam == team;
                breakAttribute = isBreak ? ' break' : '';
            }
            
            const element = `<div class="score_item ${status}" streak="${streak}"${breakAttribute}><p class="score_number">${score}</p></div>`;
            $container.append(element);
        });
    }

    /**
     * Update Chart.js visualization of score progression
     * Creates line chart showing both teams' score progression over time
     * Uses team colors and provides visual feedback for score changes
     */
    updateScoreHistoryChart() {
        const scoresTeamA = this.scoreHistoryToTeamPoints(this.getScoreHistory(), 'a');
        const scoresTeamB = this.scoreHistoryToTeamPoints(this.getScoreHistory(), 'b');
        const labels = scoresTeamA.map((_, i) => `${i + 1}`);

        const ctx = document.getElementById('scoreChart').getContext('2d');

        // Destroy existing chart if it exists
        if (this.scoreChart) {
            this.scoreChart.destroy();
        }

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
                            borderColor: getComputedStyle(document.documentElement).getPropertyValue("--A_Color").trim(),
                            backgroundColor: ctx => {
                                if (!ctx.p1 || !ctx.chart.data.datasets[1]) return '#000000';
                                const dataset2Value = ctx.chart.data.datasets[1].data[ctx.p0DataIndex];
                                return ctx.p1.parsed.y > dataset2Value ?
                                    `${getComputedStyle(document.documentElement).getPropertyValue("--A_Color").trim()}44` :
                                    `${getComputedStyle(document.documentElement).getPropertyValue("--B_Color").trim()}44`;
                            },
                        },
                        fill: '+1',
                    },
                    {
                        label: "Team B",
                        data: scoresTeamB,
                        borderColor: getComputedStyle(document.documentElement).getPropertyValue("--B_Color").trim(),
                        backgroundColor: `${getComputedStyle(document.documentElement).getPropertyValue("--B_Color").trim()}22`,
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

        this.scoreChart.update();
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

    /**
     * Update match statistics overlay with calculated statistics
     * Shows break percentages, sideout percentages, and player-specific stats
     */
    updateMatchStatistics() {
        if (this.settings.show_match_statistics !== 1) return;

        // Calculate overall statistics
        const overallStats = this.calculateStatistics('game');
        
        // Update team break percentages
        const breakPercentageA = overallStats.teamA.breakPercentage;
        const breakPercentageB = overallStats.teamB.breakPercentage;
        $('#team_a_break_percentage').text(`${breakPercentageA}`);
        $('#team_b_break_percentage').text(`${breakPercentageB}`);
        
        // Update team break absolute values
        $('#team_a_break_absolute').text(`(${overallStats.teamA.breaks}/${overallStats.teamA.breakOpportunities})`);
        $('#team_b_break_absolute').text(`(${overallStats.teamB.breaks}/${overallStats.teamB.breakOpportunities})`);
        // Remove 'best' class from both first
        $('#team_a_break_percentage').closest('.stat_item').removeClass('best');
        $('#team_b_break_percentage').closest('.stat_item').removeClass('best');
        // Add 'best' class to the element with the higher break percentage (if not equal)
        if (breakPercentageA > breakPercentageB) {
            $('#team_a_break_percentage').closest('.stat_item').addClass('best');
        } else if (breakPercentageB > breakPercentageA) {
            $('#team_b_break_percentage').closest('.stat_item').addClass('best');
        }
        
        // Update player statistics
        this.updatePlayerStatistics(overallStats);

        this.updatePlayerSetStatistics();
        
        // Update score history within match statistics
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

    /**
     * Calculate overall match statistics from event history
     * @returns {Object} Object containing team and player statistics
     */
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
        
        // Process each score event
        scoreEvents.forEach((event, index) => {
            if (!event.team || !event.set) return;
            
            const team = event.team.toLowerCase();
            const set = event.set;
            
            // Determine who was serving at this point and if it was a break
            const servingPlayer = this.getServingPlayerAtPoint(index, set);
            const receivingPlayer = this.getReceivingPlayerAtPoint(index, set);
            const servingTeam = this.getPlayerTeam(servingPlayer);
            const isBreak = (team == servingTeam);

            // console.log(servingPlayer, receivingPlayer, isBreak);

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

    /**
     * Update player statistics in the UI
     * @param {Object} stats - Overall statistics object
     */
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

    /**
     * Update set-specific player statistics in the UI
     */
    updatePlayerSetStatistics() {
        let completedSetsCount = this.getCompletedSetsCount();
        // const completedSetsCount = this.active_set;
        if (this.active_set != completedSetsCount && this.getScore(this.active_set, 'a') + this.getScore(this.active_set, 'b') > 0) {
            completedSetsCount++;
        }
        const setsStats = [];
        $.each(Array(completedSetsCount), (i) => {
            const setStats = this.calculateStatistics('set', i + 1);
            setsStats.push(setStats);
        });

        const players = ['a', 'b', 'c', 'd'];
        players.forEach(player => {
            const playerStats = setsStats.map(setStats => setStats.players[player]);
            // console.log(playerStats);
            // Find the max sideout percentage for this player across their sets
            const maxSideout = Math.max(...playerStats.map(s => s.sideoutPercentage));
            const maxBreak = Math.max(...playerStats.map(s => s.breakPercentage));
            $.each(playerStats, function(setIndex, setPlayerStats) {
                const sideoutPercentage = setPlayerStats.sideoutPercentage;
                const breakPercentage = setPlayerStats.breakPercentage;
                const $sideoutElem = $(`#player_${player}_sideout_percentage_set_${setIndex + 1}`);
                const $breakElem = $(`#player_${player}_break_percentage_set_${setIndex + 1}`);
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

            $(`[id^="player_${player}_sideout_percentage_set_"], [id^="player_${player}_break_percentage_set_"]`).each(function() {
                const id = $(this).attr('id');
                const match = id.match(/set_(\d+)$/);
                if (match) {
                    const setNum = parseInt(match[1], 10);
                    if (setNum > completedSetsCount) {
                        $(this).closest('.line_stat').hide();
                    } else {
                        $(this).closest('.line_stat').show();
                    }
                }
            });
        });
    }

    /**
     * Get the team that a player belongs to
     * @param {string} player - Player identifier ('a', 'b', 'c', 'd')
     * @returns {string|null} Team identifier ('a' or 'b') or null
     */
    getPlayerTeam(player) {
        if (player === 'a' || player === 'b') {
            return 'a';
        } else if (player === 'c' || player === 'd') {
            return 'b';
        }
        return null;
    }
}

