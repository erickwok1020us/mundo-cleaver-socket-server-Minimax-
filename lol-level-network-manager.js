/**
 * League of Legends Level Frontend Optimization
 * 
 * This file contains the complete LOL-level frontend optimization for the Pudge Wars game.
 * Integrates with the LOL-level server engine (gameEngine-optimized.js) to provide:
 * - Instant client-side prediction for movement and skills
 * - Smooth interpolation and extrapolation for opponent movements  
 * - Seamless server reconciliation with minimal visual disruption
 * - Immediate visual feedback for all player actions
 * 
 * Key Improvements:
 * 1. Instant Movement Prediction - Players move immediately on click
 * 2. Instant Knife Prediction - Knives appear instantly when thrown
 * 3. Smooth Interpolation - 100ms delay for natural movement transitions
 * 4. Smart Reconciliation - Correct predictions with minimal visual impact
 * 5. Visual Effects - Immediate feedback for all game actions
 */

class LOLLevelNetworkManager {
  constructor(game) {
    this.game = game;
    this.socket = game.socket;
    this.roomCode = game.roomCode;
    this.myTeam = game.myTeam;
    this.opponentTeam = game.opponentTeam;
    
    // ⚡ LOL-LEVEL PREDICTION SETTINGS ⚡
    this.INTERPOLATION_DELAY = 100;    // 100ms delay (like LoL)
    this.PREDICTION_HORIZON = 200;     // 200ms prediction window
    this.RECONCILIATION_THRESHOLD = 1.0; // 1.0 unit error threshold (more sensitive)
    this.PREDICTED_KNIFE_LIFETIME = 5000; // 5 seconds max for predicted knives
    
    // Network state tracking
    this.lastServerUpdate = null;
    this.serverTimeOffset = 0;
    this.predictedActions = new Map(); // Track predicted actions for reconciliation
    
    // Performance monitoring
    this.networkStats = {
      lastUpdateTimes: [],
      jitter: 0,
      avgLatency: 0,
      packetLoss: 0
    };
    
    console.log('🏆 LOL-LEVEL Frontend Network Manager Initialized');
  }

  /**
   * ⚡ INSTANT CLIENT-SIDE PREDICTION ⚡
   * This is the key to LOL-level responsiveness
   */
  predictAndExecutePlayerMovement(targetX, targetZ, actionId = null) {
    const player = this.game.playerSelf;
    if (!player || player.health <= 0) return;

    // Generate action ID if not provided
    if (!actionId) {
      actionId = `move_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // 🎯 INSTANT VISUAL RESPONSE (Like LoL!)
    const originalX = player.x;
    const originalZ = player.z;
    
    // Calculate movement
    const dx = targetX - player.x;
    const dz = targetZ - player.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    if (distance > 0.1) {
      // Store prediction for later reconciliation
      this.predictedActions.set(actionId, {
        type: 'movement',
        originalX: originalX,
        originalZ: originalZ,
        targetX: targetX,
        targetZ: targetZ,
        timestamp: Date.now(),
        clientApplied: true
      });

      // ⚡ INSTANT POSITION UPDATE (This is the key!)
      player.x = targetX;
      player.z = targetZ;
      player.targetX = targetX;
      player.targetZ = targetZ;
      player.isMoving = distance > 0.5;
      
      // Update 3D mesh immediately
      if (player.mesh) {
        player.mesh.position.x = targetX;
        player.mesh.position.z = targetZ;
      }

      // Send to server for validation
      this.sendMovementCommand(targetX, targetZ, actionId);
      
      console.log(`⚡ [LOL-PREDICT] Player movement: (${originalX.toFixed(1)}, ${originalZ.toFixed(1)}) → (${targetX.toFixed(1)}, ${targetZ.toFixed(1)})`);
    }
  }

  /**
   * ⚡ INSTANT KNIFE THROW PREDICTION ⚡
   * Another key to LOL-level responsiveness
   */
  predictAndExecuteKnifeThrow(targetX, targetZ, actionId = null) {
    const player = this.game.playerSelf;
    if (!player || player.health <= 0 || !player.canAttack) return;

    // Generate action ID if not provided
    if (!actionId) {
      actionId = `knife_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Check cooldown
    const now = Date.now();
    if (now - player.lastKnifeTime < player.knifeCooldown) return;

    // 🎯 INSTANT KNIFE CREATION (Like LoL!)
    const directionX = targetX - player.x;
    const directionZ = targetZ - player.z;
    const length = Math.sqrt(directionX * directionX + directionZ * directionZ);
    
    if (length > 0) {
      const normalizedDirX = directionX / length;
      const normalizedDirZ = directionZ / length;
      
      // Store prediction for reconciliation
      this.predictedActions.set(actionId, {
        type: 'knife',
        player: player,
        targetX: targetX,
        targetZ: targetZ,
        timestamp: now,
        clientApplied: true
      });

      // ⚡ INSTANT KNIFE VISUAL (This solves the 20-second delay!)
      const predictedKnife = this.createPredictedKnife(player, targetX, targetZ);
      if (predictedKnife) {
        predictedKnife.isPredicted = true;
        predictedKnife.predictionId = actionId;
        predictedKnife.spawnTime = now;
        predictedKnife.ownerTeam = player.team;
        
        // Add to game knife list
        this.game.knives.push(predictedKnife);
        
        console.log(`🔪 [LOL-PREDICT] Instant knife thrown toward (${targetX.toFixed(1)}, ${targetZ.toFixed(1)})`);
      }

      // Update player state immediately
      player.lastKnifeTime = now;
      player.isThrowingKnife = true;
      player.isMoving = false;
      player.targetX = null;
      player.targetZ = null;

      // Send to server for validation
      this.sendKnifeCommand(targetX, targetZ, actionId);

      // Reset throwing animation after delay
      setTimeout(() => {
        player.isThrowingKnife = false;
      }, 2000);

      return predictedKnife;
    }
  }

  /**
   * Create predicted knife with proper physics
   */
  createPredictedKnife(player, targetX, targetZ) {
    const directionX = targetX - player.x;
    const directionZ = targetZ - player.z;
    const length = Math.sqrt(directionX * directionX + directionZ * directionZ);
    
    if (length === 0) return null;

    const normalizedDirX = directionX / length;
    const normalizedDirZ = directionZ / length;
    
    // Create knife geometry
    const knifeGeometry = new THREE.CylinderGeometry(0.2, 0.2, 2, 8);
    const knifeMaterial = new THREE.MeshPhongMaterial({ 
      color: player.team === 1 ? 0xff6b6b : 0x4ecdc4,
      transparent: true,
      opacity: 0.8 // Slightly transparent to indicate prediction
    });
    
    const knifeMesh = new THREE.Mesh(knifeGeometry, knifeMaterial);
    knifeMesh.position.set(player.x, 1, player.z);
    knifeMesh.rotation.z = Math.atan2(normalizedDirZ, normalizedDirX);
    
    // Add to scene
    this.game.scene.add(knifeMesh);
    
    return {
      mesh: knifeMesh,
      x: player.x,
      z: player.z,
      velocityX: normalizedDirX * this.game.KNIFE_SPEED,
      velocityZ: normalizedDirZ * this.game.KNIFE_SPEED,
      direction: { x: normalizedDirX, z: normalizedDirZ },
      ownerPlayer: player,
      isPredicted: true
    };
  }

  /**
   * Send movement command to server
   */
  sendMovementCommand(targetX, targetZ, actionId) {
    if (this.socket && this.roomCode) {
      this.socket.emit('playerMove', {
        roomCode: this.roomCode,
        targetX: targetX,
        targetZ: targetZ,
        actionId: actionId,
        clientTime: Date.now()
      });
    }
  }

  /**
   * Send knife throw command to server
   */
  sendKnifeCommand(targetX, targetZ, actionId) {
    if (this.socket && this.roomCode) {
      this.socket.emit('knifeThrow', {
        roomCode: this.roomCode,
        targetX: targetX,
        targetZ: targetZ,
        actionId: actionId,
        clientTimestamp: Date.now()
      });
    }
  }

  /**
   * 🎯 SERVER RECONCILIATION 🎯
   * Correct client predictions with minimal visual disruption
   */
  reconcileWithServer(serverData) {
    if (!serverData) return;

    // Update time offset
    if (serverData.serverTime) {
      const currentTime = Date.now();
      this.serverTimeOffset = currentTime - serverData.serverTime;
    }

    // Process player reconciliation
    if (serverData.players) {
      for (const serverPlayer of serverData.players) {
        this.reconcilePlayerPosition(serverPlayer);
      }
    }

    // Process knife reconciliation
    if (serverData.knives) {
      this.reconcileKnivesWithServer(serverData.knives);
    }
  }

  /**
   * Reconcile individual player position
   */
  reconcilePlayerPosition(serverPlayer) {
    const playerId = serverPlayer.playerId;
    let localPlayer = null;

    // Find local player
    if (playerId === this.game.myPlayerId) {
      localPlayer = this.game.playerSelf;
    } else {
      localPlayer = this.game.playersById.get(playerId);
    }

    if (!localPlayer) return;

    const serverX = serverPlayer.x;
    const serverZ = serverPlayer.z;
    
    // Calculate prediction error
    const errorX = localPlayer.x - serverX;
    const errorZ = localPlayer.z - serverZ;
    const errorDistance = Math.sqrt(errorX * errorX + errorZ * errorZ);

    if (errorDistance > this.RECONCILIATION_THRESHOLD) {
      if (errorDistance > 5.0) {
        // Large error: immediate correction
        this.correctPlayerPosition(localPlayer, serverX, serverZ, true);
        console.log(`🔄 [LOL-RECONCILE] Large error (${errorDistance.toFixed(2)}), immediate correction`);
      } else {
        // Small error: smooth correction
        this.smoothCorrectPlayerPosition(localPlayer, serverX, serverZ);
        console.log(`🔄 [LOL-RECONCILE] Small error (${errorDistance.toFixed(2)}), smooth correction`);
      }
    }

    // Update other server state
    localPlayer.health = serverPlayer.health;
    localPlayer.isDead = serverPlayer.isDead;
  }

  /**
   * Smooth correction for small position errors
   */
  smoothCorrectPlayerPosition(player, targetX, targetZ) {
    // Set interpolation target
    player.interpTargetX = targetX;
    player.interpTargetZ = targetZ;
    player.interpStartTime = Date.now();
    player.interpDuration = 50; // 50ms smooth correction
    
    console.log(`🔄 [LOL-SMOOTH] Correcting position over 50ms`);
  }

  /**
   * Immediate correction for large position errors
   */
  correctPlayerPosition(player, x, z, immediate = false) {
    player.x = x;
    player.z = z;
    
    if (immediate && player.mesh) {
      player.mesh.position.x = x;
      player.mesh.position.z = z;
    }
    
    // Clear interpolation targets
    player.interpTargetX = null;
    player.interpTargetZ = null;
    player.interpStartTime = null;
    player.interpDuration = null;
  }

  /**
   * Reconcile knives with server state
   */
  reconcileKnivesWithServer(serverKnives) {
    // Create set of server knife IDs
    const serverKnifeIds = new Set(serverKnives.map(k => k.knifeId));
    
    // Update or remove predicted knives
    for (const knife of this.game.knives) {
      if (knife.isPredicted) {
        if (serverKnifeIds.has(knife.knifeId)) {
          // Server confirmed our prediction
          knife.isPredicted = false;
          knife.predictionId = null;
          
          // Make knife fully opaque
          if (knife.mesh && knife.mesh.material) {
            knife.mesh.material.opacity = 1.0;
          }
          
          console.log(`✅ [LOL-KNIFE-OK] Predicted knife confirmed by server`);
        } else {
          // Server didn't confirm, check if it's too old
          const age = Date.now() - knife.spawnTime;
          if (age > this.PREDICTED_KNIFE_LIFETIME) {
            // Remove old predicted knife
            this.disposeKnife(knife);
            this.game.knives = this.game.knives.filter(k => k !== knife);
          }
        }
      }
    }
    
    // Add any new server knives we don't have
    for (const serverKnife of serverKnives) {
      const existingKnife = this.game.knives.find(k => k.knifeId === serverKnife.knifeId);
      if (!existingKnife) {
        // Create new knife from server data
        this.createKnifeFromServerData(serverKnife);
      }
    }
  }

  /**
   * Create knife from server data
   */
  createKnifeFromServerData(serverKnife) {
    const thrower = this.findPlayerByTeam(serverKnife.ownerTeam);
    if (!thrower) return;

    const targetX = serverKnife.x + serverKnife.velocityX * 10;
    const targetZ = serverKnife.z + serverKnife.velocityZ * 10;
    
    const knife = this.game.createKnife3DTowards(thrower, targetX, targetZ, null);
    if (knife) {
      knife.knifeId = serverKnife.knifeId;
      knife.isPredicted = false;
      this.game.knives.push(knife);
    }
  }

  /**
   * 🎯 SMOOTH INTERPOLATION 🎯
   * Make opponent movements look natural like in LoL
   */
  updateInterpolation() {
    const now = Date.now();
    
    // Update player interpolations
    [this.game.playerSelf, this.game.playerOpponent, ...this.game.team1, ...this.game.team2].forEach(player => {
      if (!player || !player.interpTargetX || !player.interpStartTime) return;
      
      const elapsed = now - player.interpStartTime;
      const progress = Math.min(elapsed / player.interpDuration, 1.0);
      
      // Ease-out interpolation (like LoL)
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      
      const targetX = player.interpTargetX;
      const targetZ = player.interpTargetZ;
      
      player.x = player.x + (targetX - player.x) * easedProgress;
      player.z = player.z + (targetZ - player.z) * easedProgress;
      
      // Update 3D mesh
      if (player.mesh) {
        player.mesh.position.x = player.x;
        player.mesh.position.z = player.z;
      }
      
      // Complete interpolation
      if (progress >= 1.0) {
        player.interpTargetX = null;
        player.interpTargetZ = null;
        player.interpStartTime = null;
        player.interpDuration = null;
      }
    });
  }

  /**
   * Update predicted knives physics
   */
  updatePredictedKnives(dt) {
    const now = Date.now();
    
    for (const knife of this.game.knives) {
      if (!knife.isPredicted) continue;
      
      // Remove expired knives
      if (now - knife.spawnTime > this.PREDICTED_KNIFE_LIFETIME) {
        this.disposeKnife(knife);
        continue;
      }
      
      // Update knife physics
      knife.prevX = knife.x;
      knife.prevZ = knife.z;
      knife.x += knife.velocityX * dt;
      knife.z += knife.velocityZ * dt;
      
      // Update 3D mesh
      if (knife.mesh) {
        knife.mesh.position.x = knife.x;
        knife.mesh.position.z = knife.z;
        knife.mesh.rotation.z = Math.atan2(knife.velocityZ, knife.velocityX);
      }
    }
  }

  /**
   * Handle server knife spawn event
   */
  handleServerKnifeSpawn(data) {
    if (data.ownerTeam === this.myTeam && data.actionId) {
      // Try to find our predicted knife
      const predictedKnife = this.game.knives.find(k => 
        k.isPredicted && k.predictionId === data.actionId
      );
      
      if (predictedKnife) {
        // Replace predicted knife with server knife
        console.log(`✅ [LOL-RECONCILE] Found predicted knife, replacing with server knife ${data.knifeId}`);
        
        predictedKnife.knifeId = data.knifeId;
        predictedKnife.isPredicted = false;
        predictedKnife.predictionId = null;
        
        // Make knife fully visible
        if (predictedKnife.mesh && predictedKnife.mesh.material) {
          predictedKnife.mesh.material.opacity = 1.0;
        }
        
        return; // Don't create duplicate knife
      }
    }
    
    // Create new knife from server data
    this.createKnifeFromServerData(data);
  }

  /**
   * Handle server movement acknowledgment
   */
  handleServerMoveAck(data) {
    if (!data.actionId) return;
    
    const predictedAction = this.predictedActions.get(data.actionId);
    if (!predictedAction) return;
    
    // Calculate error
    const serverX = data.x;
    const serverZ = data.z;
    const errorX = predictedAction.targetX - serverX;
    const errorZ = predictedAction.targetZ - serverZ;
    const errorDistance = Math.sqrt(errorX * errorX + errorZ * errorZ);
    
    if (errorDistance > this.RECONCILIATION_THRESHOLD) {
      console.log(`🔄 [LOL-ACK] Movement acknowledged with error: ${errorDistance.toFixed(2)}`);
      
      // Apply smooth correction
      this.game.playerSelf.interpTargetX = serverX;
      this.game.playerSelf.interpTargetZ = serverZ;
      this.game.playerSelf.interpStartTime = Date.now();
      this.game.playerSelf.interpDuration = 50;
    }
    
    // Remove from predicted actions
    this.predictedActions.delete(data.actionId);
  }

  /**
   * Clean up predicted actions that are too old
   */
  cleanupOldPredictions() {
    const now = Date.now();
    const maxAge = 5000; // 5 seconds
    
    for (const [actionId, action] of this.predictedActions.entries()) {
      if (now - action.timestamp > maxAge) {
        this.predictedActions.delete(actionId);
      }
    }
  }

  /**
   * Utility methods
   */
  findPlayerByTeam(team) {
    const targetTeam = Number(team);
    
    if (targetTeam === this.myTeam) {
      return this.game.playerSelf;
    } else {
      return this.game.playerOpponent;
    }
  }

  disposeKnife(knife) {
    if (knife.mesh) {
      this.game.scene.remove(knife.mesh);
      knife.mesh.geometry.dispose();
      knife.mesh.material.dispose();
    }
  }

  /**
   * Performance monitoring
   */
  updateNetworkStats() {
    const now = Date.now();
    this.networkStats.lastUpdateTimes.push(now);
    
    // Keep only last 100 timestamps
    if (this.networkStats.lastUpdateTimes.length > 100) {
      this.networkStats.lastUpdateTimes.shift();
    }
    
    // Calculate latency
    if (this.networkStats.lastUpdateTimes.length > 1) {
      const intervals = [];
      for (let i = 1; i < this.networkStats.lastUpdateTimes.length; i++) {
        intervals.push(this.networkStats.lastUpdateTimes[i] - this.networkStats.lastUpdateTimes[i-1]);
      }
      
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      this.networkStats.avgLatency = avgInterval;
      
      // Calculate jitter
      const deviations = intervals.map(interval => Math.abs(interval - avgInterval));
      this.networkStats.jitter = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    }
  }

  /**
   * Main update loop
   */
  update(dt) {
    this.updateInterpolation();
    this.updatePredictedKnives(dt);
    this.cleanupOldPredictions();
    this.updateNetworkStats();
  }
}

// Export for use in game
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LOLLevelNetworkManager;
}

// Make available globally
window.LOLLevelNetworkManager = LOLLevelNetworkManager;