// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getDatabase, ref, connectDatabaseEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
// import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries


// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyBKYKaXBpWNMgT8TlSWECmbzUSP85Eo6Wg",
    authDomain: "live-scoreboard-fc0e5.firebaseapp.com",
    databaseURL: "https://live-scoreboard-fc0e5-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "live-scoreboard-fc0e5",
    storageBucket: "live-scoreboard-fc0e5.appspot.com",
    messagingSenderId: "115739864306",
    appId: "1:115739864306:web:09e828c04e34a53a87f46b",
    measurementId: "G-H02FX3HRPK"
};


// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

// Local testing against the Firebase emulators (firebase emulators:start --only database,auth):
// open the page on localhost with ?emulator - kept for this tab, ?emulator=0 turns it off.
// The Playerzone can then read the same data via VITE_SCOREBOARD_DATABASE_URL=
// http://127.0.0.1:9000/?ns=live-scoreboard-fc0e5-default-rtdb
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    const param = new URLSearchParams(location.search).get('emulator');
    try {
        if (param === '0') sessionStorage.removeItem('emulator');
        else if (param !== null) sessionStorage.setItem('emulator', '1');
    } catch { /* storage unavailable */ }
    let useEmulator = param !== null && param !== '0';
    try { useEmulator = sessionStorage.getItem('emulator') === '1'; } catch { /* keep URL param */ }
    if (useEmulator) {
        connectDatabaseEmulator(db, '127.0.0.1', 9000);
        connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        console.info('[Firebase] using local emulators');
    }
}
export { signInWithEmailAndPassword, signOut, onAuthStateChanged };



