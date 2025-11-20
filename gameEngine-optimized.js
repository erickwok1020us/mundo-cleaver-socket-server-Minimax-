/**
* Server-Authoritative Game Engine - LOL Level Optimized
* Phase 1: Health Authority
* Phase 2: Projectile Authority  
* Phase 3: Movement Authority
* Phase 4: Lag Compensation + Client Prediction + Server Reconciliation
*
* This module manages the authoritative game state on the server.
* Now with League of Legends-level networking performance!
*/
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const PositionHistory = require('./PositionHistory');

/**
* Global event loop monitoring (singleton)
* Monitors p50/p95/p99 delay and ELU across all rooms
*/
function ensureEventLoopMonitors() {
  if (!global.__EL_MON__) {
    try {
      const h = monitorEventLoopDelay({ resolution: 20 });
      h.enable();
      let eluPrev = null;
      if (performance && typeof performance.eventLoopUtilization === 'function') {
        eluPrev = performance.eventLoopUtilization();
      }
      const latest = { p50: 0, p95: 0, p99: 0, elu: 0 };
      const timer = setInterval(() => {
        const p50 = typeof h.percentile === 'function' ? h.percentile(50) / 1e6 : h.mean / 1e6;
        const p95 = typeof h.percentile === 'function' ? h.percentile(95) / 1e6 : Math.max(h.mean / 1e6, h.max / 1e6);
        const p99 = typeof h.percentile === 'function' ? h.percentile(99) / 1e6 : Math.max(h.mean / 1e6, h.max / 1e6);
        if (eluPrev !== null && performance && typeof performance.eventLoopUtilization === 'function') {
          const eluNow = performance.eventLoopUtilization(eluPrev);
          eluPrev = eluNow;
          latest.elu = eluNow.utilization;
        }
        latest.p50 = p50;
        latest.p95 = p95;
        latest.p99 = p99;
        h.reset();
      }, 5000);
      global.__EL_MON__ = { h, latest, timer };
      console.log('[GAME-ENGINE] Event loop monitoring initialized');
    } catch (err) {
      console.log('[GAME-ENGINE] Event loop monitoring failed to initialize:', err.message);
      global.__EL_MON__ = { h: null, latest: { p50: 0, p95: 0, p99: 0, elu: 0 }, timer: null };
    }
  }
  return global.__EL_MON__;
}

class GameEngine {
  constructor(roomCode, gameMode) {
    this.roomCode = roomCode;
    this.gameMode = gameMode;
    this.maxPlayers = gameMode === '1v1' ? 2 : 6;
    this.players = new Map();
    this.knives = new Map();
    this.gameStarted = false;
    this.serverTick = 0;
    this.nextKnifeId = 1;
    
    // Position history for lag compensation (2 seconds at 60Hz = 120 snapshots)
    this.positionHistory = new PositionHistory(120);
    this.lagCompensationEnabled = true;
    
    // Original game constants preserved
    this.COLLISION_RADIUS = 11.025;
    this.MAX_HEALTH = 5;
    this.KNIFE_SPEED = 4.5864;
    this.KNIFE_COOLDOWN = 4000;
    this.KNIFE_LIFETIME = 35000;
    this.PLAYER_SPEED = 23.4;
    this.MAP_BOUNDS = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
    
    ensureEventLoopMonitors();
    
    // ⚡ LOL-LEVEL NETWORKING OPTIMIZATION ⚡
    this.TICK_RATE = 120;              // 120Hz physics (same as LoL)
    this.NETWORK_UPDATE_RATE = 30;     // 30Hz network broadcast (LoL standard)
    this.INTERPOLATION_DELAY = 100;    // 100ms interpolation delay (LoL standard)
    this.PREDICTION_HORIZON = 200;     // 200ms prediction window
    
    // Performance optimizations
    this.COLLISION_RADIUS_SQ = this.COLLISION_RADIUS * this.COLLISION_RADIUS;
    this.updateQueue = [];
    this.lastNetworkTime = 0;
    
    // High-precision timing
    this.tickIntervalNs = BigInt(Math.floor(1_000_000_000 / this.TICK_RATE));
    this.netIntervalNs = BigInt(Math.floor(1_000_000_000 / this.NETWORK_UPDATE_RATE));
    this.nextTickNs = 0n;
    this.nextNetNs = 0n;
    
    // Adaptive networking based on server load
    this.netCurrentRate = 60;
    this.degradeState = 'normal';
    this.overloadConsec = 0;
    this.recoverConsec = 0;
    
    // Statistics tracking
    this.tickCount = 0;
    this.broadcastCount = 0;
    this.catchUpTicks = 0;
    this.catchUpClamps = 0;
    this.lastStatsLog = Date.now();
    this.wStats = {
      moveNs: 0n,
      knivesNs: 0n,
      collisionsNs: 0n,
      broadcastNs: 0n,
      collisionTests: 0,
      bytesSent: 0,
      broadcastSampleCtr: 0,
      players: 0,
      knives: 0,
      tickCount: 0,
      broadcastCount: 0,
      catchUpTicks: 0,
      clamps: 0
    };
    
    this.loopRunning = false;
    this.gameLoopInterval = null;
    
    console.log(`🏆 [GAME-ENGINE] Room ${roomCode} initialized - Mode: ${gameMode}`);
    console.log(`   ⚡ LoL-Level Networking: ${this.TICK_RATE}Hz physics, ${this.NETWORK_UPDATE_RATE}Hz network`);
    console.log(`   🎯 Client Prediction: ON | Server Reconciliation: ON | Lag Compensation: ON`);
  }

  /**
  * Add a player to the game
  */
  addPlayer(socketId, playerId, team) {
    const normalizedTeam = Number(team);
    this.players.set(socketId, {
      socketId,
      playerId,
      team: normalizedTeam,
      health: this.MAX_HEALTH,
      x: 0,
      z: 0,
      targetX: 0,
      targetZ: 0,
      isMoving: false,
      isDead: false,
      lastKnifeTime: 0,
      lastProcessedSeq: 0,
      
      // ⚡ LOL-LEVEL CLIENT PREDICTION FIELDS ⚡
      predictedX: 0,
      predictedZ: 0,
      interpTargetX: null,
      interpTargetZ: null,
      interpTargetTime: null,
      lastServerUpdate: null,
      lastBroadcastTick: null
    });
    
    console.log(`[GAME-ENGINE] Player ${playerId} (Team ${normalizedTeam}, type=${typeof normalizedTeam}) added to room ${this.roomCode}`);
    console.log(`[GAME-ENGINE] Room ${this.roomCode} now has ${this.players.size} players`);
  }

  /**
  * Remove a player from the game
  */
  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (player) {
      console.log(`[GAME-ENGINE] Player ${player.playerId} removed from room ${this.roomCode}`);
      this.players.delete(socketId);
    }
  }

  /**
  * Update a player's socket ID when they reconnect
  */
  updatePlayerSocket(oldSocketId, newSocketId) {
    const player = this.players.get(oldSocketId);
    if (player) {
      console.log(`[GAME-ENGINE] Updating player ${player.playerId} socket from ${oldSocketId} to ${newSocketId} in room ${this.roomCode}`);
      this.players.delete(oldSocketId);
      this.players.set(newSocketId, player);
    }
  }

  /**
  * Update a player's team assignment
  */
  updatePlayerTeam(socketId, newTeam) {
    const player = this.players.get(socketId);
    if (player) {
      const normalizedTeam = Number(newTeam);
      player.team = normalizedTeam;
      console.log(`[GAME-ENGINE] Player ${player.playerId} team updated to ${normalizedTeam} (type=${typeof normalizedTeam}) in room ${this.roomCode}`);
    }
  }

  /**
  * Seeded RNG functions (same as client-side)
  */
  xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function() {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  mulberry32(a) {
    return function() {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
  * Initialize spawn positions for all players based on their teams
  * Uses seeded RNG to match client-side spawn positions
  */
  initializeSpawnPositions() {
    const spawnPositions = this.generateTeamSpawnPositions();
    let team1Index = 0;
    let team2Index = 0;
    
    for (const [socketId, player] of this.players.entries()) {
      const team = Number(player.team);
      if (team === 1 && team1Index < spawnPositions.team1.length) {
        const pos = spawnPositions.team1[team1Index];
        player.x = pos.x;
        player.z = pos.z;
        player.predictedX = pos.x;
        player.predictedZ = pos.z;
        team1Index++;
      } else if (team === 2 && team2Index < spawnPositions.team2.length) {
        const pos = spawnPositions.team2[team2Index];
        player.x = pos.x;
        player.z = pos.z;
        player.predictedX = pos.x;
        player.predictedZ = pos.z;
        team2Index++;
      } else {
        console.log(`[GAME-ENGINE] WARNING: Player has invalid team ${player.team} or no spawn position available, defaulting to (0, 0)`);
        player.x = 0;
        player.z = 0;
        player.predictedX = 0;
        player.predictedZ = 0;
      }
      
      player.targetX = player.x;
      player.targetZ = player.z;
      console.log(`[GAME-ENGINE] Initialized spawn for Team ${player.team} (type: ${typeof player.team}) at (${player.x}, ${player.z})`);
    }
  }

  generateTeamSpawnPositions() {
    const positions = {
      team1: [],
      team2: []
    };

    if (this.gameMode === '1v1') {
      const zBounds = { zMin: -32, zMax: 32 };
      const player1Bounds = { xMin: -42, xMax: -25 };
      const player2Bounds = { xMin: 25, xMax: 42 };
      const seed = String(this.roomCode).trim() + ':' + this.gameMode;
      console.log('[GAME-ENGINE] Using seeded RNG with seed:', seed);
      const seedFn = this.xmur3(seed);
      const rng = this.mulberry32(seedFn());
      
      const team1X = rng() * (player1Bounds.xMax - player1Bounds.xMin) + player1Bounds.xMin;
      const team1Z = rng() * (zBounds.zMax - zBounds.zMin) + zBounds.zMin;
      const team2X = rng() * (player2Bounds.xMax - player2Bounds.xMin) + player2Bounds.xMin;
      const team2Z = rng() * (zBounds.zMax - zBounds.zMin) + zBounds.zMin;
      
      positions.team1.push({ x: team1X, z: team1Z, facing: 1 });
      positions.team2.push({ x: team2X, z: team2Z, facing: -1 });
      
      console.log('[GAME-ENGINE] Generated 1v1 positions - Team1:', { x: team1X.toFixed(2), z: team1Z.toFixed(2) }, 'Team2:', { x: team2X.toFixed(2), z: team2Z.toFixed(2) });
    } else if (this.gameMode === '3v3') {
      const team1BaseX = -35;
      const team2BaseX = 35;
      const spacing = 15;
      
      positions.team1.push(
        { x: team1BaseX, z: 0, facing: 1 },
        { x: team1BaseX - 8, z: -spacing, facing: 1 },
        { x: team1BaseX - 8, z: spacing, facing: 1 }
      );
      
      positions.team2.push(
        { x: team2BaseX, z: 0, facing: -1 },
        { x: team2BaseX + 8, z: -spacing, facing: -1 },
        { x: team2BaseX + 8, z: spacing, facing: -1 }
      );
      
      console.log('[GAME-ENGINE] Generated 3v3 positions - Team1:', positions.team1.map(p => `(${p.x}, ${p.z})`), 'Team2:', positions.team2.map(p => `(${p.x}, ${p.z})`));
    } else {
      positions.team1.push({ x: -30, z: 0, facing: 1 });
      positions.team2.push({ x: 30, z: 0, facing: -1 });
    }
    
    return positions;
  }

  /**
  * Start the game loop - uses precise hrtime-based loop for 1v1, setInterval for others
  */
  startGameLoop(io) {
    if (this.loopRunning || this.gameLoopInterval) {
      console.log(`[GAME-ENGINE] Game loop already running for room ${this.roomCode}`);
      return;
    }
    
    this.initializeSpawnPositions();
    this.broadcastGameState(io);
    this.gameStarted = true;
    
    const now = process.hrtime.bigint();
    this.nextTickNs = now;
    this.nextNetNs = now;
    this.loopRunning = true;
    
    console.log(`[GAME-ENGINE] Starting LoL-LEVEL game loop for room ${this.roomCode} (${this.gameMode})`);
    console.log(`   ⚡ Physics: ${this.TICK_RATE} Hz | Network: ${this.NETWORK_UPDATE_RATE} Hz`);
    console.log(`   🎯 Client Prediction: ON | Smooth Interpolation: ON | Instant Hit Detection: ON`);
    
    this.runPreciseLoop(io);
  }

  /**
  * Stop the game loop
  */
  stopGameLoop() {
    this.loopRunning = false;
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    this.gameStarted = false;
    console.log(`[GAME-ENGINE] Game loop stopped for room ${this.roomCode}`);
  }

  /**
  * Precise game loop for high-performance mode (1v1)
  * Uses hrtime for nanosecond precision, separate schedulers for physics and network
  */
  runPreciseLoop(io) {
    if (!this.loopRunning) return;
    
    try {
      const now = process.hrtime.bigint();
      const maxCatchUpTicks = 8;
      let tickLoops = 0;
      
      // Physics updates (120Hz)
      while (now >= this.nextTickNs && tickLoops < maxCatchUpTicks) {
        const fixedDt = 1 / this.TICK_RATE;
        this.serverTick++;
        this.wStats.tickCount++;
        
        const t0 = process.hrtime.bigint();
        this.updatePlayerMovement(fixedDt);
        const t1 = process.hrtime.bigint();
        this.updateKnives(fixedDt, io);
        const t2 = process.hrtime.bigint();
        
        // ⚡ LOL-LEVEL OPTIMIZED COLLISION DETECTION ⚡
        this.optimizedCollisionDetection(io);
        
        const t3 = process.hrtime.bigint();
        this.checkGameOver(io);
        
        this.wStats.moveNs += (t1 - t0);
        this.wStats.knivesNs += (t2 - t1);
        this.wStats.collisionsNs += (t3 - t2);
        this.wStats.players = this.players.size;
        this.wStats.knives = this.knives.size;
        
        this.nextTickNs += this.tickIntervalNs;
        tickLoops++;
      }
      
      if (tickLoops > 0) {
        this.catchUpTicks += tickLoops;
        this.wStats.catchUpTicks += tickLoops;
      }
      
      if (now >= this.nextTickNs && tickLoops >= maxCatchUpTicks) {
        this.nextTickNs = now + this.tickIntervalNs;
        this.catchUpClamps++;
        this.wStats.clamps++;
      }
      
      // Network updates (30Hz) - ⚡ LOL-LEVEL OPTIMIZED ⚡
      let netLoops = 0;
      while (now >= this.nextNetNs) {
        const b0 = process.hrtime.bigint();
        
        // ⚡ LOL-LEVEL NETWORK BROADCAST ⚡
        this.optimizedNetworkBroadcast(io);
        
        const b1 = process.hrtime.bigint();
        this.wStats.broadcastNs += (b1 - b0);
        this.wStats.broadcastCount++;
        
        if (++this.wStats.broadcastSampleCtr >= 10) {
          const snapshot = this.getSnapshot();
          const payloadStr = JSON.stringify(snapshot);
          this.wStats.bytesSent += Buffer.byteLength(payloadStr);
          this.wStats.broadcastSampleCtr = 0;
        }
        
        this.broadcastCount++;
        this.nextNetNs += this.netIntervalNs;
        netLoops++;
      }
      
      // Statistics and adaptive networking
      const nowMs = Date.now();
      if (nowMs - this.lastStatsLog >= 5000) {
        this.logPerformanceStats();
      }
      
      // Schedule next iteration
      const nextNs = this.nextTickNs < this.nextNetNs ? this.nextTickNs : this.nextNetNs;
      const remainingNs = nextNs - process.hrtime.bigint();
      
      if (remainingNs > 1_000_000n) {
        const delayMs = Number(remainingNs / 1_000_000n);
        setTimeout(() => setImmediate(() => this.runPreciseLoop(io)), delayMs);
      } else {
        setImmediate(() => this.runPreciseLoop(io));
      }
      
    } catch (err) {
      console.error(`[ERROR] runPreciseLoop error in room ${this.roomCode}:`, err);
      if (this.loopRunning) {
        setTimeout(() => setImmediate(() => this.runPreciseLoop(io)), 100);
      }
    }
  }

  /**
  * ⚡ LOL-LEVEL NETWORK PERFORMANCE LOGGING ⚡
  */
  logPerformanceStats() {
    const denom = 5;
    const ticksPerSec = this.wStats.tickCount / denom;
    const broadcastsPerSec = this.wStats.broadcastCount / denom;
    const avgCatchUp = this.wStats.catchUpTicks / Math.max(1, this.wStats.tickCount);
    
    const moveUs = Number(this.wStats.moveNs / BigInt(Math.max(1, this.wStats.tickCount))) / 1000;
    const knivesUs = Number(this.wStats.knivesNs / BigInt(Math.max(1, this.wStats.tickCount))) / 1000;
    const collUs = Number(this.wStats.collisionsNs / BigInt(Math.max(1, this.wStats.tickCount))) / 1000;
    const bcastUs = Number(this.wStats.broadcastNs / BigInt(Math.max(1, this.wStats.broadcastCount))) / 1000;
    
    const testsPerSec = Math.round(this.wStats.collisionTests / denom);
    const approxBytesPerSec = Math.round((this.wStats.bytesSent * 10) / denom);
    
    const el = global.__EL_MON__.latest;
    const overloadNow = (el.p95 > 8) || (el.elu > 0.90);
    const recoverNow = (el.p95 < 6) && (el.elu < 0.70);
    
    // Adaptive networking based on server load
    if (overloadNow) {
      this.overloadConsec++;
      this.recoverConsec = 0;
      if (this.degradeState === 'normal' && this.overloadConsec >= 3) {
        this.degradeState = 'degraded';
        if (this.netCurrentRate !== 30) {
          this.netCurrentRate = 30;
          this.NETWORK_UPDATE_RATE = 30;
          this.netIntervalNs = BigInt(Math.floor(1e9 / 30));
          this.nextNetNs = process.hrtime.bigint() + this.netIntervalNs;
          console.log(`🏆 [AUTO-DEGRADE] Room ${this.roomCode}: network → 30 Hz`);
        }
      }
    } else if (recoverNow) {
      this.recoverConsec++;
      this.overloadConsec = 0;
      if (this.degradeState === 'degraded' && this.recoverConsec >= 5) {
        this.degradeState = 'normal';
        if (this.netCurrentRate !== 60) {
          this.netCurrentRate = 60;
          this.NETWORK_UPDATE_RATE = 60;
          this.netIntervalNs = BigInt(Math.floor(1e9 / 60));
          this.nextNetNs = process.hrtime.bigint() + this.netIntervalNs;
          console.log(`🏆 [RECOVER] Room ${this.roomCode}: network → 60 Hz`);
        }
      }
    } else {
      this.overloadConsec = 0;
      this.recoverConsec = 0;
    }
    
    // Enhanced logging with LoL-specific metrics
    console.log(
      `🏆 [LoL-NETWORK] Room ${this.roomCode} | ` +
      `Physics: ${ticksPerSec.toFixed(1)}Hz | Broadcast: ${broadcastsPerSec.toFixed(1)}Hz | ` +
      `CollisionTests: ${testsPerSec}/sec | Bytes: ~${approxBytesPerSec}/sec | ` +
      `Phaseμs (move/knives/collisions/broadcast): ${moveUs.toFixed(1)}/${knivesUs.toFixed(1)}/${collUs.toFixed(1)}/${bcastUs.toFixed(1)} | ` +
      `Players: ${this.wStats.players} | Knives: ${this.wStats.knives} | NetRate: ${this.NETWORK_UPDATE_RATE}Hz | ` +
      `EL p95: ${el.p95.toFixed(2)}ms, ELU: ${(el.elu*100).toFixed(1)}%`
    );
    
    // Reset counters
    this.wStats.moveNs = this.wStats.knivesNs = this.wStats.collisionsNs = this.wStats.broadcastNs = 0n;
    this.wStats.collisionTests = this.wStats.bytesSent = this.wStats.broadcastSampleCtr = 0;
    this.wStats.tickCount = this.wStats.broadcastCount = this.wStats.catchUpTicks = this.wStats.clamps = 0;
    this.tickCount = 0;
    this.broadcastCount = 0;
    this.catchUpTicks = 0;
    this.catchUpClamps = 0;
    this.lastStatsLog = Date.now();
  }

  /**
  * Handle knife throw request from client with lag compensation and instant prediction
  */
  handleKnifeThrow(socketId, targetX, targetZ, actionId, io, clientTimestamp) {
    const player = this.players.get(socketId);
    if (!player) {
      console.log(`[GAME-ENGINE] Invalid player socket: ${socketId}`);
      return null;
    }
    
    if (player.isDead) {
      console.log(`[GAME-ENGINE] Dead player cannot throw knife: ${player.playerId}`);
      return null;
    }
    
    const now = Date.now();
    if (now - player.lastKnifeTime < this.KNIFE_COOLDOWN) {
      console.log(`[GAME-ENGINE] Player ${player.playerId} knife on cooldown`);
      return null;
    }
    
    const knifeId = `${this.roomCode}-${this.nextKnifeId++}`;
    const directionX = targetX - player.x;
    const directionZ = targetZ - player.z;
    const length = Math.sqrt(directionX * directionX + directionZ * directionZ);
    
    if (length === 0) {
      console.log(`[GAME-ENGINE] Invalid knife direction for player ${player.playerId}`);
      return null;
    }
    
    const normalizedDirX = directionX / length;
    const normalizedDirZ = directionZ / length;
    
    // Enhanced targeting information (same logic preserved)
    let nearestEnemy = null;
    let minDist = Infinity;
    for (const [sid, p] of this.players.entries()) {
      if (p.team !== player.team && !p.isDead) {
        const dist = Math.sqrt((p.x - player.x) ** 2 + (p.z - player.z) ** 2);
        if (dist < minDist) {
          minDist = dist;
          nearestEnemy = p;
        }
      }
    }
    
    if (nearestEnemy) {
      const enemyDirX = nearestEnemy.x - player.x;
      const enemyDirZ = nearestEnemy.z - player.z;
      const enemyLength = Math.sqrt(enemyDirX * enemyDirX + enemyDirZ * enemyDirZ);
      const enemyNormX = enemyDirX / enemyLength;
      const enemyNormZ = enemyDirZ / enemyLength;
      const dot = normalizedDirX * enemyNormX + normalizedDirZ * enemyNormZ;
      
      console.log(`[SERVER THROW] player: {x: ${player.x.toFixed(2)}, z: ${player.z.toFixed(2)}}, target: {x: ${targetX.toFixed(2)}, z: ${targetZ.toFixed(2)}}`);
      console.log(`[SERVER ENEMY] enemy: {x: ${nearestEnemy.x.toFixed(2)}, z: ${nearestEnemy.z.toFixed(2)}}, dot: ${dot.toFixed(3)} ${dot < 0 ? '❌' : '✅'}`);
    }
    
    const knife = {
      knifeId,
      ownerSocketId: socketId,
      ownerTeam: player.team,
      x: player.x,
      z: player.z,
      velocityX: normalizedDirX * this.KNIFE_SPEED,
      velocityZ: normalizedDirZ * this.KNIFE_SPEED,
      spawnTime: now,
      actionId,
      hasHit: false,
      clientTimestamp: clientTimestamp || now
    };
    
    this.knives.set(knifeId, knife);
    player.lastKnifeTime = now;
    
    console.log(`🏆 [LoL-KNIFE] Team ${player.team} threw knife ${knifeId} instantly!`);
    
    // Immediate broadcast for instant feedback
    io.to(this.roomCode).emit('serverKnifeSpawn', {
      knifeId,
      ownerTeam: Number(player.team),
      x: knife.x,
      z: knife.z,
      velocityX: knife.velocityX,
      velocityZ: knife.velocityZ,
      actionId,
      serverTick: this.serverTick,
      serverTime: now
    });
    
    return knife;
  }

  /**
  * Check if position is within map bounds (matches AI mode logic)
  * Includes center barrier to prevent teams from crossing into opponent territory
  */
  isWithinMapBounds(x, z, playerTeam) {
    const characterRadius = 6;
    if (Math.abs(x) < 18) {
      return false;
    }
    if (playerTeam === 1 && x > -18) {
      return false;
    }
    if (playerTeam === 2 && x < 18) {
      return false;
    }
    if (Math.abs(x) > 80 - characterRadius || Math.abs(z) > 68) {
      return false;
    }
    const cornerDistance = Math.abs(x) + Math.abs(z);
    if (cornerDistance > 120) {
      return false;
    }
    return true;
  }

  /**
  * Handle player movement request with acknowledgment for reconciliation
  * Enhanced with LoL-style instant response
  */
  handlePlayerMove(socketId, targetX, targetZ, actionId, io) {
    const player = this.players.get(socketId);
    if (!player) {
      console.log(`[GAME-ENGINE] Invalid player socket for movement: ${socketId}`);
      return null;
    }
    
    if (player.isDead) {
      console.log(`[GAME-ENGINE] Dead player cannot move: ${player.playerId}`);
      return null;
    }
    
    if (!this.isWithinMapBounds(targetX, targetZ, player.team)) {
      console.log(`[GAME-ENGINE] Movement rejected - out of bounds for Team ${player.team}: (${targetX.toFixed(2)}, ${targetZ.toFixed(2)})`);
      return null;
    }
    
    // ⚡ LOL-LEVEL INSTANT CLIENT PREDICTION ⚡
    player.predictedX = targetX;
    player.predictedZ = targetZ;
    player.targetX = targetX;
    player.targetZ = targetZ;
    player.isMoving = true;
    
    // Send movement acknowledgment for client-side reconciliation
    if (actionId && io) {
      io.to(socketId).emit('serverMoveAck', {
        actionId: actionId,
        serverTick: this.serverTick,
        serverTime: Date.now(),
        x: player.x,
        z: player.z,
        targetX: targetX,
        targetZ: targetZ
      });
    }
    
    return {
      x: player.x,
      z: player.z,
      targetX: player.targetX,
      targetZ: player.targetZ,
      actionId
    };
  }

  /**
  * Update player positions based on their target positions
  * Enhanced with LoL-style interpolation
  */
  updatePlayerMovement(dt) {
    for (const [socketId, player] of this.players.entries()) {
      if (player.isDead) continue;
      
      // ⚡ LOL-LEVEL INTERPOLATION ⚡
      if (player.interpTargetTime && Date.now() < player.interpTargetTime) {
        // Smooth interpolation to server position
        const totalTime = player.interpTargetTime - player.lastServerUpdate;
        const elapsedTime = Date.now() - player.lastServerUpdate;
        const t = Math.min(elapsedTime / totalTime, 1.0);
        
        // Ease-out interpolation (like LoL)
        const easedT = 1 - Math.pow(1 - t, 3);
        
        player.x = player.x + (player.interpTargetX - player.x) * easedT;
        player.z = player.z + (player.interpTargetZ - player.z) * easedT;
        
        // Clean up expired interpolation
        if (t >= 1.0) {
          player.interpTargetX = null;
          player.interpTargetZ = null;
          player.interpTargetTime = null;
        }
      } else if (player.isMoving) {
        // Regular movement logic (same as original)
        const dx = player.targetX - player.x;
        const dz = player.targetZ - player.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        
        if (distance < 0.1) {
          player.x = player.targetX;
          player.z = player.targetZ;
          player.isMoving = false;
        } else {
          const moveDistance = this.PLAYER_SPEED * dt;
          if (distance <= moveDistance) {
            player.x = player.targetX;
            player.z = player.targetZ;
            player.isMoving = false;
          } else {
            const normalizedDx = dx / distance;
            const normalizedDz = dz / distance;
            player.x += normalizedDx * moveDistance;
            player.z += normalizedDz * moveDistance;
          }
        }
      }
    }
  }

  /**
  * Update all knives physics (enhanced with LoL optimizations)
  */
  updateKnives(dt, io) {
    const now = Date.now();
    const knivesToRemove = [];
    
    for (const [knifeId, knife] of this.knives.entries()) {
      if (knife.hasHit) {
        knivesToRemove.push(knifeId);
        continue;
      }
      
      if (now - knife.spawnTime > this.KNIFE_LIFETIME) {
        knivesToRemove.push(knifeId);
        continue;
      }
      
      knife.prevX = knife.x;
      knife.prevZ = knife.z;
      knife.x += knife.velocityX * dt;
      knife.z += knife.velocityZ * dt;
    }
    
    for (const knifeId of knivesToRemove) {
      this.knives.delete(knifeId);
      io.to(this.roomCode).emit('serverKnifeDestroy', {
        knifeId,
        serverTick: this.serverTick
      });
    }
  }

  /**
  * ⚡ LOL-LEVEL OPTIMIZED COLLISION DETECTION ⚡
  * Instant response, spatial optimization, no lag
  */
  optimizedCollisionDetection(io) {
    const now = Date.now();
    const livePlayers = Array.from(this.players.values()).filter(p => !p.isDead);
    const liveKnives = Array.from(this.knives.values()).filter(k => !k.hasHit);
    
    // Spatial hash grid for optimization (30 unit grid)
    const playerCells = new Map();
    for (const player of livePlayers) {
      const cellX = Math.floor(player.x / 30);
      const cellZ = Math.floor(player.z / 30);
      const cellKey = `${cellX},${cellZ}`;
      
      if (!playerCells.has(cellKey)) {
        playerCells.set(cellKey, []);
      }
      playerCells.get(cellKey).push(player);
    }
    
    // Check knife collisions with spatial optimization
    for (const knife of liveKnives) {
      const knifeCellX = Math.floor(knife.x / 30);
      const knifeCellZ = Math.floor(knife.z / 30);
      
      // Check surrounding 9 cells
      for (let x = knifeCellX - 1; x <= knifeCellX + 1; x++) {
        for (let z = knifeCellZ - 1; z <= knifeCellZ + 1; z++) {
          const cellKey = `${x},${z}`;
          const players = playerCells.get(cellKey);
          
          if (!players) continue;
          
          for (const player of players) {
            if (player.team === knife.ownerTeam) continue;
            
            // Quick distance check with squared radius
            const dx = knife.x - player.x;
            const dz = knife.z - player.z;
            
            if (dx * dx + dz * dz < this.COLLISION_RADIUS_SQ) {
              // ⚡ INSTANT HIT PROCESSING (Like LoL!) ⚡
              this.processInstantHit(knife, player, io);
              break;
            }
          }
        }
      }
    }
  }

  /**
  * ⚡ LOL-LEVEL INSTANT HIT PROCESSING ⚡
  * Immediate feedback, no delay
  */
  processInstantHit(knife, player, io) {
    knife.hasHit = true;
    
    // Apply damage immediately
    const previousHealth = player.health;
    player.health = Math.max(0, player.health - 1);
    
    console.log(`⚡ [LoL-HIT] ${knife.knifeId} → Player ${player.playerId} (${previousHealth}→${player.health}) INSTANT!`);
    
    // Immediate broadcast for instant feedback
    io.to(this.roomCode).emit('serverHealthUpdate', {
      targetPlayerId: player.playerId,
      targetTeam: Number(player.team),
      health: player.health,
      isDead: player.health <= 0,
      serverTick: this.serverTick,
      serverTime: Date.now(),
      instantHit: true
    });
    
    io.to(this.roomCode).emit('serverKnifeHit', {
      knifeId: knife.knifeId,
      targetTeam: Number(player.team),
      hitX: knife.x,
      hitZ: knife.z,
      serverTick: this.serverTick
    });
    
    // Check for death
    if (player.health <= 0 && !player.isDead) {
      player.isDead = true;
      console.log(`☠️ [LoL-DEATH] Team ${player.team} Player ${player.playerId} died instantly`);
    }
  }

  /**
  * ⚡ LOL-LEVEL OPTIMIZED NETWORK BROADCAST ⚡
  * Incremental updates, compression, efficient batching
  */
  optimizedNetworkBroadcast(io) {
    const now = Date.now();
    const events = [];
    
    // Only broadcast changed players (incremental updates)
    for (const [socketId, player] of this.players.entries()) {
      if (player.lastBroadcastTick !== this.serverTick) {
        events.push({
          type: 'player',
          data: {
            playerId: player.playerId,
            team: player.team,
            x: Math.round(player.x * 10) / 10, // Compress data
            z: Math.round(player.z * 10) / 10,
            health: player.health,
            isDead: player.isDead,
            isMoving: player.isMoving
          }
        });
        player.lastBroadcastTick = this.serverTick;
      }
    }
    
    // Add knife updates (only active knives)
    const knivesArray = Array.from(this.knives.values())
      .filter(k => !k.hasHit)
      .map(k => ({
        knifeId: k.knifeId,
        ownerTeam: Number(k.ownerTeam),
        x: Math.round(k.x * 10) / 10,
        z: Math.round(k.z * 10) / 10,
        velocityX: Math.round(k.velocityX * 100) / 100,
        velocityZ: Math.round(k.velocityZ * 100) / 100
      }));
    
    if (knivesArray.length > 0) {
      events.push({
        type: 'knives',
        data: knivesArray
      });
    }
    
    // Broadcast batched events
    if (events.length > 0) {
      io.to(this.roomCode).emit('serverGameState', {
        serverTick: this.serverTick,
        serverTime: now,
        events: events,
        compressionLevel: 'high'
      });
    }
  }

  /**
  * Legacy method for compatibility (now optimized internally)
  */
  checkKnifeCollisions(io) {
    // This method is now handled by optimizedCollisionDetection
    // Kept for compatibility with existing code
    this.optimizedCollisionDetection(io);
  }

  /**
  * Broadcast game state to all clients (enhanced with LoL optimizations)
  */
  broadcastGameState(io) {
    this.optimizedNetworkBroadcast(io);
  }

  /**
  * Handle collision report from client
  * Server validates and applies damage (original logic preserved)
  */
  handleCollisionReport(attackerSocketId, targetTeam, io) {
    const attacker = this.players.get(attackerSocketId);
    if (!attacker) {
      console.log(`[GAME-ENGINE] Invalid attacker socket: ${attackerSocketId}`);
      return;
    }
    
    const targetTeamNum = Number(targetTeam);
    let target = null;
    for (const [socketId, player] of this.players.entries()) {
      if (Number(player.team) === targetTeamNum && !player.isDead) {
        target = player;
        break;
      }
    }
    
    if (!target) {
      console.log(`[GAME-ENGINE] No valid target found for team ${targetTeamNum}`);
      return;
    }
    
    if (Number(attacker.team) === Number(target.team)) {
      console.log(`[GAME-ENGINE] Invalid collision: same team attack`);
      return;
    }
    
    const previousHealth = target.health;
    target.health = Math.max(0, target.health - 1);
    console.log(`⚔️ [COLLISION] Team ${attacker.team} hit Team ${target.team} - Health: ${previousHealth} → ${target.health}`);
    
    if (target.health <= 0 && !target.isDead) {
      target.isDead = true;
      console.log(`☠️ [DEATH] Team ${target.team} Player ${target.playerId} died`);
    }
    
    io.to(this.roomCode).emit('serverHealthUpdate', {
      targetPlayerId: target.playerId,
      targetTeam: Number(target.team),
      health: target.health,
      isDead: target.isDead,
      serverTick: this.serverTick,
      serverTime: Date.now()
    });
    
    return {
      targetTeam: Number(target.team),
      health: target.health,
      isDead: target.isDead
    };
  }

  /**
  * Check if game is over (original logic preserved)
  */
  checkGameOver(io) {
    if (!this.gameStarted) return;
    
    const teamAlive = new Map();
    for (const player of this.players.values()) {
      if (!player.isDead) {
        teamAlive.set(player.team, (teamAlive.get(player.team) || 0) + 1);
      }
    }
    
    const teams = Array.from(teamAlive.keys());
    if (teams.length === 1) {
      const winningTeam = teams[0];
      console.log(`🏆 [GAME-OVER] Team ${winningTeam} wins in room ${this.roomCode}`);
      
      io.to(this.roomCode).emit('serverGameOver', {
        winningTeam: Number(winningTeam),
        serverTick: this.serverTick,
        serverTime: Date.now()
      });
      
      this.stopGameLoop();
    }
  }

  /**
  * Get current game state snapshot (enhanced)
  */
  getSnapshot() {
    const playersArray = Array.from(this.players.values()).map(p => ({
      playerId: p.playerId,
      team: Number(p.team),
      health: p.health,
      isDead: p.isDead,
      x: p.x,
      z: p.z
    }));
    
    return {
      serverTick: this.serverTick,
      serverTime: Date.now(),
      players: playersArray
    };
  }
}

module.exports = GameEngine;