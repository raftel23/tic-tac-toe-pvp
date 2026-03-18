# 🚀 Neon Strike - DevOps Handbook

This project is configured for **high-performance multiplayer** testing and cloud deployment.

## 🛠 Quick Start (The "Easy" Way)

1.  **Install Dependencies**:
    ```powershell
    npm install
    ```
2.  **Start the Server**:
    ```powershell
    npm start
    ```
3.  **Start the Tunnel** (In a separate terminal):
    ```powershell
    npm run tunnel
    ```
    *This uses **Cloudflare Tunnel**, which is faster and doesn't require any passwords or bypass screens.*

## 🔐 Configuration

Create a `.env` file based on `.env.template`:
- `JWT_SECRET`: For session security.
- `DATABASE_URL`: If using PostgreSQL (Cloud).
- Leave empty to use local **SQLite** (`game.db`).

## 📁 Project Architecture
- `server.js`: Node/Express/Socket.io backend.
- `database.js`: Dual-mode DB support (PG/SQLite).
- `script.js`: Robust client with tunnel auto-bypass.
- `Procfile`: Ready for Render/Heroku.

## 📡 Tunnel Troubleshooting
If using **Localtunnel** and getting a "Position 4" error:
- It's the "Reminder" page crashing JSON parsing.
- Use `npm run tunnel` to switch to Cloudflare—it avoids this entirely.
