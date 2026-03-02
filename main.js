require("dotenv").config();
const { ethers } = require("ethers");
const axios = require("axios");

// ===== LOAD ENV =====
const RPC_LIST = [
  process.env.RPC_1,
  process.env.RPC_2,
  process.env.RPC_3
].filter(Boolean);

const WALLET_ADDRESS = process.env.WALLET_ADDRESS.toLowerCase();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const USDT_CONTRACT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";

const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

let provider;
let contract;
let lastBlock = 0;
let currentRpcIndex = 0;
let TELEGRAM_CHAT_ID = null;

// ===== INIT PROVIDER =====
function initProvider() {
  const rpc = RPC_LIST[currentRpcIndex];
  console.log(`🔌 Connecting RPC ${currentRpcIndex + 1}: ${rpc}`);
  provider = new ethers.JsonRpcProvider(rpc);
  contract = new ethers.Contract(USDT_CONTRACT, ABI, provider);
}

// ===== SWITCH RPC =====
function switchRpc() {
  currentRpcIndex = (currentRpcIndex + 1) % RPC_LIST.length;
  console.log("⚠ Switching to backup RPC...");
  initProvider();
}

// ===== SAFE CALL =====
async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    console.log("❌ RPC Error:", err.message);
    switchRpc();
    return null;
  }
}

// ===== TELEGRAM AUTO CHAT ID =====
async function getChatId() {
  if (TELEGRAM_CHAT_ID) return TELEGRAM_CHAT_ID;

  const res = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`
  );

  if (!res.data.result.length) {
    console.log("⚠ Kirim pesan dulu ke bot kamu.");
    return null;
  }

  TELEGRAM_CHAT_ID = res.data.result[0].message.chat.id;
  console.log("✅ Chat ID:", TELEGRAM_CHAT_ID);
  return TELEGRAM_CHAT_ID;
}

// ===== SEND TELEGRAM =====
async function sendTelegram(message) {
  const chatId = await getChatId();
  if (!chatId) return;

  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML"
    }
  );
}

// ===== CHECK BALANCE =====
async function checkBalance() {
  const decimals = await safeCall(() => contract.decimals());
  if (!decimals) return;

  const raw = await safeCall(() => contract.balanceOf(WALLET_ADDRESS));
  if (!raw) return;

  return ethers.formatUnits(raw, decimals);
}

// ===== CHECK TRANSFER =====
async function checkTransfers() {
  const currentBlock = await safeCall(() => provider.getBlockNumber());
  if (!currentBlock) return;

  if (lastBlock === 0) {
    lastBlock = currentBlock;
    return;
  }

  const events = await safeCall(() =>
    contract.queryFilter(contract.filters.Transfer(), lastBlock, currentBlock)
  );

  if (!events) return;

  for (const e of events) {
    const from = e.args.from.toLowerCase();
    const to = e.args.to.toLowerCase();

    if (from === WALLET_ADDRESS || to === WALLET_ADDRESS) {
      const decimals = await contract.decimals();
      const amount = ethers.formatUnits(e.args.value, decimals);
      const balance = await checkBalance();
      const type = to === WALLET_ADDRESS ? "🟢 MASUK" : "🔴 KELUAR";

      const message = `
<b>USDT ${type}</b>

Jumlah: <b>${amount} USDT</b>
Saldo: <b>${balance} USDT</b>

Tx: https://celoscan.io/tx/${e.transactionHash}
`;

      console.log(message);
      await sendTelegram(message);
    }
  }

  lastBlock = currentBlock;
}

// ===== START =====
async function start() {
  initProvider();

  const balance = await checkBalance();
  console.log("💰 Saldo awal:", balance);

  await sendTelegram(
    `🚀 Monitoring aktif\nWallet: ${WALLET_ADDRESS}\nSaldo: ${balance} USDT`
  );

  setInterval(checkTransfers, 10000);
}

start();
