import { auth, signOut } from "./firebase_config.js";

export class User {
    constructor(username, channels = [], displayName = "") {
        this.username = username;
        this.isAuthenticated = true; // User is logged in
        this.channels = channels.map(Number);
        this.displayName = displayName;
        this.init();
    }

    init() {
        // Store user in localStorage (ohne Passwort – Session liegt bei Firebase Auth)
        localStorage.setItem('currentUser', JSON.stringify({
            username: this.username,
            channels: this.channels,
            displayName: this.displayName
        }));
    }

    logout() {
        this.isAuthenticated = false;
        signOut(auth).then(() => {
            localStorage.clear();
            console.log(`${this.username} is now logged out.`);
            location.reload();
        }).catch((err) => {
            console.error("Logout error:", err);
            localStorage.clear();
            location.reload();
        });
    }
}
