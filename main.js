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
let lastUpdateId = 0;

// chatId => { messageId, history }
let users = new Map();

function initProvider() {
  console.log("🔄 Connecting RPC...");
  provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: "celo",
    chainId: 42220
  });
  contract = new ethers.Contract(USDT_CONTRACT, ABI, provider);
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    console.log("⚠ RPC Error. Reconnecting...");
    initProvider();
    return null;
  }
}

// ===== TELEGRAM LISTENER =====
async function checkTelegram() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`,
      { params: { offset: lastUpdateId + 1 } }
    );

    for (const update of res.data.result) {
      lastUpdateId = update.update_id;

      if (update.message && update.message.text === "/start") {
        const chatId = update.message.chat.id;

        if (!users.has(chatId)) {
          users.set(chatId, { messageId: null, history: "" });
        }

        console.log("User aktif:", chatId);
      }
    }
  } catch (err) {
    console.log("Telegram polling error:", err.message);
  }
}

// ===== SEND / UPDATE SINGLE MESSAGE =====
async function sendOrEdit(chatId, content) {
  const user = users.get(chatId);

  try {
    if (!user.messageId) {
      const res = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: content,
          parse_mode: "HTML"
        }
      );

      user.messageId = res.data.result.message_id;
    } else {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
        {
          chat_id: chatId,
          message_id: user.messageId,
          text: content,
          parse_mode: "HTML"
        }
      );
    }
  } catch (err) {
    console.log("Telegram send error:", err.message);
  }
}

// ===== CHECK BALANCE =====
async function checkBalance() {
  const decimals = await safeCall(() => contract.decimals());
  if (!decimals) return null;

  const raw = await safeCall(() => contract.balanceOf(WALLET_ADDRESS));
  if (!raw) return null;

  return ethers.formatUnits(raw, decimals);
}

// ===== CHECK TRANSFERS =====
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

      const isIn = to === WALLET_ADDRESS;
      const type = isIn ? "🟢 USDT IN" : "🔴 USDT OUT";
      const addressLine = isIn
        ? `From : ${from}`
        : `To   : ${to}`;

      const txLog = `
${type}
${addressLine}
Jumlah : ${amount} USDT
Block  : ${e.blockNumber}
Tx     : ${e.transactionHash}

`;

      for (const [chatId, data] of users.entries()) {
        const newHistory = txLog + data.history;

        const message = `
Address : ${WALLET_ADDRESS}
Balance : ${balance} USDT

━━━━━━━━━━━━━━━━

${newHistory}
`;

        await sendOrEdit(chatId, message);

        users.set(chatId, {
          messageId: data.messageId,
          history: newHistory.slice(0, 3000) // limit biar gak terlalu panjang
        });
      }
    }
  }

  lastBlock = currentBlock;
}

// ===== START =====
async function start() {
  initProvider();

  console.log("🚀 Bot aktif");
  console.log("Kirim /start ke bot Telegram");

  setInterval(checkTelegram, 3000);
  setInterval(checkTransfers, 10000);
}

start();
