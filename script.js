/**
 * script.js
 * Client-side logic for multiplayer Tic-Tac-Toe
 * Handles UI updates, socket events, and timer synchronization.
 */

let socket;
let myUsername = '';

// --- DEPLOYMENT CONFIGURATION ---
// If you are deploying to Render, put your Render URL here (e.g., 'https://your-app.onrender.com')
// Leave it as an empty string for local development or if using same-host hosting.
// const BACKEND_URL = ''; 

const BACKEND_URL = 'https://neon-strike-api.onrender.com';
const SERVER_URL = BACKEND_URL || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? '' : '');

// --------------------------------
let mySymbol = null;
let currentTurn = 'X';
let gameActive = false;
let timerInterval = null;
let myId = null;
let countdownInterval = null;

// --- Audio Controller (Native Synthesizer) ---
class AudioController {
    constructor() {
        this.muted = localStorage.getItem('ttt_muted') === 'true';
        this.ctx = null;
        this.updateToggleButton();
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    play(name) {
        if (this.muted) return;
        this.init();
        if (this.ctx.state === 'suspended') this.ctx.resume();

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        const now = this.ctx.currentTime;

        switch (name) {
            case 'move':
                osc.type = 'sine';
                osc.frequency.setValueAtTime(400, now);
                osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);
                gain.gain.setValueAtTime(0.3, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
                osc.start(now);
                osc.stop(now + 0.1);
                break;
            case 'match':
                osc.type = 'square';
                osc.frequency.setValueAtTime(150, now);
                osc.frequency.exponentialRampToValueAtTime(600, now + 0.3);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
                osc.start(now);
                osc.stop(now + 0.3);
                break;
            case 'win':
                osc.type = 'triangle';
                [0, 0.1, 0.2].forEach((t, i) => {
                    const o = this.ctx.createOscillator();
                    const g = this.ctx.createGain();
                    o.type = 'triangle';
                    o.frequency.setValueAtTime(440 + i * 110, now + t);
                    g.gain.setValueAtTime(0.2, now + t);
                    g.gain.exponentialRampToValueAtTime(0.01, now + t + 0.4);
                    o.connect(g);
                    g.connect(this.ctx.destination);
                    o.start(now + t);
                    o.stop(now + t + 0.4);
                });
                break;
            case 'lose':
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(200, now);
                osc.frequency.linearRampToValueAtTime(50, now + 0.5);
                gain.gain.setValueAtTime(0.2, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
                osc.start(now);
                osc.stop(now + 0.5);
                break;
            case 'draw':
            case 'click':
                osc.type = 'sine';
                osc.frequency.setValueAtTime(800, now);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
                osc.start(now);
                osc.stop(now + 0.05);
                break;
        }
    }

    toggleMute() {
        this.muted = !this.muted;
        localStorage.setItem('ttt_muted', this.muted);
        this.updateToggleButton();
        if (!this.muted) this.play('click');
    }

    updateToggleButton() {
        const btn = document.getElementById('sound-toggle');
        if (!btn) return;
        const icon = btn.querySelector('.icon');
        if (this.muted) {
            btn.classList.add('muted');
            icon.textContent = '⭰';
        } else {
            btn.classList.remove('muted');
            icon.textContent = '🔊';
        }
    }
}

const audio = new AudioController();
document.getElementById('sound-toggle').onclick = () => audio.toggleMute();

let userToken = localStorage.getItem('ttt_token');
let userData = JSON.parse(localStorage.getItem('ttt_user') || 'null');

// DOM Elements - Auth & Dashboard
const authScreen = document.getElementById('auth-screen');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const regDisplayName = document.getElementById('reg-display-name');
const regUsername = document.getElementById('reg-username');
const regPassword = document.getElementById('reg-password');
const authError = document.getElementById('auth-error');

// UI Elements (Single Declarations)
const viewMechanicsBtn = document.getElementById('view-mechanics-btn');
const eraserBtns = document.querySelectorAll('.eraser-btn');
const powerUpsDiv = document.getElementById('power-ups');
const p1Bp = document.getElementById('p1-bp');
const p2Bp = document.getElementById('p2-bp');

// --- Input Validation: Prevent Whitespace in Usernames ---
[loginUsername, regUsername].forEach(input => {
    input.addEventListener('input', () => {
        input.value = input.value.replace(/\s/g, '');
    });
});

const dashboard = document.getElementById('dashboard');
const dashDisplayName = document.getElementById('dash-display-name');

// DOM Elements - Info Modals
const infoModalOverlay = document.getElementById('info-modal-overlay');
const infoModalTitle = document.getElementById('info-modal-title');
const infoModalContent = document.getElementById('info-modal-content');

// DOM Elements - Game UI
const waitScreen = document.getElementById('wait-screen');
const matchFlash = document.getElementById('match-flash');
const opponentNameEl = document.getElementById('opponent-name');
const readyScreen = document.getElementById('ready-screen');
const readyBtn = document.getElementById('ready-btn');
const p1ReadyCard = document.getElementById('p1-ready-card');
const p2ReadyCard = document.getElementById('p2-ready-card');
const p2ReadyName = document.getElementById('p2-ready-name');

const gameScreen = document.getElementById('game-screen');
const modalOverlay = document.getElementById('modal-overlay');

const p1Name = document.getElementById('p1-name');
const p1Role = document.getElementById('p1-role');
const p2Name = document.getElementById('p2-name');
const p2Role = document.getElementById('p2-role');
const turnIndicator = document.getElementById('turn-indicator');
const mySymbolEl = document.getElementById('my-symbol');

const timerBar = document.getElementById('timer-bar');
const timerText = document.getElementById('timer-text');

const cells = document.querySelectorAll('.cell');

const modalResult = document.getElementById('modal-result');
const modalMsg = document.getElementById('modal-msg');
const rematchBtn = document.getElementById('rematch-btn');
const declineBtn = document.getElementById('decline-btn');
const waitingRefusal = document.getElementById('waiting-refusal');
const refusedMsg = document.getElementById('refused-msg');

const readyTimerVal = document.getElementById('ready-timer-val');
const resultTimerVal = document.getElementById('result-timer-val');
const resultTimer = document.querySelector('.result-timer');

let matchmakingTimeout = null;

// --- API Helpers ---
async function apiCall(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Bypass-Tunnel-Reminder': 'true',
            'ngrok-skip-browser-warning': 'true'
        }
    };
    if (userToken) options.headers['Authorization'] = `Bearer ${userToken}`;
    if (body) options.body = JSON.stringify(body);

    const fullUrl = endpoint.startsWith('http') ? endpoint : `${SERVER_URL}${endpoint}`;
    const res = await fetch(fullUrl, options);
    const contentType = res.headers.get('content-type');
    let data;
    if (contentType && contentType.includes('application/json')) {
        data = await res.json();
    } else {
        const text = await res.text();
        data = { error: 'Invalid response from server' };
    }

    if (!res.ok) throw new Error(data.error || `HTTP error! status: ${res.status}`);
    return data;
}

// --- Auth Flow ---
function initAuth() {
    if (userToken && userData) {
        showDashboard();
    }

    document.getElementById('show-register').onclick = () => {
        loginForm.classList.add('hidden');
        registerForm.classList.remove('hidden');
        authError.textContent = '';
    };

    document.getElementById('show-login').onclick = () => {
        registerForm.classList.add('hidden');
        loginForm.classList.remove('hidden');
        authError.textContent = '';
    };

    document.getElementById('register-btn').onclick = async () => {
        const username = document.getElementById('reg-username').value;
        const display_name = document.getElementById('reg-display-name').value;
        const password = document.getElementById('reg-password').value;
        const passwordConfirm = document.getElementById('reg-password-confirm').value;
        if (password !== passwordConfirm) {
            authError.textContent = 'Passwords do not match';
            return;
        }
        try {
            audio.play('click');
            await apiCall('/api/register', 'POST', { username, display_name, password });
            alert('Registration successful! Please login.');
            document.getElementById('show-login').click();
        } catch (err) { authError.textContent = err.message; }
    };

    document.getElementById('login-btn').onclick = async () => {
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        try {
            audio.play('click');
            const data = await apiCall('/api/login', 'POST', { username, password });
            userToken = data.token;
            userData = data.user;
            localStorage.setItem('ttt_token', userToken);
            localStorage.setItem('ttt_user', JSON.stringify(userData));
            showDashboard();
        } catch (err) { authError.textContent = err.message; }
    };
}

function showDashboard() {
    authScreen.classList.add('hidden');
    dashboard.classList.remove('hidden');
    dashDisplayName.textContent = userData.display_name.toUpperCase();
}

document.getElementById('logout-btn').onclick = () => {
    localStorage.removeItem('ttt_token');
    localStorage.removeItem('ttt_user');
    window.location.reload();
};

initAuth();

// --- Dashboard Actions ---
document.getElementById('find-match-btn').onclick = () => {
    audio.play('click');
    dashboard.classList.add('hidden');
    connectSocket();
};

const cancelSearchBtn = document.getElementById('cancel-search-btn');
const playAiBtn = document.getElementById('play-ai-btn');

cancelSearchBtn.onclick = () => {
    if (socket) {
        socket.emit('cancel-search');
        socket.disconnect();
    }
    clearTimeout(matchmakingTimeout);
    playAiBtn.classList.add('hidden');
    waitScreen.classList.add('hidden');
    dashboard.classList.remove('hidden');
};

playAiBtn.onclick = () => {
    if (socket) socket.emit('play-ai');
    playAiBtn.classList.add('hidden');
};

document.getElementById('view-profile-btn').onclick = async () => {
    try {
        const profile = await apiCall('/api/profile');
        showInfoModal('YOUR PROFILE', `
            <div class="leader-item"><span>DISPLAY NAME</span> <span>${profile.display_name}</span></div>
            <div class="leader-item"><span>BP</span> <span class="cyan">${profile.elo}</span></div>
            <div class="leader-item"><span>WINS</span> <span class="win">${profile.wins}</span></div>
            <div class="leader-item"><span>LOSSES</span> <span class="loss">${profile.losses}</span></div>
            <div class="leader-item"><span>DRAWS</span> <span class="draw">${profile.draws}</span></div>
        `);
    } catch (err) { alert(err.message); }
};

document.getElementById('view-history-btn').onclick = async () => {
    try {
        const history = await apiCall('/api/history');
        let html = history.map(g => {
            const isWinner = g.winner_id === userData.id;
            const isDraw = g.winner_id === null;
            const statusClass = isDraw ? 'draw' : (isWinner ? 'win' : 'loss');
            const statusText = isDraw ? 'DRAW' : (isWinner ? 'WIN' : 'LOSS');
            const opponent = g.player1_id === userData.id ? g.p2_name : g.p1_name;
            return `<div class="history-item"><span>vs ${opponent}</span><span class="${statusClass}">${statusText}</span></div>`;
        }).join('');
        showInfoModal('GAME HISTORY', html || '<p>No matches played yet.</p>');
    } catch (err) { alert(err.message); }
};

document.getElementById('view-leaderboard-btn').onclick = async () => {
    try {
        const players = await apiCall('/api/leaderboard');
        let html = `
            <table class="leader-table">
                <thead><tr><th>RANK</th><th>PLAYER</th><th>BP</th><th>WINS</th></tr></thead>
                <tbody>
                    ${players.map((p, i) => {
            const rankClass = i === 0 ? 'rank-gold' : (i === 1 ? 'rank-silver' : (i === 2 ? 'rank-bronze' : ''));
            const rankIcon = i === 0 ? '👑 ' : (i === 1 ? '🥈 ' : (i === 2 ? '🥉 ' : ''));
            return `<tr><td>${i + 1}</td><td class="${rankClass}">${rankIcon}${p.display_name}</td><td class="pink">${p.elo || 1000}</td><td class="cyan">${p.wins}</td></tr>`;
        }).join('')}
                </tbody>
            </table>`;
        showInfoModal('LEADERBOARDS', html || '<p>No rankings yet.</p>');
    } catch (err) { alert(err.message); }
};

viewMechanicsBtn.onclick = () => {
    showInfoModal('GAME MECHANICS', `
        <div class="guide-item"><h3>Basic Rules</h3><p>Get 3 in a row to win! But beware... the <strong>Infinite Rule</strong> is active.</p></div>
        <div class="guide-item"><h3>Infinite Rule</h3><p>You can only have 3 marks on the board. When you place your 4th mark, your 1st mark <strong>disappears</strong>.</p></div>
        <div class="guide-item"><h3>Eraser Power-up</h3><p>You have 3 Erasers (🪄). Use them to delete any of your opponent's marks. This consumes your turn!</p></div>
        <div class="guide-item"><h3>Battle Points (BP)</h3><p>Win matches to gain BP. Losing or timing out will cost you BP. Good luck!</p></div>
    `);
};

function showInfoModal(title, content) {
    infoModalTitle.textContent = title;
    infoModalContent.innerHTML = content;
    infoModalOverlay.classList.remove('hidden');
}

document.getElementById('close-info-modal').onclick = () => {
    audio.play('click');
    infoModalOverlay.classList.add('hidden');
};

// --- Socket Logic ---
function connectSocket() {
    waitScreen.classList.remove('hidden');

    socket = io(SERVER_URL, {
        auth: { token: userToken },
        transports: ['polling', 'websocket'],
        reconnectionAttempts: 5
    });

    socket.on('connect', () => { myId = socket.id; });
    socket.on('connect_error', (err) => { 
        console.error('Socket Connection Error:', err);
    });

    matchmakingTimeout = setTimeout(() => {
        if (!gameActive && !waitScreen.classList.contains('hidden')) playAiBtn.classList.remove('hidden');
    }, 8000);

    setupSocketEvents();
}

readyBtn.addEventListener('click', () => {
    audio.play('click');
    socket.emit('player-ready');
    readyBtn.classList.add('hidden');
    p1ReadyCard.classList.add('is-ready');
    p1ReadyCard.querySelector('.status').textContent = 'READY';
});

eraserBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        audio.play('click');
        if (currentTurn !== mySymbol) return;
        eraserBtns.forEach(b => b !== btn && b.classList.remove('active'));
        btn.classList.toggle('active');
    });
});

cells.forEach(cell => {
    cell.addEventListener('click', () => {
        const index = cell.getAttribute('data-index');
        const activeEraser = Array.from(eraserBtns).find(b => b.classList.contains('active'));

        if (activeEraser) {
            const symbol = cell.getAttribute('data-symbol');
            const opponentSymbol = mySymbol === 'X' ? 'O' : 'X';
            if (symbol === opponentSymbol) {
                socket.emit('use-eraser', { index });
                activeEraser.classList.remove('active');
                activeEraser.disabled = true;
                activeEraser.classList.add('used');
            }
            return;
        }
        if (currentTurn === mySymbol && !cell.textContent) socket.emit('make-move', { index });
    });
});

rematchBtn.addEventListener('click', () => {
    socket.emit('rematch-request');
    rematchBtn.classList.add('hidden');
    declineBtn.classList.add('hidden');
    waitingRefusal.classList.remove('hidden');
});

declineBtn.addEventListener('click', () => {
    socket.emit('rematch-decline');
    window.location.reload();
});

function setupSocketEvents() {
    socket.on('waiting', (msg) => { document.getElementById('wait-msg').textContent = msg; });

    socket.on('match-found', ({ players }) => {
        const opponent = players.find(p => p.id !== socket.id);
        waitScreen.classList.add('hidden');
        opponentNameEl.textContent = opponent.username;
        matchFlash.classList.remove('hidden');
        audio.play('match');

        setTimeout(() => {
            matchFlash.classList.add('hidden');
            p2ReadyName.textContent = opponent.username;
            readyScreen.classList.remove('hidden');
            if (opponent.id === 'ai-bot') {
                p2ReadyCard.classList.add('is-ready');
                p2ReadyCard.querySelector('.status').textContent = 'ALWAYS READY';
            }
            readyBtn.classList.remove('hidden');
            startCountdown(6, readyTimerVal, () => {
                if (!readyBtn.classList.contains('hidden')) {
                    socket.emit('player-ready');
                    readyBtn.classList.add('hidden');
                    p1ReadyCard.classList.add('is-ready');
                }
            });
        }, 2500);
    });

    socket.on('ready-update', ({ id, ready, allReady }) => {
        if (allReady) { clearInterval(countdownInterval); return; }
        if (id !== socket.id && ready) {
            p2ReadyCard.classList.add('is-ready');
            p2ReadyCard.querySelector('.status').textContent = 'READY';
        }
    });

    socket.on('game-start', ({ players, currentTurn: startTurn }) => {
        const me = players.find(p => p.id === socket.id);
        const opponent = players.find(p => p.id !== socket.id);
        mySymbol = me.symbol;
        currentTurn = startTurn;
        gameActive = true;

        p1Name.textContent = 'YOU';
        p1Role.textContent = me.symbol;
        if (p1Bp) p1Bp.textContent = `BP: ${me.elo || 1000}`;
        p2Name.textContent = opponent.username.toUpperCase();
        p2Role.textContent = opponent.symbol;
        if (p2Bp) p2Bp.textContent = `BP: ${opponent.elo || 1000}`;

        mySymbolEl.textContent = mySymbol;
        updateTurnUI();
        resetBoard();
        document.getElementById('board').classList.remove('shake');
        readyScreen.classList.add('hidden');
        modalOverlay.classList.add('hidden');
        gameScreen.classList.remove('hidden');
        powerUpsDiv.classList.remove('hidden');
        eraserBtns.forEach(btn => { btn.disabled = false; btn.classList.remove('used', 'active'); });
        audio.play('click');
    });

    socket.on('game-state', ({ board, currentTurn: nextTurn, marks }) => {
        // Only update if game is active or it's the final sync
        let boardChanged = false;

        currentTurn = nextTurn;
        board.forEach((symbol, i) => {
            const cell = cells[i];
            if (cell.textContent !== symbol) boardChanged = true;
            cell.textContent = symbol;
            cell.setAttribute('data-symbol', symbol);
            cell.classList.remove('fading');
            if (marks && marks[symbol]?.length === 3 && marks[symbol][0] == i) cell.classList.add('fading');
        });

        // Play move sound ONLY if the board actually changed
        if (boardChanged) audio.play('move');

        // Only update turn UI if game is still active
        if (gameActive) updateTurnUI();
    });

    socket.on('game-over', ({ type, result, board, winningLine }) => {
        if (!gameActive) return; // Prevent double trigger
        gameActive = false;
        stopTurnTimer();

        if (winningLine) {
            winningLine.forEach(index => cells[index].classList.add('winning-cell'));
            document.getElementById('board').classList.add('shake');
        }

        modalOverlay.classList.remove('hidden');
        rematchBtn.classList.remove('hidden');
        declineBtn.classList.remove('hidden');

        if (type === 'draw') {
            modalResult.textContent = "IT'S A DRAW!";
            audio.play('draw');
        } else {
            const isMe = result === mySymbol;
            modalResult.textContent = isMe ? "YOU WIN!" : "YOU LOSE!";
            audio.play(isMe ? 'win' : 'lose');
        }
        startCountdown(6, resultTimerVal, () => { });
    });

    socket.on('return-to-dashboard', () => window.location.reload());
    socket.on('timer-update', (duration) => startClientTimer(duration));
}

function startClientTimer(duration) {
    turnTimeLeft = Math.ceil(duration / 1000);
    const curTimeDisplay = document.getElementById('turn-time-left');
    if (curTimeDisplay) curTimeDisplay.textContent = `${Math.max(0, turnTimeLeft)}s`;
    turnProgressBar.style.width = `${(turnTimeLeft / MAX_TURN_TIME) * 100}%`;
}

function startCountdown(seconds, displayEl, onComplete) {
    clearInterval(countdownInterval);
    let timeLeft = seconds;
    displayEl.textContent = timeLeft;
    countdownInterval = setInterval(() => {
        timeLeft--;
        displayEl.textContent = timeLeft;
        if (timeLeft <= 0) { clearInterval(countdownInterval); if (onComplete) onComplete(); }
    }, 1000);
}

function renderBoardFromState(board) {
    board.forEach((symbol, i) => {
        const cell = cells[i];
        cell.textContent = symbol;
        cell.setAttribute('data-symbol', symbol);
        cell.classList.remove('fading');
    });
}

// --- Service Worker Registration ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js')
            .then(reg => console.log('Service Worker registered:', reg.scope))
            .catch(err => console.log('Service Worker registration failed:', err));
    });
}

// --- Turn Indicator Logic ---
const MAX_TURN_TIME = 10;
let turnTimeLeft = MAX_TURN_TIME;
let turnTimerInterval = null;
const turnPill = document.getElementById('turn-pill');
const turnProgressBar = document.getElementById('turn-progress-bar');
const turnDisplayText = document.getElementById('turn-display-text');

function startTurnTimer(isMyTurn) {
    if (!gameActive) return; // Guard: Don't start timer if game is over
    clearInterval(turnTimerInterval);
    turnTimeLeft = MAX_TURN_TIME;

    // Fast Reset: Instantly jump to 100% without transition
    turnProgressBar.style.transition = 'none';
    turnProgressBar.style.width = '100%';
    void turnProgressBar.offsetWidth; // Force reflow
    turnProgressBar.style.transition = 'width 1s linear';

    if (isMyTurn) {
        turnPill.className = "my-turn";
        turnDisplayText.innerHTML = `YOUR TURN <span id="turn-time-left">${MAX_TURN_TIME}s</span>`;
    } else {
        turnPill.className = "opponent-turn";
        turnDisplayText.innerHTML = `OPPONENT'S TURN <span id="turn-time-left">${MAX_TURN_TIME}s</span>`;
    }

    turnTimerInterval = setInterval(() => {
        turnTimeLeft--;
        const curTimeDisplay = document.getElementById('turn-time-left');
        if (curTimeDisplay) curTimeDisplay.textContent = `${Math.max(0, turnTimeLeft)}s`;
        turnProgressBar.style.width = `${(turnTimeLeft / MAX_TURN_TIME) * 100}%`;

        if (turnTimeLeft <= 0) {
            stopTurnTimer();
            if (isMyTurn) socket.emit('make-move', { index: -1, timeout: true });
        }
    }, 1000);
}

function stopTurnTimer() { clearInterval(turnTimerInterval); }

function updateTurnUI() { startTurnTimer(currentTurn === mySymbol); }

function resetBoard() {
    cells.forEach(cell => {
        cell.textContent = '';
        cell.removeAttribute('data-symbol');
        cell.classList.remove('winning-cell', 'fading');
    });
}