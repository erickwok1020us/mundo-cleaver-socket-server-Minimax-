const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS 配置
const corsOptions = {
    origin: [
        'https://pudge-wars-multiple-people2.vercel.app',
        'https://pudge-wars-multiple-people.vercel.app',
        'https://erickwok1020us.github.io',
        'https://erickwok1020us.github.io/Mundo-cleaver-game-Minimax-/',
        'https://erickwok1020us.github.io/mundo-cleaver-socket-server-Minimax-/',
        'http://localhost:3000',
        'http://localhost:8000',
        'http://localhost:8080',
        'http://localhost:8081'
    ],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    optionsSuccessStatus: 200
};

// 應用 CORS 到所有路由
app.use(cors(corsOptions));

// Express 中間件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Socket.IO CORS 配置
const io = socketIo(server, {
    cors: {
        origin: corsOptions.origin,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true
    }
});

// 遊戲狀態
const gameState = {
    players: new Map(),
    knives: new Map(),
    scores: new Map()
};

// Socket.IO 連接處理
io.on('connection', (socket) => {
    console.log('玩家連接:', socket.id);

    // 加入遊戲
    socket.on('join-game', (playerData) => {
        gameState.players.set(socket.id, {
            id: socket.id,
            name: playerData.name || `Player${Math.floor(Math.random() * 1000)}`,
            x: Math.random() * 20 - 10,
            z: Math.random() * 20 - 10,
            health: 100,
            score: 0
        });
        
        io.emit('player-joined', gameState.players.get(socket.id));
    });

    // 玩家移動
    socket.on('player-move', (data) => {
        const player = gameState.players.get(socket.id);
        if (player) {
            player.x = data.x;
            player.z = data.z;
            
            // 廣播給其他玩家
            socket.broadcast.emit('player-moved', {
                id: socket.id,
                x: data.x,
                z: data.z
            });
        }
    });

    // 投擲刀子
    socket.on('throw-knife', (data) => {
        const knifeId = `${socket.id}-${Date.now()}`;
        
        // 創建刀子對象
        const knife = {
            id: knifeId,
            x: data.x,
            z: data.z,
            targetX: data.targetX,
            targetZ: data.targetZ,
            throwerId: socket.id,
            startTime: Date.now(),
            duration: 1000, // 1秒投擲時間
            velocity: {
                x: (data.targetX - data.x) / 1000,
                z: (data.targetZ - data.z) / 1000
            }
        };
        
        gameState.knives.set(knifeId, knife);
        
        // 廣播刀子投擲
        io.emit('knife-thrown', knife);
        
        // 檢查碰撞（簡化版）
        setTimeout(() => {
            checkKnifeHit(knifeId, data.targetX, data.targetZ);
        }, 1000);
    });

    // 玩家斷開連接
    socket.on('disconnect', () => {
        console.log('玩家斷開連接:', socket.id);
        gameState.players.delete(socket.id);
        io.emit('player-disconnected', socket.id);
    });
});

// 檢查刀子命中
function checkKnifeHit(knifeId, targetX, targetZ) {
    const knife = gameState.knives.get(knifeId);
    if (!knife) return;
    
    // 簡單的碰撞檢測
    for (const [playerId, player] of gameState.players) {
        if (playerId !== knife.throwerId) {
            const distance = Math.sqrt(
                Math.pow(player.x - targetX, 2) + 
                Math.pow(player.z - targetZ, 2)
            );
            
            if (distance < 2) { // 命中範圍
                // 減少血量
                player.health -= 20;
                
                // 更新投擲者分數
                const thrower = gameState.players.get(knife.throwerId);
                if (thrower) {
                    thrower.score += 10;
                }
                
                // 檢查玩家是否死亡
                if (player.health <= 0) {
                    io.emit('player-died', {
                        playerId: playerId,
                        killerId: knife.throwerId
                    });
                    
                    // 重置玩家血量
                    player.health = 100;
                    player.x = Math.random() * 20 - 10;
                    player.z = Math.random() * 20 - 10;
                }
                
                io.emit('knife-hit', {
                    knifeId: knifeId,
                    hitPlayer: playerId,
                    throwerId: knife.throwerId
                });
                break;
            }
        }
    }
    
    gameState.knives.delete(knifeId);
}

// 基本路由
app.get('/', (req, res) => {
    res.json({
        status: 'Server is running',
        players: gameState.players.size,
        knives: gameState.knives.size
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        players: gameState.players.size
    });
});

// 錯誤處理
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message 
    });
});

// 啟動服務器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Mundo Cleaver Server 運行在端口 ${PORT}`);
    console.log(`📡 Socket.IO 啟用 CORS`);
    console.log(`🌐 允許的來源: ${corsOptions.origin.join(', ')}`);
});

// 優雅關閉
process.on('SIGTERM', () => {
    console.log('收到 SIGTERM 信號，正在關閉服務器...');
    server.close(() => {
        console.log('服務器已關閉');
        process.exit(0);
    });
});