const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingInterval: 2000,
    pingTimeout: 4000,
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static("public"));

app.get("/", (req, res) => {
    res.redirect("/player");
});

app.get("/host", (req, res) => {
    res.render("host");
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
// registered users + presence
let usersByName = new Map();   // name -> { name, online, socketId, lastSeenAt }
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
        .map(([name, points]) => ({ name, points }))
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
        leaderboard: getLeaderboard(),
        queueSize: buzzQueue.length,
        queue: buzzQueue.map(e => ({ name: e.name, msFromStart: e.msFromStart })),
        users: userList.map(u => ({ name: u.name, online: u.online })), // minimal fürs UI
    });
}

function setWinnerFromEntry(entry) {
    winner = entry;
    locked = true;
    awaitingDecision = true;

    io.emit("winner", { winner, leaderboard: getLeaderboard(), queueSize: buzzQueue.length });
    broadcastState();
}

function clearRound(keepScores = true) {
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
        leaderboard: getLeaderboard(),
        queueSize: buzzQueue.length,
        queue: buzzQueue.map(e => ({ name: e.name, msFromStart: e.msFromStart })),
    });

    // NEW: register name once (server enforces lock)
    socket.on("registerName", (rawName) => {
        // already locked for this socket
        if (socket.data.name) {
            socket.emit("nameLocked", { name: socket.data.name });
            return;
        }

        const name = sanitizeName(rawName);

        // If name already exists and is ONLINE on another socket => reject
        const existing = usersByName.get(name);
        if (existing && existing.online && existing.socketId !== socket.id) {
            socket.emit("nameRejected", { reason: "NAME_TAKEN", name });
            return;
        }

        // lock name on socket
        socket.data.name = name;
        nameBySocket.set(socket.id, name);

        // mark presence online
        usersByName.set(name, {
            name,
            online: true,
            socketId: socket.id,
            lastSeenAt: nowMs(),
        });

        socket.emit("nameLocked", { name });
        broadcastState();
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
        if (!winner || !awaitingDecision) return;

        const correct = !!payload?.correct;
        const name = winner.name;

        if (correct) {
            // scoring: correct +1
            scores.set(name, (scores.get(name) || 0) + 1);

            io.emit("judgement", {
                name,
                correct: true,
                delta: +1,
                leaderboard: getLeaderboard(),
            });

            // After correct: stop awaiting decision; keep locked until next round
            awaitingDecision = false;
            buzzQueue = []; // clear queue for next question
            broadcastState();
            return;
        }

        // WRONG: current winner gets -1 (optional)
        scores.set(name, (scores.get(name) || 0));

        io.emit("judgement", {
            name,
            correct: false,
            delta: 0,
            leaderboard: getLeaderboard(),
        });

        // Give 2nd chance to next person (from queue)
        const next = buzzQueue.shift() || null;

        if (next) {
            // Replace winner immediately, still awaiting decision
            setWinnerFromEntry(next);
        } else {
            // Nobody else buzzed -> keep locked but no awaiting decision (or you can keep awaiting)
            awaitingDecision = false;
            winner = null;
            locked = false; // open again if nobody queued
            broadcastState();
            io.emit("noNextCandidate");
        }
    });

    socket.on("disconnect", () => {
        const name = nameBySocket.get(socket.id);
        if (name) {
            const u = usersByName.get(name);
            if (u && u.socketId === socket.id) {
                u.online = false;
                u.lastSeenAt = nowMs();
                usersByName.set(name, u);
            }
            nameBySocket.delete(socket.id);

            // optional: aus Queue entfernen
            buzzQueue = buzzQueue.filter(e => e.name !== name);
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