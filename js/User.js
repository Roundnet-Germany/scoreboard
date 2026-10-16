import { auth, signOut } from "./firebase_config.js?v=4";

export class User {
    /**
     * @param {Object} props
     * @param {string} props.email
     * @param {string|null} props.orgId - The account's org (accounts/<uid>/org)
     * @param {string} props.orgName
     * @param {Array<{org: string, orgName: string, court: number, channel: number}>} props.courts
     *        Courts this account may operate - admins get all of them
     * @param {boolean} props.isAdmin
     */
    constructor({ email, orgId, orgName, courts, isAdmin }) {
        this.email = email;
        this.orgId = orgId;
        this.displayName = orgName || email;
        this.courts = courts;
        this.isAdmin = isAdmin;
        // Internal channel numbers (match-<n>) for the permission checks in Scoreboard
        this.channels = courts.map((c) => c.channel);
        this.isAuthenticated = true;
    }

    /** Court entry for an internal channel number, or null. */
    courtForChannel(channel) {
        return this.courts.find((c) => c.channel === Number(channel)) || null;
    }

    logout() {
        this.isAuthenticated = false;
        signOut(auth).then(() => {
            console.log(`${this.email} is now logged out.`);
            location.reload();
        }).catch((err) => {
            console.error("Logout error:", err);
            location.reload();
        });
    }
}
