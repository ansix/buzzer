require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const session = require("express-session");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingInterval: 2000,
    pingTimeout: 4000,
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || "buzzer-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

app.get("/", (req, res) => {
    res.redirect("/player");
});

app.get("/host", async (req, res) => {
    if (req.session.isHost) {
        // Generate QR Code for players
        const protocol = req.protocol;
        const host = req.get("host");
        const playerUrl = `${protocol}://${host}/player`;
        
        try {
            const qrCodeData = await QRCode.toDataURL(playerUrl);
            res.render("host", { qrCodeData, playerUrl });
        } catch (err) {
            console.error("QR Code generation failed", err);
            res.render("host", { qrCodeData: null, playerUrl });
        }
    } else {
        res.render("host_login", { error: null });
    }
});

app.post("/host/login", (req, res) => {
    const { password } = req.body;
    const hostPassword = process.env.HOST_PASSWORD || "admin";

    if (password === hostPassword) {
        req.session.isHost = true;
        res.redirect("/host");
    } else {
        res.render("host_login", { error: "Falsches Passwort" });
    }
});

app.get("/player", (req, res) => {
    res.render("player");
});

const PORT = process.env.PORT || 3000;

// --- Game state ---
let locked = false;                // true when a winner is on screen (and during countdown)
let awaitingDecision = false;      // host must judge correct/wrong
let winner = null;                // { name, at, msFromStart }
let roundStartAt = null;          // epoch ms
let countdown = { running: false, remaining: 0 };
let scores = new Map();           // name -> points

// --- Round config ---
let roundPoints = 1;              // points for current round
let subtractOnWrong = false;      // subtract points if answer is wrong
let autoUnlockTimeout = 10000;    // ms for auto-unlock after buzz (0 = disabled)
let autoUnlockTimer = null;       // JS Timer handle

// registered users + presence
let usersByName = new Map();   // name -> { name, online, socketId, lastSeenAt, reconnectTimer }
let nameBySocket = new Map();  // socketId -> name

// queue of additional buzzes (for "wrong -> next chance")
let buzzQueue = [];               // [{ name, at, msFromStart }]

function nowMs() {
    return Date.now();
}

function sanitizeName(name) {
    if (typeof name !== "string") return "Unknown";
    const trimmed = name.trim().slice(0, 24);
    return trimmed.length ? trimmed : "Unknown";
}

function getLeaderboard() {
    return [...scores.entries()]
        .map(([name, points]) => {
            const user = usersByName.get(name);
            return { name, points, emoji: user ? user.emoji : "👤" };
        })
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
        .slice(0, 10);
}

function broadcastState() {
    const userList = [...usersByName.values()]
        .sort((a, b) => a.name.localeCompare(b.name));

    io.emit("state", {
        locked,
        awaitingDecision,
        winner,
        roundStartAt,
        countdown,
        roundPoints,
        subtractOnWrong,
        autoUnlockTimeout,
        leaderboard: getLeaderboard(),
        queueSize: buzzQueue.length,
        queue: buzzQueue.map(e => {
            const user = usersByName.get(e.name);
            return { name: e.name, msFromStart: e.msFromStart, emoji: user ? user.emoji : "👤" };
        }),
        users: userList.map(u => ({
            name: u.name,
            online: u.online,
            emoji: u.emoji,
            points: scores.get(u.name) || 0
        })), // minimal für Player/Host UI
    });
}

function setWinnerFromEntry(entry) {
    const user = usersByName.get(entry.name);
    winner = { ...entry, emoji: user ? user.emoji : "👤" };
    locked = true;
    awaitingDecision = true;

    // Auto-unlock timer
    if (autoUnlockTimer) clearTimeout(autoUnlockTimer);
    if (autoUnlockTimeout > 0) {
        autoUnlockTimer = setTimeout(() => {
            if (winner && awaitingDecision) {
                // Auto-judge as WRONG (or just clear)
                handleJudgement(false);
            }
        }, autoUnlockTimeout);
    }

    io.emit("winner", { winner, leaderboard: getLeaderboard(), queueSize: buzzQueue.length });
    broadcastState();
}

function handleJudgement(correct) {
    if (!winner || !awaitingDecision) return;
    
    if (autoUnlockTimer) clearTimeout(autoUnlockTimer);

    const name = winner.name;
    let delta = 0;

    if (correct) {
        delta = roundPoints;
        scores.set(name, (scores.get(name) || 0) + delta);

        io.emit("judgement", {
            name,
            correct: true,
            delta: delta,
            leaderboard: getLeaderboard(),
        });

        awaitingDecision = false;
        buzzQueue = [];
        broadcastState();
        return;
    }

    // WRONG
    if (subtractOnWrong) {
        delta = -roundPoints;
        const current = scores.get(name) || 0;
        scores.set(name, Math.max(0, current + delta));
    }

    io.emit("judgement", {
        name,
        correct: false,
        delta: delta,
        leaderboard: getLeaderboard(),
    });

    const next = buzzQueue.shift() || null;
    if (next) {
        setWinnerFromEntry(next);
    } else {
        awaitingDecision = false;
        winner = null;
        locked = false;
        broadcastState();
        io.emit("noNextCandidate");
    }
}

function clearRound(keepScores = true) {
    if (autoUnlockTimer) clearTimeout(autoUnlockTimer);
    locked = false;
    awaitingDecision = false;
    winner = null;
    buzzQueue = [];
    roundStartAt = nowMs();
    if (!keepScores) scores = new Map();
}

io.on("connection", (socket) => {
    // socket.data.name will be set once and then never changed
    socket.data.name = null;

    socket.emit("state", {
        locked,
        awaitingDecision,
        winner,
        roundStartAt,
        countdown,
        roundPoints,
        subtractOnWrong,
        autoUnlockTimeout,
        leaderboard: getLeaderboard(),
        queueSize: buzzQueue.length,
        queue: buzzQueue.map(e => ({ name: e.name, msFromStart: e.msFromStart })),
    });

    // NEW: register name (server enforces lock, but allows update for same socket)
    socket.on("registerName", (payload) => {
        let rawName, emoji;
        if (typeof payload === "string") {
            rawName = payload;
            emoji = "👤";
        } else {
            rawName = payload.name;
            emoji = payload.emoji || "👤";
        }

        const name = sanitizeName(rawName);

        // If name already exists and is ONLINE on another socket => reject
        const existing = usersByName.get(name);
        if (existing && existing.online && existing.socketId !== socket.id) {
            socket.emit("nameRejected", { reason: "NAME_TAKEN", name });
            return;
        }

        // Reconnect logic: if user was in a "grace period" (disconnect pending), clear it
        if (existing && existing.reconnectTimer) {
            clearTimeout(existing.reconnectTimer);
            existing.reconnectTimer = null;
        }

        // If user already had a name, and is changing it, clean up old name
        if (socket.data.name && socket.data.name !== name) {
            usersByName.delete(socket.data.name);
            scores.delete(socket.data.name); // Optional: scores could be kept, but usually name change = new identity
        }

        // lock name on socket
        socket.data.name = name;
        socket.data.emoji = emoji;
        nameBySocket.set(socket.id, name);

        // mark presence online
        usersByName.set(name, {
            name,
            emoji,
            online: true,
            socketId: socket.id,
            lastSeenAt: nowMs(),
        });

        socket.emit("nameLocked", { name, emoji });
        broadcastState();
    });

    socket.on("reaction", (emoji) => {
        const name = socket.data.name;
        if (!name) return;
        io.emit("reaction", { name, emoji });
    });

    socket.on("buzz", () => {
        // no name in payload anymore; server uses locked name
        const name = socket.data.name;
        if (!name) return;                 // must register first
        if (countdown.running) return;     // ignore during countdown

        const at = nowMs();
        const msFromStart = roundStartAt ? at - roundStartAt : null;
        const entry = { name, at, msFromStart };

        // If no current winner yet and not awaiting decision: first buzz becomes winner
        if (!winner && !awaitingDecision) {
            setWinnerFromEntry(entry);
            return;
        }

        // Otherwise: collect into queue (for "wrong -> next")
        // Avoid duplicates by name (so one person can't spam)
        if (!buzzQueue.some((e) => e.name === name) && (!winner || winner.name !== name)) {
            buzzQueue.push(entry);
            // keep queue ordered by time
            buzzQueue.sort((a, b) => a.at - b.at);
            io.emit("queueUpdate", { queueSize: buzzQueue.length });
            broadcastState();
        }
    });

    // Host judges current winner
    socket.on("judgeWinner", (payload) => {
        handleJudgement(!!payload?.correct);
    });

    socket.on("setRoundPoints", (points) => {
        roundPoints = Math.max(0, Number(points) || 1);
        broadcastState();
    });

    socket.on("updateScore", ({ name, delta }) => {
        const current = scores.get(name) || 0;
        const next = current + (Number(delta) || 0);
        scores.set(name, Math.max(0, next));
        broadcastState();
    });

    socket.on("endGame", () => {
        const leaderboard = getLeaderboard();
        // Auch wenn das Leaderboard leer ist, senden wir ein Event, damit das UI reagieren kann (z.B. mit Fehlermeldung)
        io.emit("gameEnded", { 
            winner: leaderboard.length > 0 ? leaderboard[0] : { name: "Niemand", emoji: "🤷", points: 0 }, 
            leaderboard 
        });
    });

    socket.on("setSubtractOnWrong", (val) => {
        subtractOnWrong = !!val;
        broadcastState();
    });

    socket.on("setAutoUnlock", (ms) => {
        autoUnlockTimeout = Math.max(0, Number(ms) || 0);
        broadcastState();
    });

    socket.on("disconnect", () => {
        const name = nameBySocket.get(socket.id);
        if (name) {
            const u = usersByName.get(name);
            if (u && u.socketId === socket.id) {
                u.online = false;
                u.lastSeenAt = nowMs();

                // Grace period: Wait 10s before removing from queue/marking as truly gone
                if (u.reconnectTimer) clearTimeout(u.reconnectTimer);
                u.reconnectTimer = setTimeout(() => {
                    const latestU = usersByName.get(name);
                    if (latestU && !latestU.online) {
                        // Truly gone now
                        buzzQueue = buzzQueue.filter(e => e.name !== name);
                        broadcastState();
                    }
                }, 10000); // 10 seconds grace period

                usersByName.set(name, u);
            }
            nameBySocket.delete(socket.id);
        }
        broadcastState();
    });

    socket.on("offlineNow", () => {
        const name = nameBySocket.get(socket.id);
        if (!name) return;

        const u = usersByName.get(name);
        if (u && u.socketId === socket.id) {
            u.online = false;
            u.lastSeenAt = nowMs();
            usersByName.set(name, u);
        }

        // optional: auch aus der Queue werfen
        buzzQueue = buzzQueue.filter(e => e.name !== name);

        broadcastState();
    });

    socket.on("resetRound", () => {
        // fresh round, keep scores
        clearRound(true);
        io.emit("roundReset", { roundStartAt });
        broadcastState();
    });

    socket.on("clearScores", () => {
        clearRound(false);
        broadcastState();
    });

    socket.on("clearPlayers", () => {
        clearRound(false);
        usersByName = new Map();
        nameBySocket = new Map();
        // Alle Sockets zwingen, ihren registrierten Namen zu vergessen
        const allSockets = io.sockets.sockets;
        for (const [id, s] of allSockets) {
            s.data.name = null;
        }
        io.emit("clearPlayers");
        broadcastState();
    });

    socket.on("startCountdown", (seconds) => {
        const sec = Math.max(1, Math.min(10, Number(seconds) || 3));
        if (countdown.running) return;

        // lock everything during countdown, clear round state
        locked = true;
        awaitingDecision = false;
        winner = null;
        buzzQueue = [];

        countdown = { running: true, remaining: sec };
        broadcastState();
        io.emit("countdown", { remaining: countdown.remaining });

        const interval = setInterval(() => {
            countdown.remaining -= 1;
            io.emit("countdown", { remaining: countdown.remaining });
            broadcastState();

            if (countdown.remaining <= 0) {
                clearInterval(interval);
                countdown = { running: false, remaining: 0 };

                locked = false;
                awaitingDecision = false;
                winner = null;
                buzzQueue = [];
                roundStartAt = nowMs();

                io.emit("countdownDone", { roundStartAt });
                broadcastState();
            }
        }, 1000);
    });
});

server.listen(PORT, () => {
    console.log(`Showmaster Buzzer läuft auf http://localhost:${PORT}`);
    console.log(`Host (Beamer):  http://localhost:${PORT}/host.html`);
    console.log(`Player (Handy): http://localhost:${PORT}/player.html`);
});