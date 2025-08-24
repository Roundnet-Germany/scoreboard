// import firebase config
import {get, ref, update, set} from "https://www.gstatic.com/firebasejs/10.5.2/firebase-database.js";
import {db} from "./firebase_config.js";

import { User } from "./User.js";
import { Scoreboard } from "./Scoreboard.js";

export const themes = {
    'full': {
        'html_structure': 'full',
        'css_path': 'css/style-v3.css'
    },
    'small': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v5.css'
    },
    'rg': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v1.css'
    },
    'tops': {
        'html_structure': 'horizontal_score',
        'css_path': 'css/style-v2.css'
    },
    'france': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v4-france.css'
    },
    'eura': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v5-eura.css'
    },
}

// Initialize variables for global usage
let loggedInUser;
let scoreboard;
let $banner, $logoutButton, $userString;

// =========================================== Page Load ======================================= //

$(document).ready(async function () {
    $banner = $('.banner');
    $logoutButton = $('button#logout');
    $userString = $('header #username');

    // Get URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const urlChannel = urlParams.get('channel');
    const urlTheme = urlParams.get('theme');
    
    // Parse channel selection with fallback
    const channelSelection = isNaN(parseInt(urlChannel, 10)) ? 1 : urlChannel;
    const themeSelection = urlTheme;

    // Determine board type
    const type = $('html').attr('type') === 'output' ? 'output' : 'input';

    // Create scoreboard immediately
    scoreboard = new Scoreboard(type, $('.scoreboard'), channelSelection, themeSelection);

    // Wait for authentication and set user for input type
    if (type === 'input') {
        await handleAuthentication(scoreboard);
    }

    // Close toast message
    $('.banner_close_button').click(() => {
        $banner.fadeOut(100);
    });
});

// ========================================= Data Functions ===================================== //

export async function readData(channel) {
    const matchRef = ref(db, `match-${channel}`);
    const matchData = await get(matchRef);
    return matchData.val();
}

async function getUsers() {
    const usersData = await get(ref(db, 'users'));
    return usersData.val();
}

export async function writeData(newData) {
    try {
        await update(ref(db), newData);
        console.log("Data updated successfully.");
    } catch (error) {
        console.error("Error updating user data:", error);
    }
}

// ========================================= Global Functions ===================================== //

async function handleAuthentication(scoreboard) {
    return new Promise(async (resolve) => {
        const storedUser = localStorage.getItem('currentUser');

        if (storedUser) {
            // Check if user is stored in localStorage
            const userData = JSON.parse(storedUser);
            loggedInUser = await login(userData.username, userData.password || "");

            if (loggedInUser) {
                // User successfully authenticated, assign to scoreboard
                scoreboard.user = loggedInUser;
                scoreboard.updateAvailableChannels();
                resolve(loggedInUser);
            }
        }

        // If no user in localStorage or login failed
        if (!loggedInUser) {
            $('#auth').show();

            // Login form for user authentication
            $('form#login').on('submit', async function (e) {
                e.preventDefault();
                const username = $('#auth #username').val();
                const password = $('#auth #password').val();
                
                loggedInUser = await login(username, password);

                if (loggedInUser) {
                    $('#auth').hide();
                    // Set user and update scoreboard
                    scoreboard.user = loggedInUser;
                    scoreboard.updateAvailableChannels();
                    resolve(loggedInUser);
                }
            });
        }
    });
}

async function signUp(email, password) {
    const users = await getUsers();
    if (users && users[email]) {
        showToast("❌", "Username already exists");
        return null;
    }

    try {
        await set(ref(db, `users/${email}`), {
            email: email,
            password: password // Store password (not hashed)
        });
        console.log(`User ${email} registered.`);
    } catch (error) {
        console.error("Error during registration:", error);
        showToast("⚠️", "Registration failed: " + error.message);
        throw error;
    }
}

async function login(username, inputPassword) {
    const users = await getUsers();

    if (users && users[username]) {
        const user = users[username];
        if (inputPassword === user.password) {
            console.log(`${username} is now logged in.`);
            const authChannels = users[username].channels.split(',');
            loggedInUser = new User(username, user.password, authChannels);
            $('#auth').hide();
            $userString.html(`${users[username].display_name}`);
            $logoutButton.html(`Logout`);           
            showToast("✅", `Successfully logged in as ${users[username].display_name}`, 2000);
        } else {
            showToast("❌", "The entered credentials are wrong, please try it again");
            return null;
        }
    } else {
        // User doesn't exist, prompt for registration
        showToast("🆕", `User not found. You first have to register`);
        return null;
    }

    return loggedInUser || null;
}

export function showToast(emoji, message, duration) {
    try {
        // Set the animation-duration of the cooldown ring to the show duration
        const showDuration = duration || 5000;
        $banner.find('.icon').html(emoji);
        $banner.find('.progress-ring_circle').css('animation-duration', `${showDuration / 1000}s`);
        $banner.find('p').html(message);
        $banner.fadeIn(100);
        
        // Fade out banner after the set show duration if not already closed manually
        setTimeout(() => {
            $banner.fadeOut(100);
        }, showDuration);
    } catch (error) {
        console.log("Banner shown: " + message);
    }
}

// ========================================= Helper Functions ===================================== //

function isNumeric(value) {
    return /^-?\d+$/.test(value);
}

export function rgb2hex(rgb) {
    if (/^#[0-9A-F]{6}$/i.test(rgb)) return rgb;
    rgb = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);

    function hex(x) {
        return ("0" + parseInt(x).toString(16)).slice(-2);
    }
    return "#" + hex(rgb[1]) + hex(rgb[2]) + hex(rgb[3]);
}


export function getColorBrightness(hexColor) {
    var r = parseInt(hexColor.substr(1, 2), 16);
    var g = parseInt(hexColor.substr(3, 2), 16);
    var b = parseInt(hexColor.substr(5, 2), 16);

    return (r * 299 + g * 587 + b * 114) / 1000;
}

// Helper function that returns the paths and values to json objects
export function getPathsAndValues(obj, currentPath = '') {
    const result = {};

    for (const key in obj) {
        const value = obj[key];
        // Create the current path without leading dot
        const path = currentPath ? `${currentPath}.${key}` : key;

        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            // Call recursive function to traverse deeper objects
            Object.assign(result, getPathsAndValues(value, path));
        } else {
            // Store the complete path with the value
            result[path] = value;
        }
    }

    return result;
}

// Function to copy text to clipboard
export function copyToClipboard(text) {
    // Create a temporary input field to copy text to clipboard
    const tempInput = $('<input>');
    $('body').append(tempInput);  // Add the input field to the DOM

    tempInput.val(text).select();  // Set the text in the input field and select it
    document.execCommand('copy');  // Copy the text to the clipboard

    tempInput.remove();  // Remove the temporary input field
}
