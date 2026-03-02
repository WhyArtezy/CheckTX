require("dotenv").config();
const { ethers } = require("ethers");
const axios = require("axios");

const RPC_URL = process.env.RPC_URL;
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
let TELEGRAM_CHAT_ID = null;

// ===== INIT RPC =====
function initProvider() {
  console.log("🔄 Connecting RPC...");
  provider = new ethers.JsonRpcProvider(RPC_URL);
  contract = new ethers.Contract(USDT_CONTRACT, ABI, provider);
}

// ===== AUTO DETECT CHAT ID =====
async function getChatId() {
  if (TELEGRAM_CHAT_ID) return TELEGRAM_CHAT_ID;

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`;
  const res = await axios.get(url);

  if (res.data.result.length === 0) {
    console.log("⚠️ Kirim pesan dulu ke bot kamu di Telegram!");
    return null;
  }

  TELEGRAM_CHAT_ID = res.data.result[0].message.chat.id;
  console.log("✅ Chat ID ditemukan:", TELEGRAM_CHAT_ID);
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

// ===== SAFE CALL =====
async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    console.log("⚠ RPC Error. Reconnecting...");
    initProvider();
    return null;
  }
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
