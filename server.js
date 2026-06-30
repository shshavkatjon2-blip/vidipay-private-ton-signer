const express = require("express");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { TonClient, WalletContractV4, internal, SendMode, Address } = require("@ton/ton");
const { mnemonicToPrivateKey, keyPairFromSeed, keyPairFromSecretKey } = require("@ton/crypto");
const { getHttpEndpoint } = require("@orbs-network/ton-access");

dotenv.config();
dotenv.config({ path: path.join(__dirname, ".env.local"), override: true });

const app = express();
app.use(express.json({ limit: "128kb" }));

const PORT = Number(process.env.PORT || 10000);
const SIGNER_TOKEN = readEnvValue("SIGNER_TOKEN");
const TON_SIGNER_NETWORK = String(process.env.TON_SIGNER_NETWORK || "mainnet").trim().toLowerCase() === "testnet" ? "testnet" : "mainnet";
const TON_SIGNER_KEYS_DIR = readEnvValue("TON_SIGNER_KEYS_DIR") || path.join(__dirname, "ton-signer-keys");
const TON_RPC_ENDPOINT = readEnvValue("TON_RPC_ENDPOINT");
const TON_RPC_API_KEY = readEnvValue("TON_RPC_API_KEY");
const TON_PAYOUT_GAS_RESERVE = readEnvValue("TON_PAYOUT_GAS_RESERVE", "0.10");
const TON_PAYOUT_BODY = readEnvValue("TON_PAYOUT_BODY", "VidiPay activation payout");
const REQUEST_TIMEOUT_MS = Math.max(3000, Math.min(120000, Number(process.env.REQUEST_TIMEOUT_MS || 90000)));

let clientPromise = null;
let clientMeta = null;
let walletIndexCache = null;

function readEnvValue(name, fallback = "") {
  let value = String(process.env[name] ?? fallback ?? "").trim();
  if (value.startsWith(`${name}=`)) value = value.slice(name.length + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function requireAuth(req, res, next) {
  const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const headerToken = String(req.headers["x-signer-token"] || "").trim();
  if (!SIGNER_TOKEN) {
    return res.status(503).json({ ok: false, error: "SIGNER_TOKEN is not configured" });
  }
  if (auth !== SIGNER_TOKEN && headerToken !== SIGNER_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return next();
}

function listWalletFiles() {
  if (!TON_SIGNER_KEYS_DIR || !fs.existsSync(TON_SIGNER_KEYS_DIR)) return [];
  return fs.readdirSync(TON_SIGNER_KEYS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(TON_SIGNER_KEYS_DIR, entry.name));
}

function splitMnemonicWords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").trim().split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeHex(value, expectedLength) {
  const hex = String(value || "").trim().replace(/^0x/i, "");
  if (!new RegExp(`^[a-fA-F0-9]{${expectedLength}}$`).test(hex)) return "";
  return hex.toLowerCase();
}

function normalizeAddress(value) {
  return String(value || "").trim();
}

function toRawAddress(value) {
  try {
    return Address.parse(String(value || "").trim()).toRawString();
  } catch {
    return "";
  }
}

function sameTonAddress(a, b) {
  const left = toRawAddress(a);
  const right = toRawAddress(b);
  return Boolean(left && right && left === right);
}

function readWalletRecord(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const address = normalizeAddress(payload.address || payload.wallet_address);
  const mnemonic = splitMnemonicWords(payload.mnemonic || payload.mnemonics || payload.seed_phrase);
  const seedHex = normalizeHex(payload.seed_hex, 64);
  const secretKeyHex = normalizeHex(payload.secret_key_hex, 128);
  const workchain = Number.isInteger(payload.workchain) ? payload.workchain : Number(payload.workchain ?? 0);

  if (!toRawAddress(address)) throw new Error(`Invalid TON address in ${path.basename(filePath)}`);
  if (mnemonic.length < 12 && !seedHex && !secretKeyHex) throw new Error(`Missing private key data in ${path.basename(filePath)}`);

  return {
    file_path: filePath,
    label: normalizeAddress(payload.label || path.basename(filePath, ".json")),
    address,
    mnemonic,
    seed_hex: seedHex,
    secret_key_hex: secretKeyHex,
    workchain: Number.isFinite(workchain) ? workchain : 0
  };
}

function getWalletIndex() {
  if (walletIndexCache?.dir === TON_SIGNER_KEYS_DIR) return walletIndexCache.map;
  const map = new Map();
  for (const filePath of listWalletFiles()) {
    try {
      const record = readWalletRecord(filePath);
      map.set(toRawAddress(record.address), filePath);
    } catch {
      continue;
    }
  }
  walletIndexCache = { dir: TON_SIGNER_KEYS_DIR, map };
  return map;
}

function findWalletByAddress(address) {
  const raw = toRawAddress(address);
  if (!raw) return null;
  const filePath = getWalletIndex().get(raw);
  return filePath ? readWalletRecord(filePath) : null;
}

async function getKeyPair(record) {
  if (record.mnemonic?.length >= 12) return mnemonicToPrivateKey(record.mnemonic);
  if (record.seed_hex) return keyPairFromSeed(Buffer.from(record.seed_hex, "hex"));
  if (record.secret_key_hex) return keyPairFromSecretKey(Buffer.from(record.secret_key_hex, "hex"));
  throw new Error(`Unsupported key format: ${record.label}`);
}

async function withTimeout(promise, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timeout`)), REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    clearTimeout(timeout);
  }
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const candidates = [];
      if (TON_RPC_ENDPOINT) {
        if (TON_RPC_API_KEY) candidates.push({ source: "configured_with_api_key", endpoint: TON_RPC_ENDPOINT, apiKey: TON_RPC_API_KEY });
        candidates.push({ source: "configured_without_api_key", endpoint: TON_RPC_ENDPOINT, apiKey: "" });
      }
      candidates.push({ source: "auto_orbs_ton_access", endpoint: await getHttpEndpoint({ network: TON_SIGNER_NETWORK }), apiKey: "" });

      const errors = [];
      for (const candidate of candidates) {
        try {
          const client = new TonClient({ endpoint: candidate.endpoint, apiKey: candidate.apiKey || undefined });
          const masterchain = await withTimeout(client.getMasterchainInfo(), `rpc ${candidate.source}`);
          clientMeta = {
            source: candidate.source,
            endpoint: candidate.endpoint,
            api_key_used: Boolean(candidate.apiKey),
            last_seqno: masterchain?.last?.seqno || null
          };
          return client;
        } catch (error) {
          errors.push(`${candidate.source}: ${error.message || String(error)}`);
        }
      }
      const error = new Error(errors.join(" | "));
      error.rpc_errors = errors;
      throw error;
    })().catch((error) => {
      clientPromise = null;
      clientMeta = null;
      throw error;
    });
  }
  return clientPromise;
}

async function waitForSeqnoChange(contract, seqno) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const current = await contract.getSeqno();
    if (current > seqno) return current;
  }
  return null;
}

app.get("/healthz", requireAuth, async (req, res) => {
  const keysDirExists = Boolean(TON_SIGNER_KEYS_DIR && fs.existsSync(TON_SIGNER_KEYS_DIR));
  const walletFiles = listWalletFiles();
  let rpc = { ok: false };
  try {
    const client = await getClient();
    const masterchain = await withTimeout(client.getMasterchainInfo(), "masterchain");
    rpc = { ok: Boolean(masterchain?.last), source: clientMeta?.source, endpoint: clientMeta?.endpoint, last_seqno: masterchain?.last?.seqno || null };
  } catch (error) {
    rpc = { ok: false, error: error.message || String(error), rpc_errors: error.rpc_errors || undefined };
  }

  res.json({
    ok: Boolean(keysDirExists && walletFiles.length > 0 && rpc.ok),
    status: keysDirExists && walletFiles.length > 0 && rpc.ok ? "ok" : "action_required",
    network: TON_SIGNER_NETWORK,
    keys_dir: TON_SIGNER_KEYS_DIR,
    keys_dir_exists: keysDirExists,
    wallet_files: walletFiles.length,
    rpc_ok: rpc.ok,
    rpc
  });
});

app.post("/payout", requireAuth, async (req, res) => {
  try {
    const sourceWalletAddress = normalizeAddress(req.body.source_wallet_address || req.body.sourceWalletAddress);
    const destinationWalletAddress = normalizeAddress(req.body.destination_wallet_address || req.body.destinationWalletAddress);
    const amountTon = String(req.body.amount_ton || req.body.amountTon || "").trim();
    const comment = normalizeAddress(req.body.comment || TON_PAYOUT_BODY);

    if (!sourceWalletAddress || !destinationWalletAddress || !amountTon) {
      return res.status(400).json({ ok: false, error: "source_wallet_address, destination_wallet_address, amount_ton are required" });
    }

    const record = findWalletByAddress(sourceWalletAddress);
    if (!record) {
      return res.status(404).json({ ok: false, error: `Signer key not found for ${sourceWalletAddress}` });
    }

    const keyPair = await getKeyPair(record);
    const wallet = WalletContractV4.create({ workchain: record.workchain, publicKey: keyPair.publicKey });
    const derivedAddress = wallet.address.toString({ urlSafe: true, bounceable: true, testOnly: TON_SIGNER_NETWORK === "testnet" });
    if (!sameTonAddress(derivedAddress, record.address)) {
      return res.status(409).json({ ok: false, error: `Signer key does not match wallet address: ${record.label}` });
    }

    const client = await getClient();
    const contract = client.open(wallet);
    const seqno = await contract.getSeqno();

    await contract.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [internal({
        to: destinationWalletAddress,
        value: amountTon,
        bounce: false,
        body: comment
      })]
    });

    const confirmedSeqno = await waitForSeqnoChange(contract, seqno);
    if (!confirmedSeqno) {
      return res.status(202).json({
        ok: true,
        submitted: true,
        confirmed: false,
        source_wallet_address: derivedAddress,
        destination_wallet_address: destinationWalletAddress,
        amount_ton: Number(amountTon),
        seqno
      });
    }

    res.json({
      ok: true,
      submitted: true,
      confirmed: true,
      source_wallet_address: derivedAddress,
      destination_wallet_address: destinationWalletAddress,
      amount_ton: Number(amountTon),
      seqno,
      confirmed_seqno: confirmedSeqno
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`[remote-signer] listening on ${PORT}`);
});
