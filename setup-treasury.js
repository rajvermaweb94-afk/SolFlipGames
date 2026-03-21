const { Keypair, Connection, LAMPORTS_PER_SOL, clusterApiUrl } = require("@solana/web3.js");
const fs = require("fs"), path = require("path");
const FILE = path.join(__dirname, "treasury.json");

async function main() {
  let keypair;
  if (fs.existsSync(FILE)) {
    console.log("ℹ️  treasury.json exists — loading.");
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(FILE)).secretKey));
  } else {
    keypair = Keypair.generate();
    fs.writeFileSync(FILE, JSON.stringify({ publicKey: keypair.publicKey.toBase58(), secretKey: Array.from(keypair.secretKey) }, null, 2));
    console.log("✅ Treasury wallet created → treasury.json");
  }
  const pub = keypair.publicKey.toBase58();
  console.log("\n🏦 Treasury:", pub);
  console.log("🔗 https://explorer.solana.com/address/" + pub + "?cluster=testnet\n");
  const conn = new Connection(clusterApiUrl("testnet"), "confirmed");
  let bal = await conn.getBalance(keypair.publicKey);
  console.log("💰 Balance:", (bal / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  if (bal < LAMPORTS_PER_SOL) {
    console.log("🪂 Requesting airdrop...");
    try {
      const sig = await conn.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig);
      bal = await conn.getBalance(keypair.publicKey);
      console.log("✅ Balance now:", (bal / LAMPORTS_PER_SOL).toFixed(4), "SOL");
    } catch { console.log("⚠️  Airdrop failed → get SOL at faucet.solana.com → paste:", pub); }
  }
  console.log("\n🚀 Run: npm start  →  open http://localhost:3001");
  console.log("🔧 Admin:          http://localhost:3001/admin.html");
  console.log("🔑 Default password: admin123  (change in admin settings!)\n");
}
main().catch(console.error);
