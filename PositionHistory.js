/**
 * Position History Buffer for Lag Compensation
 * 
 * Stores a ring buffer of player positions indexed by timestamp.
 * Used for server-side time rewinding to check skill hits against
 * historical positions, compensating for network latency.
 */

class PositionHistory {
    constructor(bufferSize = 120) {
        this.bufferSize = bufferSize; // ~2 seconds at 60Hz
        this.buffer = []; // Array of { timestamp, positions: Map<socketId, {x, z, team, isDead}> }
        this.oldestIndex = 0;
        this.newestIndex = 0;
        this.count = 0;
    }
    
    /**
     * Record current positions of all players
     * @param {Map} players - Map of socketId -> player object
     */
    recordSnapshot(players) {
        const timestamp = Date.now();
        const positions = new Map();
        
        for (const [socketId, player] of players.entries()) {
            positions.set(socketId, {
                x: player.x,
                z: player.z,
                team: player.team,
                isDead: player.isDead
            });
        }
        
        const snapshot = { timestamp, positions };
        
        if (this.count < this.bufferSize) {
            this.buffer.push(snapshot);
            this.newestIndex = this.count;
            this.count++;
        } else {
            this.oldestIndex = (this.oldestIndex + 1) % this.bufferSize;
            this.newestIndex = (this.newestIndex + 1) % this.bufferSize;
            this.buffer[this.newestIndex] = snapshot;
        }
    }
    
    /**
     * Get player positions at a specific timestamp (or closest available)
     * @param {number} targetTimestamp - The timestamp to rewind to
     * @returns {Map<socketId, {x, z, team, isDead}>|null} - Player positions at that time
     */
    getPositionsAt(targetTimestamp) {
        if (this.count === 0) {
            return null;
        }
        
        let bestSnapshot = null;
        let bestTimeDiff = Infinity;
        
        for (let i = 0; i < this.count; i++) {
            const snapshot = this.buffer[i];
            const timeDiff = targetTimestamp - snapshot.timestamp;
            
            if (timeDiff >= 0 && timeDiff < bestTimeDiff) {
                bestTimeDiff = timeDiff;
                bestSnapshot = snapshot;
            }
        }
        
        if (!bestSnapshot && this.count > 0) {
            bestSnapshot = this.buffer[this.oldestIndex];
            console.log(`[LAG-COMP] Target timestamp ${targetTimestamp} is before oldest snapshot, using oldest`);
        }
        
        if (bestSnapshot) {
            console.log(`[LAG-COMP] Rewinding to ${bestSnapshot.timestamp} (${Date.now() - bestSnapshot.timestamp}ms ago, requested ${Date.now() - targetTimestamp}ms ago)`);
            return bestSnapshot.positions;
        }
        
        return null;
    }
    
    /**
     * Get the oldest and newest timestamps in the buffer
     * @returns {{oldest: number, newest: number}|null}
     */
    getTimeRange() {
        if (this.count === 0) {
            return null;
        }
        
        const oldest = this.buffer[this.oldestIndex].timestamp;
        const newest = this.buffer[this.newestIndex].timestamp;
        
        return { oldest, newest };
    }
    
    /**
     * Clear all history
     */
    clear() {
        this.buffer = [];
        this.oldestIndex = 0;
        this.newestIndex = 0;
        this.count = 0;
    }
    
    /**
     * Get statistics about the buffer
     * @returns {Object}
     */
    getStats() {
        const range = this.getTimeRange();
        return {
            count: this.count,
            bufferSize: this.bufferSize,
            utilizationPercent: (this.count / this.bufferSize * 100).toFixed(1),
            timeRangeMs: range ? range.newest - range.oldest : 0,
            oldestTimestamp: range ? range.oldest : null,
            newestTimestamp: range ? range.newest : null
        };
    }
}

module.exports = PositionHistory;
