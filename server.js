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
 *   GET  /admin/stats       → full dashboard stats (enhanced w/ 24h, today, wins/losses)
 *   GET  /admin/players     → all player details
 *   GET  /admin/player/:pubkey/flips → flip history for one player
 *   GET  /admin/flips       → full flip history
 *   GET  /admin/wallets     → all treasury wallets
 *   POST /admin/wallets     → add treasury wallet
 *   PUT  /admin/wallets/:id → set active wallet
 *   DELETE /admin/wallets/:id → remove wallet
 *   GET  /admin/settings    → get game settings
 *   POST /admin/settings    → update game settings
 *   GET  /admin/rpc-config  → get RPC configuration
 *   POST /admin/rpc-config  → save RPC configuration
 *   POST /admin/rpc-test    → test an RPC endpoint
 *   GET  /admin/treasury    → get treasury public key + balance
 *   POST /admin/treasury    → update treasury private key
 *   POST /admin/pause       → pause all bets
 *   POST /admin/resume      → resume bets
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
const RPC_CONFIG_FILE = path.join(DATA_DIR, "rpc-config.json");
const SESSIONS      = new Map(); // token → expiry
const isProd         = process.env.NODE_ENV === 'production';

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
  flipMode:        "random",
  manualNextResult: null,
  maxPlayersOnline: 1000,
  sessionTimeoutMin: 60,
  lowBalanceThreshold: 0.1,    // SOL — dashboard warning
};

// ── Default RPC config ───────────────────────────────────
const DEFAULT_RPC_CONFIG = {
  mainnetRpc: "",
  testnetRpc: "",
  devnetRpc:  "",
  apiKey:     "",
  providerName: "",
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
let settings  = { ...DEFAULT_SETTINGS, ...loadJSON(SETTINGS_FILE, {}) };
let wallets   = loadJSON(WALLETS_FILE, []);
let players   = loadJSON(PLAYERS_FILE, {});
let rpcConfig = { ...DEFAULT_RPC_CONFIG, ...loadJSON(RPC_CONFIG_FILE, {}) };

// In production, override RPC config from env vars
if (isProd) {
  if (process.env.MAINNET_RPC_URL) rpcConfig.mainnetRpc = process.env.MAINNET_RPC_URL;
  if (process.env.TESTNET_RPC_URL) rpcConfig.testnetRpc = process.env.TESTNET_RPC_URL;
  if (process.env.RPC_API_KEY)     rpcConfig.apiKey     = process.env.RPC_API_KEY;
  if (process.env.RPC_PROVIDER)    rpcConfig.providerName = process.env.RPC_PROVIDER;
  console.log("📡 RPC config loaded from environment variables");
}

// Save settings immediately so file exists
saveJSON(SETTINGS_FILE, settings);

// ── Load treasury (production=env var, local=file) ────────
let primaryKeypair;

if (isProd) {
  // Railway / production: MUST use env var
  if (!process.env.TREASURY_PRIVATE_KEY) {
    console.error("\n❌  TREASURY_PRIVATE_KEY env var is required in production!\n");
    process.exit(1);
  }
  try {
    const raw = process.env.TREASURY_PRIVATE_KEY.trim();
    let secretKey;
    if (raw.startsWith("[")) {
      secretKey = Uint8Array.from(JSON.parse(raw));
    } else {
      const bs58 = require("bs58");
      secretKey = bs58.decode(raw);
    }
    primaryKeypair = Keypair.fromSecretKey(secretKey);
    console.log("🔑 Treasury loaded from TREASURY_PRIVATE_KEY env var (production)");
  } catch(e) {
    console.error("❌ Failed to parse TREASURY_PRIVATE_KEY:", e.message);
    process.exit(1);
  }
} else {
  // Local / development: read from treasury.json file
  const TREASURY_FILE = path.join(__dirname, "treasury.json");
  if (!fs.existsSync(TREASURY_FILE)) {
    console.error("\n❌  treasury.json not found! Run: node setup-treasury.js\n");
    process.exit(1);
  }
  const treasuryRaw = JSON.parse(fs.readFileSync(TREASURY_FILE, "utf8"));
  primaryKeypair = Keypair.fromSecretKey(Uint8Array.from(treasuryRaw.secretKey));
  console.log("🔑 Treasury loaded from treasury.json (local)");
}

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
} else {
  // Update the secret key in case it changed via env var
  const existing = wallets.find(w => w.publicKey === primaryKeypair.publicKey.toBase58());
  if (existing) {
    existing.secretKey = Array.from(primaryKeypair.secretKey);
    saveJSON(WALLETS_FILE, wallets);
  }
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

// ── Solana connection (with custom RPC support) ───────────
function getRpcUrl() {
  const net = settings.network;
  if (net === "mainnet-beta" && rpcConfig.mainnetRpc) {
    let url = rpcConfig.mainnetRpc;
    if (rpcConfig.apiKey && url.includes("api-key=")) url = url.replace(/api-key=[^&]*/, `api-key=${rpcConfig.apiKey}`);
    return url;
  }
  if (net === "testnet" && rpcConfig.testnetRpc) {
    let url = rpcConfig.testnetRpc;
    if (rpcConfig.apiKey && url.includes("api-key=")) url = url.replace(/api-key=[^&]*/, `api-key=${rpcConfig.apiKey}`);
    return url;
  }
  if (net === "devnet" && rpcConfig.devnetRpc) {
    let url = rpcConfig.devnetRpc;
    if (rpcConfig.apiKey && url.includes("api-key=")) url = url.replace(/api-key=[^&]*/, `api-key=${rpcConfig.apiKey}`);
    return url;
  }
  return clusterApiUrl(net);
}

let connection = new Connection(getRpcUrl(), "confirmed");

function reconnect() {
  const url = getRpcUrl();
  connection = new Connection(url, "confirmed");
  console.log(`🌐 Reconnected to ${settings.network}: ${url.slice(0,60)}…`);
}

// ── In-memory runtime data ────────────────────────────────
const flipHistory    = [];           // all flips this session
const onlineSessions = new Map();    // pubkey → lastSeen timestamp
const bannedWallets  = new Set(loadJSON(path.join(DATA_DIR, "banned.json"), []));
let   betsPaused     = false;        // soft pause (game still "enabled" but bets rejected)

// ── Express ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
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
      netLoss:      0,
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
    p.netLoss     -= (flip.payoutSol - flip.betSol);
  } else {
    p.totalLosses++;
    p.netLoss += flip.betSol;
  }
  saveJSON(PLAYERS_FILE, players);
}

// ── Track online ──────────────────────────────────────────
function heartbeat(pubkey) {
  onlineSessions.set(pubkey, Date.now());
}
function getOnlinePlayers() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [k, v] of onlineSessions) { if (v < cutoff) onlineSessions.delete(k); }
  return onlineSessions.size;
}
function getOnlineList() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const list = [];
  for (const [k, v] of onlineSessions) {
    if (v < cutoff) onlineSessions.delete(k);
    else list.push(k);
  }
  return list;
}

setInterval(() => { getOnlinePlayers(); }, 60000);

// ── Helper: today's stats ────────────────────────────────
function getTodayStats() {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const todayMs = todayStart.getTime();
  const yesterdayMs = yesterdayStart.getTime();

  const todayFlips = flipHistory.filter(f => new Date(f.timestamp).getTime() >= todayMs);
  const yesterdayFlips = flipHistory.filter(f => {
    const t = new Date(f.timestamp).getTime();
    return t >= yesterdayMs && t < todayMs;
  });

  const calc = (flips) => {
    const total = flips.length;
    const wagered = flips.reduce((s,f) => s+f.betSol, 0);
    const paidOut = flips.filter(f=>f.playerWon).reduce((s,f) => s+f.payoutSol, 0);
    return { total, wagered: parseFloat(wagered.toFixed(4)), paidOut: parseFloat(paidOut.toFixed(4)), profit: parseFloat((wagered-paidOut).toFixed(4)) };
  };
  return { today: calc(todayFlips), yesterday: calc(yesterdayFlips) };
}

// ── Helper: 24h hourly volume ────────────────────────────
function get24hVolume() {
  const now = Date.now();
  const hours = [];
  for (let i = 23; i >= 0; i--) {
    const start = now - (i+1)*3600000;
    const end   = now - i*3600000;
    const count = flipHistory.filter(f => {
      const t = new Date(f.timestamp).getTime();
      return t >= start && t < end;
    }).length;
    hours.push({ hour: new Date(end).getHours(), count });
  }
  return hours;
}

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
      rpcUrl:          getRpcUrl(),
      treasuryPubkey:  active.publicKey,
      treasuryBalance: balance / LAMPORTS_PER_SOL,
      minBet:          settings.minBet,
      maxBet:          settings.maxBet,
      winMultiplier:   winMult,
      gameEnabled:     settings.gameEnabled,
      betsPaused:      betsPaused,
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

// POST /api/heartbeat
app.post("/api/heartbeat", (req, res) => {
  const { pubkey } = req.body;
  if (pubkey) heartbeat(pubkey);
  res.json({ ok: true });
});

// POST /api/flip
app.post("/api/flip", async (req, res) => {
  if (!settings.gameEnabled)
    return res.status(403).json({ error: "Game is currently disabled by admin" });
  if (betsPaused)
    return res.status(403).json({ error: "Bets are temporarily paused by admin" });

  const { txSignature, playerPubkey, betAmount, side } = req.body;

  if (!txSignature || !playerPubkey || !betAmount || !side)
    return res.status(400).json({ error: "Missing required fields" });
  if (!["heads", "tails"].includes(side))
    return res.status(400).json({ error: "side must be heads or tails" });

  const betSol = parseFloat(betAmount);
  if (isNaN(betSol) || betSol < settings.minBet || betSol > settings.maxBet)
    return res.status(400).json({ error: `Bet must be ${settings.minBet}–${settings.maxBet} SOL` });

  if (bannedWallets.has(playerPubkey))
    return res.status(403).json({ error: "Your wallet has been banned" });

  if (flipHistory.some(f => f.txSignature === txSignature))
    return res.status(400).json({ error: "Transaction already used" });

  heartbeat(playerPubkey);

  // ── Verify tx on-chain (robust) ──
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    await Promise.race([
      connection.confirmTransaction({ signature: txSignature, blockhash, lastValidBlockHeight }, "confirmed"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("confirm timeout")), 20000)),
    ]);
    console.log(`✅ confirmTransaction OK for ${txSignature.slice(0,12)}…`);
  } catch(confirmErr) {
    console.log(`⚠️  confirmTransaction slow (${confirmErr.message}), polling…`);
  }

  let txInfo = null;
  for (let i = 0; i < 10; i++) {
    try {
      txInfo = await connection.getTransaction(txSignature, {
        commitment: "confirmed", maxSupportedTransactionVersion: 0,
      });
      if (txInfo) { console.log(`✅ getTransaction found on attempt ${i+1}`); break; }
    } catch(e) {
      console.log(`⚠️  getTransaction attempt ${i+1} error: ${e.message}`);
    }
    if (i < 9) await new Promise(r => setTimeout(r, 3000));
  }

  if (!txInfo) return res.status(400).json({ error: "Transaction not found on-chain after 30s. Network may be congested." });
  if (txInfo.meta?.err) return res.status(400).json({ error: "Transaction failed on-chain" });

  const activeWallet = getActiveWallet();
  const accountKeys  = txInfo.transaction.message.staticAccountKeys ?? txInfo.transaction.message.accountKeys;
  const tIdx = accountKeys.findIndex(k => k.toBase58() === activeWallet.publicKey);

  if (tIdx === -1) return res.status(400).json({ error: "Transaction did not send to active treasury" });

  const received = txInfo.meta.postBalances[tIdx] - txInfo.meta.preBalances[tIdx];
  const expected = Math.round(betSol * LAMPORTS_PER_SOL);
  if (received < expected - 10_000)
    return res.status(400).json({ error: `Expected ${betSol} SOL, received ${(received/LAMPORTS_PER_SOL).toFixed(6)}` });

  // ── COIN FLIP MODE ──
  let coinSide;
  if (settings.flipMode === "auto_heads") {
    coinSide = "heads";
  } else if (settings.flipMode === "auto_tails") {
    coinSide = "tails";
  } else if (settings.flipMode === "manual" && settings.manualNextResult) {
    coinSide = settings.manualNextResult;
    settings.manualNextResult = null;
    saveJSON(SETTINGS_FILE, settings);
  } else {
    const sigBuf = Buffer.from(txSignature.slice(0, 16));
    const seed   = sigBuf.reduce((a, b) => (a * 31 + b) >>> 0, 0);
    coinSide     = (seed % 2 === 0) ? "heads" : "tails";
  }

  const playerWon = coinSide === side;
  const winMult   = 2 * (1 - settings.houseEdge);

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

  const record = {
    id: Date.now(), txSignature, payoutTxSignature,
    playerPubkey, betSol, side, result: coinSide,
    playerWon, payoutSol, flipMode: settings.flipMode,
    timestamp: new Date().toISOString(),
    network: settings.network,
  };
  flipHistory.unshift(record);
  if (flipHistory.length > 500) flipHistory.pop();

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

// GET /admin/stats — enhanced dashboard
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
    const cutoff = Date.now() - 60 * 60 * 1000;
    const recentFlips = allFlips.filter(f => new Date(f.timestamp).getTime() > cutoff);

    // Last 5 wins and last 5 losses
    const last5Wins  = allFlips.filter(f => f.playerWon).slice(0, 5);
    const last5Losses = allFlips.filter(f => !f.playerWon).slice(0, 5);

    // Today vs Yesterday
    const dailyStats = getTodayStats();

    // 24h volume
    const hourlyVolume = get24hVolume();

    // Online list
    const onlineWallets = getOnlineList();

    const balSOL = balance / LAMPORTS_PER_SOL;

    res.json({
      treasury: {
        address: activeW.publicKey, label: activeW.label,
        balance: balSOL, network: settings.network,
        lowBalance: balSOL < (settings.lowBalanceThreshold || 0.1),
        lowBalanceThreshold: settings.lowBalanceThreshold || 0.1,
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
        onlineWallets,
      },
      settings: {
        gameEnabled:  settings.gameEnabled,
        betsPaused:   betsPaused,
        flipMode:     settings.flipMode,
        manualNextResult: settings.manualNextResult,
        minBet:       settings.minBet,
        maxBet:       settings.maxBet,
        network:      settings.network,
      },
      recentFlips:  allFlips.slice(0, 10),
      last5Wins,
      last5Losses,
      dailyStats,
      hourlyVolume,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/players
app.get("/admin/players", requireAdmin, (req, res) => {
  const list = Object.values(players).map(p => ({
    ...p,
    banned:   bannedWallets.has(p.pubkey),
    online:   (onlineSessions.get(p.pubkey) || 0) > Date.now() - 5*60*1000,
    winRate:  p.totalFlips > 0 ? ((p.totalWins/p.totalFlips)*100).toFixed(1) : 0,
  }));
  list.sort((a, b) => b.totalWagered - a.totalWagered);
  res.json(list);
});

// GET /admin/player/:pubkey/flips — flip history for one player
app.get("/admin/player/:pubkey/flips", requireAdmin, (req, res) => {
  const pk = req.params.pubkey;
  const flips = flipHistory.filter(f => f.playerPubkey === pk).slice(0, 50);
  res.json(flips);
});

// GET /admin/flips
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

// GET /admin/wallets
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

// POST /admin/wallets
app.post("/admin/wallets", requireAdmin, (req, res) => {
  const { label, secretKeyArray } = req.body;
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

// PUT /admin/wallets/:id/activate
app.put("/admin/wallets/:id/activate", requireAdmin, (req, res) => {
  const wallet = wallets.find(w => w.id === req.params.id);
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });
  wallets.forEach(w => w.active = false);
  wallet.active = true;
  saveJSON(WALLETS_FILE, wallets);
  console.log(`🏦 Active treasury switched to: ${wallet.label} (${wallet.publicKey.slice(0,8)}…)`);
  res.json({ ok: true, activeWallet: wallet.publicKey });
});

// DELETE /admin/wallets/:id
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
  const { adminPassword, ...safe } = settings;
  res.json(safe);
});

// POST /admin/settings
app.post("/admin/settings", requireAdmin, (req, res) => {
  const allowed = [
    "minBet", "maxBet", "houseEdge", "gameEnabled",
    "flipMode", "manualNextResult", "network",
    "adminPassword", "sessionTimeoutMin", "lowBalanceThreshold",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (updates.flipMode && !["random","auto_heads","auto_tails","manual"].includes(updates.flipMode))
    return res.status(400).json({ error: "Invalid flipMode" });

  if (updates.manualNextResult !== undefined && updates.manualNextResult !== null &&
      !["heads","tails"].includes(updates.manualNextResult))
    return res.status(400).json({ error: "manualNextResult must be heads, tails, or null" });

  settings = { ...settings, ...updates };
  saveJSON(SETTINGS_FILE, settings);

  if (updates.network) reconnect();

  console.log("⚙️  Settings updated:", updates);
  const { adminPassword: _, ...safe } = settings;
  res.json({ ok: true, settings: safe });
});

// ── RPC Configuration ─────────────────────────────────────

// GET /admin/rpc-config
app.get("/admin/rpc-config", requireAdmin, (req, res) => {
  const masked = { ...rpcConfig };
  if (masked.apiKey) {
    masked.apiKey = masked.apiKey.length > 6
      ? "•".repeat(masked.apiKey.length - 6) + masked.apiKey.slice(-6)
      : masked.apiKey;
  }
  res.json(masked);
});

// POST /admin/rpc-config
app.post("/admin/rpc-config", requireAdmin, (req, res) => {
  const { mainnetRpc, testnetRpc, devnetRpc, apiKey, providerName } = req.body;
  if (mainnetRpc !== undefined) rpcConfig.mainnetRpc = mainnetRpc;
  if (testnetRpc !== undefined) rpcConfig.testnetRpc = testnetRpc;
  if (devnetRpc  !== undefined) rpcConfig.devnetRpc  = devnetRpc;
  if (apiKey     !== undefined) rpcConfig.apiKey     = apiKey;
  if (providerName !== undefined) rpcConfig.providerName = providerName;
  saveJSON(RPC_CONFIG_FILE, rpcConfig);
  reconnect();
  console.log("⚙️  RPC config updated");
  const masked = { ...rpcConfig };
  if (masked.apiKey && masked.apiKey.length > 6) {
    masked.apiKey = "•".repeat(masked.apiKey.length - 6) + masked.apiKey.slice(-6);
  }
  res.json({ ok: true, config: masked });
});

// POST /admin/rpc-test
app.post("/admin/rpc-test", requireAdmin, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const start = Date.now();
  try {
    const testConn = new Connection(url, "confirmed");
    const slot = await Promise.race([
      testConn.getSlot(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
    ]);
    res.json({ ok: true, latency: Date.now() - start, slot });
  } catch(e) {
    res.json({ ok: false, latency: Date.now() - start, error: e.message });
  }
});

// ── Treasury Management ───────────────────────────────────

// GET /admin/treasury
app.get("/admin/treasury", requireAdmin, async (req, res) => {
  try {
    const active = getActiveWallet();
    const keypair = getActiveKeypair();
    const bal = await connection.getBalance(keypair.publicKey);
    res.json({
      publicKey: active.publicKey,
      balance:   bal / LAMPORTS_PER_SOL,
      label:     active.label,
      network:   settings.network,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/treasury — update treasury private key
app.post("/admin/treasury", requireAdmin, (req, res) => {
  const { secretKeyArray } = req.body;
  if (!secretKeyArray || !Array.isArray(secretKeyArray))
    return res.status(400).json({ error: "secretKeyArray required (array of 64 numbers)" });
  try {
    const newKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
    const newPub = newKeypair.publicKey.toBase58();

    // Update primary wallet in wallets list
    const primary = wallets.find(w => w.id === "primary");
    if (primary) {
      primary.publicKey = newPub;
      primary.secretKey = secretKeyArray;
    } else {
      wallets.unshift({
        id: "primary", label: "Primary Treasury",
        publicKey: newPub, secretKey: secretKeyArray,
        active: true, addedAt: new Date().toISOString(),
      });
    }
    saveJSON(WALLETS_FILE, wallets);
    console.log(`🔑 Treasury key updated: ${newPub.slice(0,12)}…`);
    res.json({ ok: true, publicKey: newPub });
  } catch(e) {
    res.status(400).json({ error: "Invalid key: " + e.message });
  }
});

// ── Pause / Resume ────────────────────────────────────────

app.post("/admin/pause", requireAdmin, (req, res) => {
  betsPaused = true;
  console.log("⏸️  Bets PAUSED by admin");
  res.json({ ok: true, betsPaused: true });
});

app.post("/admin/resume", requireAdmin, (req, res) => {
  betsPaused = false;
  console.log("▶️  Bets RESUMED by admin");
  res.json({ ok: true, betsPaused: false });
});

// ── Ban / Unban ───────────────────────────────────────────

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

app.post("/admin/unban", requireAdmin, (req, res) => {
  const { pubkey } = req.body;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });
  bannedWallets.delete(pubkey);
  if (players[pubkey]) players[pubkey].banned = false;
  saveJSON(path.join(DATA_DIR, "banned.json"), Array.from(bannedWallets));
  saveJSON(PLAYERS_FILE, players);
  res.json({ ok: true });
});

// GET /admin/treasury/balance
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
  console.log(`║  📡 RPC: ${getRpcUrl().slice(0,38).padEnd(39)}║`);
  console.log("╚══════════════════════════════════════════════════╝\n");
});
