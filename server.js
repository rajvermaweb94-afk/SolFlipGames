/**
 * server.js — SOL FLIP  (with Admin Panel)
 *
 * Player routes:
 *   GET  /api/status        → server health + treasury info
 *   POST /api/flip          → verify tx, RNG, payout
 *   GET  /api/history       → last 20 public flips
 *
 * Admin routes (password protected):
 *   POST /admin/login       → get session token
 *   GET  /admin/stats       → full dashboard stats
 *   GET  /admin/players     → all player details
 *   GET  /admin/flips       → full flip history
 *   GET  /admin/wallets     → all treasury wallets
 *   POST /admin/wallets     → add treasury wallet
 *   PUT  /admin/wallets/:id → set active wallet
 *   DELETE /admin/wallets/:id → remove wallet
 *   GET  /admin/settings    → get game settings
 *   POST /admin/settings    → update game settings
 *   POST /admin/ban         → ban a player wallet
 *   POST /admin/unban       → unban a player wallet
 *   GET  /admin/treasury/balance → check all wallet balances
 */

const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");
const {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, LAMPORTS_PER_SOL, clusterApiUrl,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

// ── Config ────────────────────────────────────────────────
const PORT          = process.env.PORT || 3005;
const DATA_DIR      = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const WALLETS_FILE  = path.join(DATA_DIR, "wallets.json");
const PLAYERS_FILE  = path.join(DATA_DIR, "players.json");
const SESSIONS      = new Map(); // token → expiry

// ── Ensure data dir ───────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Default settings ──────────────────────────────────────
const DEFAULT_SETTINGS = {
  network:         "testnet",
  minBet:          0.001,
  maxBet:          0.5,
  houseEdge:       0.04,
  gameEnabled:     true,
  adminPassword:   "admin123",   // CHANGE THIS!
  // Coin flip mode:
  //   "random"  = provably fair RNG (default)
  //   "auto_heads" = house always lands heads
  //   "auto_tails" = house always lands tails
  //   "manual"  = admin sets next result manually
  flipMode:        "random",
  manualNextResult: null,   // "heads" | "tails" | null
  maxPlayersOnline: 1000,
  sessionTimeoutMin: 60,
};

// ── Load / save helpers ───────────────────────────────────
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch(e) {}
  return fallback;
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Load persistent data ──────────────────────────────────
let settings = { ...DEFAULT_SETTINGS, ...loadJSON(SETTINGS_FILE, {}) };
let wallets  = loadJSON(WALLETS_FILE, []);  // [{id, label, publicKey, secretKey, active}]
let players  = loadJSON(PLAYERS_FILE, {});  // { pubkey: { ...stats } }

// Save settings immediately so file exists
saveJSON(SETTINGS_FILE, settings);

// ── Load treasury from treasury.json (original) ───────────
const TREASURY_FILE = path.join(__dirname, "treasury.json");
if (!fs.existsSync(TREASURY_FILE)) {
  console.error("\n❌  treasury.json not found! Run: node setup-treasury.js\n");
  process.exit(1);
}
const treasuryRaw     = JSON.parse(fs.readFileSync(TREASURY_FILE, "utf8"));
const primaryKeypair  = Keypair.fromSecretKey(Uint8Array.from(treasuryRaw.secretKey));

// Add primary treasury to wallets list if not already there
if (!wallets.find(w => w.publicKey === primaryKeypair.publicKey.toBase58())) {
  wallets.unshift({
    id:        "primary",
    label:     "Primary Treasury",
    publicKey: primaryKeypair.publicKey.toBase58(),
    secretKey: Array.from(primaryKeypair.secretKey),
    active:    true,
    addedAt:   new Date().toISOString(),
  });
  saveJSON(WALLETS_FILE, wallets);
}

// Ensure only one wallet is active
function getActiveWallet() {
  const active = wallets.find(w => w.active);
  if (!active) { wallets[0].active = true; return wallets[0]; }
  return active;
}
function getActiveKeypair() {
  const w = getActiveWallet();
  return Keypair.fromSecretKey(Uint8Array.from(w.secretKey));
}

// ── Solana connection ─────────────────────────────────────
let connection = new Connection(clusterApiUrl(settings.network), "confirmed");

function reconnect() {
  connection = new Connection(clusterApiUrl(settings.network), "confirmed");
}

// ── In-memory runtime data ────────────────────────────────
const flipHistory  = [];           // all flips this session
const onlineSessions = new Map();  // pubkey → lastSeen timestamp
const bannedWallets  = new Set(loadJSON(path.join(DATA_DIR, "banned.json"), []));

// ── Express ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Admin auth middleware ─────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || !SESSIONS.has(token)) {
    return res.status(401).json({ error: "Unauthorized — login required" });
  }
  const expiry = SESSIONS.get(token);
  if (Date.now() > expiry) {
    SESSIONS.delete(token);
    return res.status(401).json({ error: "Session expired" });
  }
  // Extend session
  SESSIONS.set(token, Date.now() + settings.sessionTimeoutMin * 60 * 1000);
  next();
}

// ── Helper: update player record ─────────────────────────
function updatePlayer(pubkey, flip) {
  if (!players[pubkey]) {
    players[pubkey] = {
      pubkey,
      firstSeen:   new Date().toISOString(),
      lastSeen:    new Date().toISOString(),
      totalFlips:  0,
      totalWins:   0,
      totalLosses: 0,
      totalWagered: 0,
      totalPayout:  0,
      netLoss:      0,   // positive = player lost money (house profit)
      banned:       false,
    };
  }
  const p = players[pubkey];
  p.lastSeen    = new Date().toISOString();
  p.totalFlips++;
  p.totalWagered += flip.betSol;
  if (flip.playerWon) {
    p.totalWins++;
    p.totalPayout += flip.payoutSol;
    p.netLoss     -= (flip.payoutSol - flip.betSol); // house lost
  } else {
    p.totalLosses++;
    p.netLoss += flip.betSol; // house gained
  }
  saveJSON(PLAYERS_FILE, players);
}

// ── Track online ──────────────────────────────────────────
function heartbeat(pubkey) {
  onlineSessions.set(pubkey, Date.now());
}
function getOnlinePlayers() {
  const cutoff = Date.now() - 5 * 60 * 1000; // 5 min window
  for (const [k, v] of onlineSessions) { if (v < cutoff) onlineSessions.delete(k); }
  return onlineSessions.size;
}

// Clean stale sessions every minute
setInterval(() => { getOnlinePlayers(); }, 60000);

// ════════════════════════════════════════════════════════
//  PLAYER ROUTES
// ════════════════════════════════════════════════════════

// GET /api/status
app.get("/api/status", async (req, res) => {
  try {
    const active  = getActiveWallet();
    const keypair = getActiveKeypair();
    const balance = await connection.getBalance(keypair.publicKey);
    const winMult = 2 * (1 - settings.houseEdge);
    res.json({
      ok:              true,
      network:         settings.network,
      treasuryPubkey:  active.publicKey,
      treasuryBalance: balance / LAMPORTS_PER_SOL,
      minBet:          settings.minBet,
      maxBet:          settings.maxBet,
      winMultiplier:   winMult,
      gameEnabled:     settings.gameEnabled,
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/history
app.get("/api/history", (req, res) => {
  res.json(flipHistory.slice(0, 20).map(f => ({
    betSol: f.betSol, side: f.side, result: f.result,
    playerWon: f.playerWon, timestamp: f.timestamp,
    playerPubkey: f.playerPubkey.slice(0,6) + "…" + f.playerPubkey.slice(-4),
  })));
});

// POST /api/heartbeat — player pings to show they're online
app.post("/api/heartbeat", (req, res) => {
  const { pubkey } = req.body;
  if (pubkey) heartbeat(pubkey);
  res.json({ ok: true });
});

// POST /api/flip
app.post("/api/flip", async (req, res) => {
  if (!settings.gameEnabled)
    return res.status(403).json({ error: "Game is currently disabled by admin" });

  const { txSignature, playerPubkey, betAmount, side } = req.body;

  if (!txSignature || !playerPubkey || !betAmount || !side)
    return res.status(400).json({ error: "Missing required fields" });
  if (!["heads", "tails"].includes(side))
    return res.status(400).json({ error: "side must be heads or tails" });

  const betSol = parseFloat(betAmount);
  if (isNaN(betSol) || betSol < settings.minBet || betSol > settings.maxBet)
    return res.status(400).json({ error: `Bet must be ${settings.minBet}–${settings.maxBet} SOL` });

  // Check ban
  if (bannedWallets.has(playerPubkey))
    return res.status(403).json({ error: "Your wallet has been banned" });

  // Replay protection
  if (flipHistory.some(f => f.txSignature === txSignature))
    return res.status(400).json({ error: "Transaction already used" });

  // Track online
  heartbeat(playerPubkey);

  // Verify tx on-chain
  let txInfo = null;
  for (let i = 0; i < 5; i++) {
    try {
      txInfo = await connection.getTransaction(txSignature, {
        commitment: "confirmed", maxSupportedTransactionVersion: 0,
      });
      if (txInfo) break;
    } catch(e) {}
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!txInfo)         return res.status(400).json({ error: "Transaction not found on-chain" });
  if (txInfo.meta?.err) return res.status(400).json({ error: "Transaction failed on-chain" });

  // Verify treasury received correct amount
  const activeWallet = getActiveWallet();
  const accountKeys  = txInfo.transaction.message.staticAccountKeys
    ?? txInfo.transaction.message.accountKeys;
  const tIdx = accountKeys.findIndex(k => k.toBase58() === activeWallet.publicKey);

  if (tIdx === -1)
    return res.status(400).json({ error: "Transaction did not send to active treasury" });

  const received = txInfo.meta.postBalances[tIdx] - txInfo.meta.preBalances[tIdx];
  const expected = Math.round(betSol * LAMPORTS_PER_SOL);
  if (received < expected - 10_000)
    return res.status(400).json({ error: `Expected ${betSol} SOL, received ${(received/LAMPORTS_PER_SOL).toFixed(6)}` });

  // ── COIN FLIP MODE ────────────────────────────────────
  let coinSide;

  if (settings.flipMode === "auto_heads") {
    coinSide = "heads";
  } else if (settings.flipMode === "auto_tails") {
    coinSide = "tails";
  } else if (settings.flipMode === "manual" && settings.manualNextResult) {
    coinSide = settings.manualNextResult;
    // Reset after use
    settings.manualNextResult = null;
    saveJSON(SETTINGS_FILE, settings);
  } else {
    // Default: provably fair RNG seeded by tx signature
    const sigBuf = Buffer.from(txSignature.slice(0, 16));
    const seed   = sigBuf.reduce((a, b) => (a * 31 + b) >>> 0, 0);
    coinSide     = (seed % 2 === 0) ? "heads" : "tails";
  }

  const playerWon = coinSide === side;
  const winMult   = 2 * (1 - settings.houseEdge);

  // Send payout if win
  let payoutTxSignature = null;
  let payoutSol = 0;

  if (playerWon) {
    payoutSol = parseFloat((betSol * winMult).toFixed(6));
    const payoutLamports = Math.round(payoutSol * LAMPORTS_PER_SOL);
    const keypair = getActiveKeypair();

    const bal = await connection.getBalance(keypair.publicKey);
    if (bal < payoutLamports + 10_000)
      return res.status(500).json({ error: "Treasury has insufficient funds" });

    try {
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey:   new PublicKey(playerPubkey),
        lamports:   payoutLamports,
      }));
      payoutTxSignature = await sendAndConfirmTransaction(
        connection, tx, [keypair], { commitment: "confirmed" }
      );
    } catch(e) {
      return res.status(500).json({ error: "Payout failed: " + e.message });
    }
  }

  // Record flip
  const record = {
    id: Date.now(), txSignature, payoutTxSignature,
    playerPubkey, betSol, side, result: coinSide,
    playerWon, payoutSol, flipMode: settings.flipMode,
    timestamp: new Date().toISOString(),
    network: settings.network,
  };
  flipHistory.unshift(record);
  if (flipHistory.length > 500) flipHistory.pop();

  // Update player stats
  updatePlayer(playerPubkey, record);

  const tag = playerWon ? "WIN 🎉" : "LOSS 💀";
  console.log(`🪙 FLIP | ${playerPubkey.slice(0,8)}… | ${betSol} SOL | ${side}→${coinSide} | ${tag} | mode:${settings.flipMode}`);

  res.json({
    success: true, playerWon, result: coinSide, side, betSol,
    payoutSol: playerWon ? payoutSol : 0,
    payoutTxSignature,
    explorerBetUrl:    `https://explorer.solana.com/tx/${txSignature}?cluster=${settings.network}`,
    explorerPayoutUrl: payoutTxSignature ? `https://explorer.solana.com/tx/${payoutTxSignature}?cluster=${settings.network}` : null,
  });
});

// ════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════════════════

// POST /admin/login
app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password !== settings.adminPassword)
    return res.status(401).json({ error: "Wrong password" });

  const token  = crypto.randomBytes(32).toString("hex");
  const expiry = Date.now() + settings.sessionTimeoutMin * 60 * 1000;
  SESSIONS.set(token, expiry);
  res.json({ token, expiresIn: settings.sessionTimeoutMin * 60 });
});

// POST /admin/logout
app.post("/admin/logout", requireAdmin, (req, res) => {
  SESSIONS.delete(req.headers["x-admin-token"]);
  res.json({ ok: true });
});

// GET /admin/stats — full dashboard overview
app.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const activeW   = getActiveWallet();
    const keypair   = getActiveKeypair();
    const balance   = await connection.getBalance(keypair.publicKey);
    const allFlips  = flipHistory;
    const totalFlips   = allFlips.length;
    const totalWins    = allFlips.filter(f => f.playerWon).length;
    const totalLosses  = totalFlips - totalWins;
    const totalWagered = allFlips.reduce((s, f) => s + f.betSol, 0);
    const totalPaidOut = allFlips.filter(f => f.playerWon).reduce((s, f) => s + f.payoutSol, 0);
    const houseProfit  = totalWagered - totalPaidOut;
    const playerCount  = Object.keys(players).length;
    const onlineNow    = getOnlinePlayers();
    const bannedCount  = bannedWallets.size;

    // Recent activity (last 60 min)
    const cutoff = Date.now() - 60 * 60 * 1000;
    const recentFlips = allFlips.filter(f => new Date(f.timestamp).getTime() > cutoff);

    res.json({
      treasury: {
        address:  activeW.publicKey,
        label:    activeW.label,
        balance:  balance / LAMPORTS_PER_SOL,
        network:  settings.network,
      },
      flips: {
        total: totalFlips, wins: totalWins, losses: totalLosses,
        winRate: totalFlips > 0 ? ((totalWins/totalFlips)*100).toFixed(1) : 0,
        recentCount: recentFlips.length,
      },
      financials: {
        totalWagered:  parseFloat(totalWagered.toFixed(4)),
        totalPaidOut:  parseFloat(totalPaidOut.toFixed(4)),
        houseProfit:   parseFloat(houseProfit.toFixed(4)),
        houseEdgePct:  (settings.houseEdge * 100).toFixed(1),
      },
      players: {
        total: playerCount, online: onlineNow, banned: bannedCount,
      },
      settings: {
        gameEnabled:  settings.gameEnabled,
        flipMode:     settings.flipMode,
        manualNextResult: settings.manualNextResult,
        minBet:       settings.minBet,
        maxBet:       settings.maxBet,
        network:      settings.network,
      },
      recentFlips: allFlips.slice(0, 10),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/players — all player details
app.get("/admin/players", requireAdmin, (req, res) => {
  const list = Object.values(players).map(p => ({
    ...p,
    banned:   bannedWallets.has(p.pubkey),
    online:   (onlineSessions.get(p.pubkey) || 0) > Date.now() - 5*60*1000,
    winRate:  p.totalFlips > 0 ? ((p.totalWins/p.totalFlips)*100).toFixed(1) : 0,
  }));
  // Sort by totalWagered desc
  list.sort((a, b) => b.totalWagered - a.totalWagered);
  res.json(list);
});

// GET /admin/flips — full flip history
app.get("/admin/flips", requireAdmin, (req, res) => {
  const page  = parseInt(req.query.page  || 1);
  const limit = parseInt(req.query.limit || 50);
  const start = (page - 1) * limit;
  res.json({
    total: flipHistory.length,
    page, limit,
    flips: flipHistory.slice(start, start + limit),
  });
});

// GET /admin/wallets — list all treasury wallets
app.get("/admin/wallets", requireAdmin, async (req, res) => {
  const result = [];
  for (const w of wallets) {
    let balance = null;
    try {
      const bal = await connection.getBalance(new PublicKey(w.publicKey));
      balance = bal / LAMPORTS_PER_SOL;
    } catch(e) {}
    result.push({
      id: w.id, label: w.label, publicKey: w.publicKey,
      active: w.active, addedAt: w.addedAt, balance,
    });
  }
  res.json(result);
});

// POST /admin/wallets — add a new treasury wallet
app.post("/admin/wallets", requireAdmin, (req, res) => {
  const { label, secretKeyArray } = req.body;
  // secretKeyArray = array of 64 numbers (Uint8Array)
  if (!label || !secretKeyArray || !Array.isArray(secretKeyArray))
    return res.status(400).json({ error: "Need label and secretKeyArray" });

  try {
    const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
    const id = "wallet_" + Date.now();
    wallets.push({
      id, label,
      publicKey: keypair.publicKey.toBase58(),
      secretKey: secretKeyArray,
      active: false,
      addedAt: new Date().toISOString(),
    });
    saveJSON(WALLETS_FILE, wallets);
    res.json({ ok: true, id, publicKey: keypair.publicKey.toBase58() });
  } catch(e) {
    res.status(400).json({ error: "Invalid secret key: " + e.message });
  }
});

// PUT /admin/wallets/:id/activate — set active treasury wallet
app.put("/admin/wallets/:id/activate", requireAdmin, (req, res) => {
  const wallet = wallets.find(w => w.id === req.params.id);
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });
  wallets.forEach(w => w.active = false);
  wallet.active = true;
  saveJSON(WALLETS_FILE, wallets);
  console.log(`🏦 Active treasury switched to: ${wallet.label} (${wallet.publicKey.slice(0,8)}…)`);
  res.json({ ok: true, activeWallet: wallet.publicKey });
});

// DELETE /admin/wallets/:id — remove a wallet
app.delete("/admin/wallets/:id", requireAdmin, (req, res) => {
  if (req.params.id === "primary")
    return res.status(400).json({ error: "Cannot delete primary wallet" });
  const idx = wallets.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Wallet not found" });
  if (wallets[idx].active)
    return res.status(400).json({ error: "Cannot delete active wallet — switch first" });
  wallets.splice(idx, 1);
  saveJSON(WALLETS_FILE, wallets);
  res.json({ ok: true });
});

// GET /admin/settings
app.get("/admin/settings", requireAdmin, (req, res) => {
  const { adminPassword, ...safe } = settings; // don't expose password
  res.json(safe);
});

// POST /admin/settings — update game settings
app.post("/admin/settings", requireAdmin, (req, res) => {
  const allowed = [
    "minBet", "maxBet", "houseEdge", "gameEnabled",
    "flipMode", "manualNextResult", "network",
    "adminPassword", "sessionTimeoutMin",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // Validate flipMode
  if (updates.flipMode && !["random","auto_heads","auto_tails","manual"].includes(updates.flipMode))
    return res.status(400).json({ error: "Invalid flipMode" });

  // Validate manualNextResult
  if (updates.manualNextResult !== undefined && updates.manualNextResult !== null &&
      !["heads","tails"].includes(updates.manualNextResult))
    return res.status(400).json({ error: "manualNextResult must be heads, tails, or null" });

  settings = { ...settings, ...updates };
  saveJSON(SETTINGS_FILE, settings);

  // Reconnect if network changed
  if (updates.network) reconnect();

  console.log("⚙️  Settings updated:", updates);
  const { adminPassword: _, ...safe } = settings;
  res.json({ ok: true, settings: safe });
});

// POST /admin/ban
app.post("/admin/ban", requireAdmin, (req, res) => {
  const { pubkey, reason } = req.body;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });
  bannedWallets.add(pubkey);
  if (players[pubkey]) players[pubkey].banned = true;
  saveJSON(path.join(DATA_DIR, "banned.json"), Array.from(bannedWallets));
  saveJSON(PLAYERS_FILE, players);
  console.log(`🚫 Banned: ${pubkey} | Reason: ${reason || "no reason"}`);
  res.json({ ok: true });
});

// POST /admin/unban
app.post("/admin/unban", requireAdmin, (req, res) => {
  const { pubkey } = req.body;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });
  bannedWallets.delete(pubkey);
  if (players[pubkey]) players[pubkey].banned = false;
  saveJSON(path.join(DATA_DIR, "banned.json"), Array.from(bannedWallets));
  saveJSON(PLAYERS_FILE, players);
  res.json({ ok: true });
});

// GET /admin/treasury/balance — check ALL wallet balances at once
app.get("/admin/treasury/balance", requireAdmin, async (req, res) => {
  const result = [];
  for (const w of wallets) {
    try {
      const bal = await connection.getBalance(new PublicKey(w.publicKey));
      result.push({ id: w.id, label: w.label, publicKey: w.publicKey, active: w.active, balance: bal / LAMPORTS_PER_SOL });
    } catch(e) {
      result.push({ id: w.id, label: w.label, publicKey: w.publicKey, active: w.active, balance: null, error: e.message });
    }
  }
  res.json(result);
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║         SOL FLIP  —  Game + Admin Panel           ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  🎮 Game:   http://localhost:${PORT}                  ║`);
  console.log(`║  🔧 Admin:  http://localhost:${PORT}/admin.html       ║`);
  console.log(`║  🔑 Password: ${settings.adminPassword.padEnd(34)}║`);
  console.log(`║  🌐 Network: ${settings.network.padEnd(35)}║`);
  console.log("╚══════════════════════════════════════════════════╝\n");
});
