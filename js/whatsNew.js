// "What's new": a short dialog about the latest update, shown once per browser
// on the overview and in the input panel (never on display.html - nothing pops
// up in a stream). Bump WHATS_NEW_ID for the next announcement, and everyone
// sees it once more. Styles: css/whats-new.css. Text is static, set as HTML.

const WHATS_NEW_ID = '2026-10';
const STORAGE_KEY = 'whats_new_seen';
/** Wait for the page to settle (loading spinner, auth) before popping up. */
const SHOW_DELAY_MS = 600;

const ITEMS = [
    {
        icon: 'grid_view',
        title: 'Live Matches overview',
        text: 'The start page now shows every court of every organisation at a glance: on court, just finished and inactive - with teams, sets, serve, squad score and running timers. Search and filter by organisation.',
    },
    {
        icon: 'tv',
        title: 'Improved spectator board',
        text: 'Tap a court to open the spectator board - now with live statistics for the match and the current set, and timeouts shown right on the board.',
    },
    {
        img: 'img/pz_logo.png',
        title: 'Expanded Playerzone connection',
        text: 'Game selector directly in the Scoreboard (or paste a game ID): teams and players are filled in and the score shows up live in the Playerzone.',
    },
    {
        icon: 'groups',
        title: 'Automatic squad score',
        text: 'For league squad games the squad score can count itself from the decided subgames on the other courts - as long as the games are connected via the Playerzone.',
    },
    {
        icon: 'image',
        title: 'Club & team logos',
        text: 'Next to colors and flags, the team indicator can now show the players\' club logos or a team logo.',
    },
    {
        icon: 'bolt',
        title: 'Faster & more reliable',
        text: 'Instant updates, a connection indicator in the input panel and a cleaner score history, even with two devices on one court.',
    },
    {
        icon: 'lock',
        title: 'New, more secure login',
        text: 'You now sign in with your email only. Every organisation runs its own courts 1, 2, 3 … instead of shared channel numbers - and write access is enforced by the database itself, so nobody can change scores on courts that aren\'t theirs.',
    },
];

const LINKS_NOTE = 'Your existing stream, OBS and Playerzone links keep working.';

function seen() {
    try {
        return localStorage.getItem(STORAGE_KEY) === WHATS_NEW_ID;
    } catch {
        return false;
    }
}

function markSeen() {
    try {
        localStorage.setItem(STORAGE_KEY, WHATS_NEW_ID);
    } catch { /* storage blocked - then it shows again next time */ }
}

function build() {
    const dialog = document.createElement('dialog');
    dialog.className = 'whats_new';
    dialog.setAttribute('aria-labelledby', 'whats_new_title');
    dialog.innerHTML = `
        <div class="whats_new_head">
            <span class="whats_new_badge">Update</span>
            <h2 id="whats_new_title">That's new</h2>
            <button type="button" class="whats_new_close" aria-label="Close">
                <i class="material-symbols-rounded" aria-hidden="true">close</i>
            </button>
        </div>
        <ul class="whats_new_list">
            ${ITEMS.map((item) => `
                <li>
                    ${item.img
                        ? `<img class="whats_new_icon" src="${item.img}" alt="" aria-hidden="true">`
                        : `<i class="material-symbols-rounded whats_new_icon" aria-hidden="true">${item.icon}</i>`}
                    <div>
                        <h3>${item.title}</h3>
                        <p>${item.text}</p>
                    </div>
                </li>`).join('')}
        </ul>
        <p class="whats_new_note">
            <i class="material-symbols-rounded" aria-hidden="true">link</i>${LINKS_NOTE}
        </p>
        <div class="whats_new_actions">
            <button type="button" class="whats_new_ok">Got it</button>
        </div>`;

    const close = () => dialog.close();
    dialog.querySelector('.whats_new_close').addEventListener('click', close);
    dialog.querySelector('.whats_new_ok').addEventListener('click', close);
    // A click on the backdrop (outside the dialog's box) closes it as well
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) close();
    });
    // Escape counts as seen, too
    dialog.addEventListener('close', () => {
        markSeen();
        dialog.remove();
    });
    return dialog;
}

function show() {
    if (seen() || typeof HTMLDialogElement === 'undefined') return;
    const dialog = build();
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('.whats_new_ok').focus();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(show, SHOW_DELAY_MS));
} else {
    setTimeout(show, SHOW_DELAY_MS);
}
