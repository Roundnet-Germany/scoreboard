// Toast: a short message at the bottom, the same on every page that has the
// element (input panel, overview - see css/toast.css). The display has none on
// purpose: nothing pops up in a stream. Text comes from outside too (URL
// parameters, Playerzone team names, error messages) - always set as text.

let hideTimeout = null;

/**
 * @param {string} emoji - icon in front of the message
 * @param {string} message
 * @param {number} [duration=4000] - ms until it fades out; a newer toast restarts it
 */
export function showToast(emoji, message, duration = 4000) {
    const toast = document.getElementById('toast');
    if (!toast) {
        console.log(`[Toast] ${emoji} ${message}`);
        return;
    }
    toast.querySelector('.toast_icon').textContent = emoji;
    toast.querySelector('.toast_text').textContent = message;
    toast.classList.add('visible');
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => toast.classList.remove('visible'), duration);
}
