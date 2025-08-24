// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.5.2/firebase-app.js";
import { getDatabase, ref } from "https://www.gstatic.com/firebasejs/10.5.2/firebase-database.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.5.2/firebase-auth.js";
// import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.5.2/firebase-analytics.js";
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



