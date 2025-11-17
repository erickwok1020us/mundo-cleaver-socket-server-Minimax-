# Mundo Cleaver Socket.IO Server

This is the Socket.IO server for the Mundo Cleaver multiplayer game.

## Features

- **Server-Authoritative Architecture**: All game logic runs on the server
- **Lag Compensation**: Position history buffer with time rewind for fair hit detection
- **Client-Side Prediction**: Movement reconciliation with server acknowledgments
- **Redis Integration**: Centralized state management for multi-instance scaling
- **WebSocket-Only Mode**: Forced WebSocket transport for low-latency communication

## Deployment on Render.com

This server is configured to run on Render.com.

### Redis Setup on Render

1. Create a Redis instance on Render (or use another Redis provider)
2. Copy the Redis connection URL
3. Set the `REDIS_URL` environment variable in your Render service settings

## Environment Variables

- `PORT`: Server port (default: 3000, automatically set by Render)
- `REDIS_URL`: Redis connection URL (required for multi-instance deployment)
  - Format: `redis://[username][:password]@host:port[/database]`
  - Example: `redis://red-xxxxx:6379`
- `USE_REDIS`: Enable/disable Redis (default: true)
  - Set to `false` for single-instance deployment without Redis

## Local Development

### Without Redis (Single Instance)

```bash
npm install
USE_REDIS=false npm start
```

### With Redis (Multi-Instance Ready)

1. Start a local Redis server:
```bash
docker run -d -p 6379:6379 redis:latest
```

2. Start the server:
```bash
npm install
npm start
```

The server will start on port 3000.

## Architecture

This server implements the networking architecture recommended in the PDF specification:

1. **Dedicated Server**: Long-lived Node.js process (not serverless)
2. **Centralized State**: Redis for room registry and cross-instance communication
3. **Server-Authoritative**: All game logic validated on server
4. **Command-Based Protocol**: Clients send commands, server determines outcomes
