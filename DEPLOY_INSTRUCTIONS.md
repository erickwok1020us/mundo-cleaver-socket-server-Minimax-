# V432-FINAL-COMPLETE 部署說明

## 🔴 關鍵發現

**問題根源：**
後端的 `server.js` 有 `rejoinRoom` 處理器，但 `gameEngine.js` **缺少** `updatePlayerSocket` 方法！

當 socket 重連時：
1. ✅ 前端發送 `rejoinRoom` 
2. ✅ 後端 `server.js` 接收到 `rejoinRoom`
3. ❌ 後端調用 `gameEngines[roomCode].updatePlayerSocket(oldSocketId, socket.id)` - **方法不存在！**
4. ❌ 後端崩潰或跳過，導致 gameEngine 還在使用舊的 socket ID
5. ❌ 位置更新發送到錯誤的 socket，飛刀命中檢測失敗

## 🔧 完整修復

### 後端修復（mundo-cleaver-socket-server）

**gameEngine.js - 新增 updatePlayerSocket 方法：**
```javascript
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
```

**位置：** 在 `removePlayer` 方法之後，`updatePlayerTeam` 方法之前（line 155-162）

## 🚀 部署步驟

### 步驟 1：部署後端（mundo-cleaver-socket-server）

```bash
cd /path/to/mundo-cleaver-socket-server

# 確認修改
git status
git log --oneline -3

# 推送（已經提交好了）
git push origin main
```

**等待 Render 部署**（約 2-3 分鐘）

### 步驟 2：驗證部署

**檢查 Render 日誌：**
1. 打開 Render dashboard
2. 查看 mundo-cleaver-socket-server 的部署日誌
3. 確認部署成功

**測試步驟：**
1. **硬刷新瀏覽器**（Ctrl+Shift+R 或 Cmd+Shift+R）
2. 打開 Console（F12）
3. 創建 1v1 房間
4. 加入房間
5. 兩個玩家都點 Ready
6. 房主點 START
7. **觀察 Console 日誌：**

**預期日誌（如果 socket 重連）：**

**前端（兩個玩家都應該看到）：**
```
Socket disconnected: transport close
Socket connected: <new-socket-id>
[REJOIN] Emitting rejoinRoom - roomCode: 123456 playerId: 1
[REJOIN] Successfully rejoined room: {roomCode: "123456", playerId: 1, team: 1, gameMode: "1v1"}
```

**後端（Render 日誌）：**
```
[REJOIN] Player attempting to rejoin - newSocketId:<new-id> playerId:1 roomCode:123456
[REJOIN] Found player 1 with old socket <old-id>, updating to <new-id>
[GAME-ENGINE] Updating player 1 socket from <old-id> to <new-id> in room 123456
[REJOIN] Successfully rejoined player 1 (Team 1) to room 123456
```

## ✅ 驗證成功標準

修復後應該：
- ✅ 雙方都能看到對方移動（沒有卡頓）
- ✅ 飛刀可以命中對手
- ✅ 沒有 4-5 秒的初始卡頓
- ✅ Console 顯示 `[REJOIN]` 日誌（如果有重連）
- ✅ 後端日誌顯示 `[GAME-ENGINE] Updating player socket`

## 🔍 如果還有問題

**收集以下信息：**
1. **房主的完整 Console 日誌**（從點擊 START 開始）
2. **客人的完整 Console 日誌**（從點擊 START 開始）
3. **Render 後端日誌**（搜尋 `[REJOIN]` 和 `[GAME-ENGINE]`）
4. **確認是否看到 socket 斷線重連**
5. **確認是否看到 `[REJOIN]` 日誌**

## 📝 技術細節

**為什麼需要 updatePlayerSocket：**

gameEngine 使用 `Map<socketId, playerData>` 來追蹤玩家：
- 當 socket 重連時，socket ID 改變
- server.js 更新了 rooms 和 teams 的 socket ID
- 但 gameEngine.players Map 還在使用舊的 socket ID
- 位置更新和飛刀命中檢測都基於 gameEngine.players
- 如果不更新 Map，所有遊戲邏輯都會失敗

**修復流程：**
1. Socket 斷線重連（新 socket ID）
2. 前端檢測到重連，發送 `rejoinRoom`
3. 後端 server.js 更新 rooms、teams、hostSocket
4. 後端調用 `gameEngine.updatePlayerSocket(oldId, newId)`
5. gameEngine 更新內部 players Map
6. 所有遊戲邏輯現在使用正確的 socket ID
7. 位置更新和飛刀命中正常工作

---

**Link to Devin run**: https://app.devin.ai/sessions/67ae4851241a478095a8eeb2793f4a7d
**Requested by**: alexchoi2023313@gmail.com
