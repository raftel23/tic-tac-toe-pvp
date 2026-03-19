/**
 * server.js
 * Backend for real-time multiplayer Tic-Tac-Toe
 * Manages rooms, turn timers, role assignments, and game state.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const db = require('./database');

const app = express();
app.use(cors({
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization", "Bypass-Tunnel-Reminder", "ngrok-skip-browser-warning"]
}));
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "*", // Allow all in dev, restrict in prod
        methods: ["GET", "POST"]
    }
});

const JWT_SECRET = process.env.JWT_SECRET || 'neon-tic-tac-toe-dev-secret';
if (!process.env.JWT_SECRET) {
    console.warn('WARNING: JWT_SECRET environment variable not set. Using default secret (unsafe).');
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {

    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Auth Endpoints ---

app.post('/api/register', async (req, res) => {
    const { username, display_name, password } = req.body;
    if (!username || !password || !display_name) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    // --- Validation: Max 8 Chars & No Whitespace in Username ---
    if (username.length > 8 || display_name.length > 8) {
        return res.status(400).json({ error: 'Names must be 8 characters or less' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (/\s/.test(username)) {
        return res.status(400).json({ error: 'Username cannot contain spaces' });
    }
    // ---------------------------------------------------------

    const hashedPassword = bcrypt.hashSync(password, 10);
    try {
        await db.query('INSERT INTO users (username, display_name, password) VALUES ($1, $2, $3)', [username, display_name, hashedPassword]);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Username already exists' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { username: user.username, display_name: user.display_name, id: user.id } });
});

app.get('/api/profile', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const result = await db.query('SELECT id, username, display_name, wins, losses, draws, elo FROM users WHERE id = $1', [decoded.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    const result = await db.query('SELECT username, display_name, wins, elo FROM users ORDER BY elo DESC LIMIT 10');
    res.json(result.rows);
});

app.get('/api/history', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });

    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        const result = await db.query(`
            SELECT g.*, u1.display_name as p1_name, u2.display_name as p2_name, w.display_name as winner_name
            FROM games g
            JOIN users u1 ON g.player1_id = u1.id
            JOIN users u2 ON g.player2_id = u2.id
            LEFT JOIN users w ON g.winner_id = w.id
            WHERE g.player1_id = $1 OR g.player2_id = $2
            ORDER BY g.played_at DESC LIMIT 20
        `, [decoded.id, decoded.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

const rooms = new Map(); // roomName -> roomData
let waitingPlayer = null;
const users = new Map(); // socket.id -> username


const TURN_TIME_LIMIT = 10000; // 10 seconds

/**
 * Room Data Structure:
 * {
 *   players: [ {id, username, symbol, rematchRequest, ready} ],
 *   board: Array(9).fill(null),
 *   currentTurn: symbol (X/O),
 *   timer: setTimeout ID,
 *   marks: { X: [], O: [] }, // Queues for Infinite Rule
 *   powerups: { X: { eraser: true }, O: { eraser: true } },
 *   isAI: boolean,
 *   endgameTimer: setTimeout ID // To prevent auto-lobby redirect on rematch
 * }
 */

// Socket Auth Middleware
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.user = decoded; // { id, username }
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user.username} (${socket.id})`);
    users.set(socket.id, socket.user.username);

    // We already have username from token
    matchmake(socket, socket.user.username);

    socket.on('player-ready', () => {
        playerReady(socket);
    });

    socket.on('make-move', async ({ index }) => {
        const roomName = Array.from(socket.rooms).find(r => r.startsWith('room-'));
        if (!roomName) return;

        const idx = parseInt(index);
        if (isNaN(idx) || idx < 0 || idx > 8) return;

        const room = rooms.get(roomName);
        if (!room || !room.players.every(p => p.ready)) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player.symbol !== room.currentTurn) return;
        if (room.board[index] !== null) return;

        room.board[index] = player.symbol;

        // --- Infinite Rule ---
        if (!room.marks) room.marks = { X: [], O: [] };
        room.marks[player.symbol].push(index);

        if (room.marks[player.symbol].length > 3) {
            const oldIndex = room.marks[player.symbol].shift();
            room.board[oldIndex] = null;
        }
        // ---------------------

        clearTimeout(room.timer);

        const winData = checkWinner(room.board);
        if (winData) {
            await saveAndEndGame(roomName, winData.symbol === 'draw' ? 'draw' : 'win', winData.symbol, winData.line);
        } else {
            room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';
            startTimer(roomName);
            io.to(roomName).emit('game-state', {
                board: room.board,
                currentTurn: room.currentTurn,
                marks: room.marks // Send mark queues for UI feedback
            });

            // Trigger AI move if it's AI's turn
            if (room.isAI && room.currentTurn === 'O') {
                setTimeout(() => makeAIMove(roomName), 1000);
            }
        }
    });

    socket.on('use-eraser', ({ index }) => {
        const roomName = Array.from(socket.rooms).find(r => r.startsWith('room-'));
        const room = rooms.get(roomName);
        if (!room) return;

        const idx = parseInt(index);
        if (isNaN(idx) || idx < 0 || idx > 8) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player.symbol !== room.currentTurn) return;

        if (!room.powerups) room.powerups = { X: { eraser: 3 }, O: { eraser: 3 } };
        if (room.powerups[player.symbol].eraser <= 0) return;

        const opponentSymbol = player.symbol === 'X' ? 'O' : 'X';
        if (room.board[index] !== opponentSymbol) return;

        room.board[index] = null;
        room.marks[opponentSymbol] = room.marks[opponentSymbol].filter(i => i !== parseInt(index));
        room.powerups[player.symbol].eraser--;

        // --- Eraser Consumes Turn ---
        clearTimeout(room.timer);
        room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';
        startTimer(roomName);
        // ----------------------------

        io.to(roomName).emit('game-state', {
            board: room.board,
            currentTurn: room.currentTurn,
            marks: room.marks
        });

        if (room.isAI && room.currentTurn === 'O') {
            setTimeout(() => makeAIMove(roomName), 1000);
        }
    });

    socket.on('cancel-search', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            console.log(`User cancelled search: ${socket.user.username}`);
            waitingPlayer = null;
        }
    });

    socket.on('play-ai', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            const roomName = `room-ai-${Date.now()}`;
            const players = [
                { id: socket.id, userId: socket.user.id, username: socket.user.username, symbol: 'X', rematchRequest: false, ready: false },
                { id: 'ai-bot', userId: 0, username: 'TRUMP BOT', symbol: 'O', rematchRequest: false, ready: true }
            ];

            rooms.set(roomName, {
                players,
                board: Array(9).fill(null),
                currentTurn: 'X',
                timer: null,
                marks: { X: [], O: [] },
                powerups: { X: { eraser: 3 }, O: { eraser: 0 } }, // AI doesn't use eraser for simplicity
                isAI: true
            });

            socket.join(roomName);
            io.to(roomName).emit('match-found', { players: players.map(p => ({ id: p.id, username: p.username })) });
            waitingPlayer = null;
        }
    });

    socket.on('rematch-request', () => {
        const roomName = Array.from(socket.rooms).find(r => r.startsWith('room-'));
        const room = rooms.get(roomName);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        player.rematchRequest = true;

        io.to(roomName).emit('rematch-status', { id: socket.id, status: 'rematch' });

        // --- AI Auto-Rematch ---
        if (room.isAI) {
            const aiBot = room.players.find(p => p.id === 'ai-bot');
            if (aiBot) aiBot.rematchRequest = true;
            io.to(roomName).emit('rematch-status', { id: 'ai-bot', status: 'rematch' });
        }
        // -----------------------

        if (room.players.every(p => p.rematchRequest)) {
            room.players.forEach(p => {
                if (!room.isAI) {
                    p.symbol = p.symbol === 'X' ? 'O' : 'X';
                } else {
                    // Lock symbols for AI match: Player always X, AI always O
                    p.symbol = (p.id === 'ai-bot') ? 'O' : 'X';
                }
                p.rematchRequest = false;
                p.ready = true;
            });

            // --- Bug Fix: Stop auto-redirect to lobby ---
            if (room.endgameTimer) {
                clearTimeout(room.endgameTimer);
                room.endgameTimer = null;
            }
            // --------------------------------------------

            resetRoom(room);
            io.to(roomName).emit('game-start', {
                players: room.players.map(p => ({ id: p.id, username: p.username, symbol: p.symbol, elo: p.elo })),
                currentTurn: 'X'
            });
            startTimer(roomName);
        }
    });

    socket.on('rematch-decline', () => {
        const roomName = Array.from(socket.rooms).find(r => r.startsWith('room-'));
        if (!roomName) return;
        io.to(roomName).emit('rematch-status', { id: socket.id, status: 'declined' });
        socket.to(roomName).emit('rematch-declined');
        rooms.delete(roomName);
    });

    socket.on('disconnecting', async () => {
        const roomName = Array.from(socket.rooms).find(r => r.startsWith('room-'));
        if (roomName) {
            const room = rooms.get(roomName);
            if (room && room.players.every(p => p.ready)) {
                // If game was active, the leaver loses
                const leaver = room.players.find(p => p.id === socket.id);
                const winner = room.players.find(p => p.id !== socket.id);
                if (winner) await saveAndEndGame(roomName, 'timeout', winner.symbol);
            }
            io.to(roomName).emit('rematch-status', { id: socket.id, status: 'left' });
            io.to(roomName).emit('opponent-disconnected');
            rooms.delete(roomName);
        }
        users.delete(socket.id);
    });
});

async function matchmake(socket, username) {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
        const waitingSocket = io.sockets.sockets.get(waitingPlayer.id);

        if (!waitingSocket) {
            console.log(`Waiting player ${waitingPlayer.username} vanished. Updating search.`);
            waitingPlayer = { id: socket.id, userId: socket.user.id, username };
            socket.emit('waiting', 'Searching for an opponent...');
            return;
        }

        const roomName = `room-${Date.now()}`;
        const players = [
            { id: waitingPlayer.id, userId: waitingPlayer.userId, username: waitingPlayer.username, symbol: 'X', rematchRequest: false, ready: false },
            { id: socket.id, userId: socket.user.id, username, symbol: 'O', rematchRequest: false, ready: false }
        ];

        if (Math.random() > 0.5) {
            players[0].symbol = 'O';
            players[1].symbol = 'X';
        }

        rooms.set(roomName, {
            players: await Promise.all(players.map(async p => {
                const res = await db.query('SELECT elo FROM users WHERE id = $1', [p.userId]);
                return { ...p, elo: res.rows[0].elo };
            })),
            board: Array(9).fill(null),
            currentTurn: 'X',
            timer: null,
            marks: { X: [], O: [] },
            powerups: { X: { eraser: 3 }, O: { eraser: 3 } }
        });

        waitingSocket.join(roomName);
        socket.join(roomName);

        io.to(roomName).emit('match-found', { players: players.map(p => ({ id: p.id, username: p.username })) });

        // --- 6s Match Start Timer ---
        setTimeout(() => {
            const room = rooms.get(roomName);
            if (room && !room.players.every(p => p.ready)) {
                room.players.forEach(p => p.ready = true);
                io.to(roomName).emit('ready-update', { allReady: true });
                io.to(roomName).emit('game-start', {
                    players: room.players.map(p => ({ id: p.id, username: p.username, symbol: p.symbol, elo: p.elo })),
                    currentTurn: 'X'
                });
                startTimer(roomName);
            }
        }, 7000); // 7s to give client 6s buffer
        // ----------------------------

        waitingPlayer = null;
    } else {
        waitingPlayer = { id: socket.id, userId: socket.user.id, username };
        socket.emit('waiting', 'Searching for an opponent...');
    }
}


async function saveAndEndGame(roomName, type, resultSymbol, winningLine = null) {
    const room = rooms.get(roomName);
    if (!room) return;

    clearTimeout(room.timer);

    let winnerId = null;
    const p1 = room.players[0];
    const p2 = room.players[1];

    console.log(`[DEBUG] saveAndEndGame - Room: ${roomName}, type: ${type}, result: ${resultSymbol}, isAI: ${room.isAI}`);

    // --- Statistics & Recording (PvP ONLY) ---
    if (!room.isAI) {
        console.log(`[DEBUG] Entering Statistics block for PvP match`);
        try {
            if (type === 'draw') {
                await db.query('UPDATE users SET draws = draws + 1 WHERE id = $1 OR id = $2', [p1.userId, p2.userId]);
            } else {
                const winner = room.players.find(p => p.symbol === resultSymbol);
                const loser = room.players.find(p => p.symbol !== resultSymbol);
                winnerId = winner.userId;
                await db.query('UPDATE users SET wins = wins + 1 WHERE id = $1', [winner.userId]);
                await db.query('UPDATE users SET losses = losses + 1 WHERE id = $1', [loser.userId]);
            }

            // Save competitive game record
            await db.query('INSERT INTO games (player1_id, player2_id, winner_id, board_state) VALUES ($1, $2, $3, $4)',
                [p1.userId, p2.userId, winnerId, JSON.stringify(room.board)]);

            // --- ELO Calculation ---
            const r1 = await db.query('SELECT elo FROM users WHERE id = $1', [p1.userId]);
            const r2 = await db.query('SELECT elo FROM users WHERE id = $1', [p2.userId]);
            let e1 = r1.rows[0].elo;
            let e2 = r2.rows[0].elo;

            const K = 32;
            const ea = 1 / (1 + 10 ** ((e2 - e1) / 400));
            const eb = 1 / (1 + 10 ** ((e1 - e2) / 400));

            let sa = 0.5, sb = 0.5;
            if (type !== 'draw') {
                const winner = room.players.find(p => p.symbol === resultSymbol);
                sa = (winner.userId === p1.userId) ? 1 : 0;
                sb = 1 - sa;
            }

            const newE1 = Math.max(1, Math.round(e1 + K * (sa - ea)));
            const newE2 = Math.max(1, Math.round(e2 + K * (sb - eb)));

            await db.query('UPDATE users SET elo = $1 WHERE id = $2', [newE1, p1.userId]);
            await db.query('UPDATE users SET elo = $2 WHERE id = $3', [newE2, p2.userId]);

        } catch (err) {
            console.error('Error saving game result:', err);
        }
    }
    // -----------------------------------------

    io.to(roomName).emit('game-over', {
        type,
        result: resultSymbol,
        board: room.board,
        winningLine,
        players: await Promise.all(room.players.map(async p => {
            const res = await db.query('SELECT elo FROM users WHERE id = $1', [p.userId || 0]); // 0 for AI
            return { id: p.id, elo: res.rows[0] ? res.rows[0].elo : 1000 };
        }))
    });

    // --- 6s Game Over Result Timer ---
    room.endgameTimer = setTimeout(() => {
        if (rooms.has(roomName)) {
            io.to(roomName).emit('return-to-dashboard');
            rooms.delete(roomName);
        }
    }, 7000);
}


function startTimer(roomName) {
    const room = rooms.get(roomName);
    if (!room) return;

    clearTimeout(room.timer);
    io.to(roomName).emit('timer-update', TURN_TIME_LIMIT);

    room.timer = setTimeout(async () => {
        const loserSymbol = room.currentTurn;
        const winnerSymbol = loserSymbol === 'X' ? 'O' : 'X';
        await saveAndEndGame(roomName, 'timeout', winnerSymbol);
    }, TURN_TIME_LIMIT);
}

function resetRoom(room) {

    room.board = Array(9).fill(null);
    room.currentTurn = 'X';
    room.marks = { X: [], O: [] };
    room.powerups = { X: { eraser: 3 }, O: { eraser: 3 } };
}

function playerReady(socket) {
    const roomName = Array.from(socket.rooms).find(r => r.startsWith('room-'));
    if (!roomName) return;

    const room = rooms.get(roomName);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player && !player.ready) {
        player.ready = true;
        io.to(roomName).emit('ready-update', { id: socket.id, ready: true });

        if (room.players.every(p => p.ready)) {
            io.to(roomName).emit('game-start', {
                players: room.players.map(p => ({ id: p.id, username: p.username, symbol: p.symbol, elo: p.elo })),
                currentTurn: 'X'
            });
            startTimer(roomName);
        }
    }
}

// --- AI Logic (Minimax) ---
function makeAIMove(roomName) {
    const room = rooms.get(roomName);
    if (!room || room.currentTurn !== 'O' || !room.isAI) return;

    const bestMove = getBestMove(room.board, room.marks.O);

    // Simulate make-move logic
    room.board[bestMove] = 'O';
    room.marks.O.push(bestMove);
    if (room.marks.O.length > 3) {
        const oldIndex = room.marks.O.shift();
        room.board[oldIndex] = null;
    }

    const winData = checkWinner(room.board);
    if (winData) {
        saveAndEndGame(roomName, winData.symbol === 'draw' ? 'draw' : 'win', winData.symbol, winData.line);
    } else {
        room.currentTurn = 'X';
        startTimer(roomName);
        io.to(roomName).emit('game-state', {
            board: room.board,
            currentTurn: room.currentTurn,
            marks: room.marks
        });
    }
}

function getBestMove(board, aiMarks) {
    let bestScore = -Infinity;
    let move;
    for (let i = 0; i < 9; i++) {
        if (board[i] === null) {
            // Predict mark removal if 4th mark
            let removedMark = null;
            let tempBoard = [...board];
            let tempAiMarks = [...aiMarks];

            tempBoard[i] = 'O';
            tempAiMarks.push(i);
            if (tempAiMarks.length > 3) {
                removedMark = tempAiMarks.shift();
                tempBoard[removedMark] = null;
            }

            let score = minimax(tempBoard, 0, false, tempAiMarks, []); // Basic minimax for now
            if (score > bestScore) {
                bestScore = score;
                move = i;
            }
        }
    }
    return move;
}

function minimax(board, depth, isMaximizing, aiMarks, playerMarks) {
    const winData = checkWinner(board);
    if (winData) return winData.symbol === 'O' ? 10 - depth : depth - 10;
    // Basic draw check
    if (!board.includes(null)) return 0;
    if (depth > 4) return 0; // Depth limit for performance

    if (isMaximizing) {
        let bestScore = -Infinity;
        for (let i = 0; i < 9; i++) {
            if (board[i] === null) {
                let tempBoard = [...board];
                let tempAiMarks = [...aiMarks];
                tempBoard[i] = 'O';
                tempAiMarks.push(i);
                if (tempAiMarks.length > 3) tempBoard[tempAiMarks.shift()] = null;

                let score = minimax(tempBoard, depth + 1, false, tempAiMarks, playerMarks);
                bestScore = Math.max(score, bestScore);
            }
        }
        return bestScore;
    } else {
        let bestScore = Infinity;
        for (let i = 0; i < 9; i++) {
            if (board[i] === null) {
                let tempBoard = [...board];
                let tempPlayerMarks = [...playerMarks];
                tempBoard[i] = 'X';
                tempPlayerMarks.push(i);
                if (tempPlayerMarks.length > 3) tempBoard[tempPlayerMarks.shift()] = null;

                let score = minimax(tempBoard, depth + 1, true, aiMarks, tempPlayerMarks);
                bestScore = Math.min(score, bestScore);
            }
        }
        return bestScore;
    }
}

function checkWinner(board) {
    const lines = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
        [0, 4, 8], [2, 4, 6]             // diagonals
    ];
    for (let line of lines) {
        const [a, b, c] = line;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return { symbol: board[a], line };
        }
    }
    if (!board.includes(null)) return { symbol: 'draw', line: null };
    return null;
}

process.on('uncaughtException', (err) => {
    console.error('Fatal Error:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

