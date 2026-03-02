require("dotenv").config();
const { ethers } = require("ethers");
const axios = require("axios");
const fs = require("fs");

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

const USER_FILE = "user.json";
let users = {};

// ================= USER STORAGE =================

function loadUsers() {
  if (!fs.existsSync(USER_FILE)) {
    users = {};
    return;
  }

  try {
    users = JSON.parse(fs.readFileSync(USER_FILE));
  } catch {
    users = {};
  }

  console.log("Loaded users:", Object.keys(users).length);
}

function saveUsers() {
  fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2));
}

// ================= RPC =================

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
    console.log("⚠ RPC error, reconnecting...");
    initProvider();
    return null;
  }
}

// ================= TELEGRAM =================

async function removeWebhook() {
  try {
    await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`);
  } catch {}
}

async function checkTelegram() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`,
      { params: { offset: lastUpdateId + 1 } }
    );

    for (const update of res.data.result) {
      lastUpdateId = update.update_id;

      if (update.message && update.message.text === "/start") {
        const chatId = String(update.message.chat.id);

        if (!users[chatId]) {
          users[chatId] = { messageId: null };
          saveUsers();
          console.log("User baru:", chatId);
        }
      }
    }

  } catch (err) {
    if (err.response) {
      console.log(err.response.data);
    } else {
      console.log(err.message);
    }
  }
}

async function sendOrEdit(chatId, text) {
  try {

    if (!users[chatId].messageId) {

      const res = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { 
          chat_id: chatId, 
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        }
      );

      users[chatId].messageId = res.data.result.message_id;
      saveUsers();

    } else {

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
        {
          chat_id: chatId,
          message_id: users[chatId].messageId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        }
      );

    }

  } catch (err) {

    if (err.response) {
      const code = err.response.data.error_code;

      if (code === 403) {
        delete users[chatId];
        saveUsers();
      }

      if (code === 400) return;

      console.log(err.response.data);
    } else {
      console.log(err.message);
    }
  }
}

// ================= BALANCE =================

async function checkBalance() {
  const decimals = await safeCall(() => contract.decimals());
  if (!decimals) return null;

  const raw = await safeCall(() => contract.balanceOf(WALLET_ADDRESS));
  if (!raw) return null;

  return ethers.formatUnits(raw, decimals);
}

// ================= TRANSFER CHECK =================

async function checkTransfers() {
  const currentBlock = await safeCall(() => provider.getBlockNumber());
  if (!currentBlock) return;

  if (lastBlock === 0) {
    lastBlock = currentBlock;
    return;
  }

  const events = await safeCall(() =>
    contract.queryFilter(contract.filters.Transfer(), lastBlock + 1, currentBlock)
  );

  if (!events || events.length === 0) {
    lastBlock = currentBlock;
    return;
  }

  for (const e of events) {

    const from = e.args.from.toLowerCase();
    const to = e.args.to.toLowerCase();

    if (from === WALLET_ADDRESS || to === WALLET_ADDRESS) {

      const decimals = await contract.decimals();
      const amount = ethers.formatUnits(e.args.value, decimals);
      const balance = await checkBalance();

      const block = await provider.getBlock(e.blockNumber);
      const time = new Date(block.timestamp * 1000).toLocaleString("id-ID");

      const isIn = to === WALLET_ADDRESS;
      const type = isIn ? "🟢 USDT IN" : "🔴 USDT OUT";
      const addressLine = isIn
        ? `From : ${from}`
        : `To : ${to}`;

      const message =
const addressUrl = `https://celoscan.io/address/${WALLET_ADDRESS}#tokentxns`;
const txUrl = `https://celoscan.io/tx/${e.transactionHash}`;

const message =
`Address : <a href="${addressUrl}">${WALLET_ADDRESS}</a>
Balance : ${balance} USDT

━━━━━━━━━━━━━━━━

${type}
${addressLine}
Jumlah : ${amount} USDT
Block  : ${e.blockNumber}
Waktu  : ${time}
Tx     : <a href="${txUrl}">${e.transactionHash}</a>
`;

      for (const chatId of Object.keys(users)) {
        await sendOrEdit(chatId, message);
      }
    }
  }

  lastBlock = currentBlock;
}

// ================= LOOP 30 DETIK =================

async function transferLoop() {
  while (true) {
    await checkTransfers();
    await new Promise(r => setTimeout(r, 30000)); // 30 detik
  }
}

// ================= START =================

async function start() {
  await removeWebhook();
  initProvider();
  loadUsers();

  console.log("🚀 Bot Aktif");
  console.log("Total user:", Object.keys(users).length);

  setInterval(checkTelegram, 3000);
  transferLoop();
}

start();
