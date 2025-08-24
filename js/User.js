export class User {
    constructor(username, password, channels = []) {
        this.username = username;
        this.password = password;
        this.isAuthenticated = true; // User is logged in
        this.channels = channels.map(Number);
        this.init();
    }

    init() {
        // Store user in localStorage
        localStorage.setItem('currentUser', JSON.stringify(this));
    }

    logout() {
        this.isAuthenticated = false;
        localStorage.clear();
        console.log(`${this.username} is now logged out.`);
        location.reload();
    }
}
