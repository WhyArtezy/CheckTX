require("dotenv").config();
const { ethers } = require("ethers");
const axios = require("axios");
const fs = require("fs");

// ================= CONFIG =================

const WALLET_ADDRESS = process.env.WALLET_ADDRESS.toLowerCase();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const RPC_LIST = [
  process.env.RPC_1,
  process.env.RPC_2,
  process.env.RPC_3
].filter(Boolean);

const USDT_CONTRACT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";

const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// ================= GLOBAL =================

let provider;
let contract;
let sortedRpcList = [];
let currentRpcIndex = 0;
let lastBlock = 0;
let lastUpdateId = 0;

let CURRENT_RPC = "";
let CONNECTION_STATUS = "🟢 Connected";
const INTERVAL_DELAY = 10000;

const USER_FILE = "user.json";
const BLOCK_FILE = "lastblock.txt";

let users = {};
let lastMessageCache = null;
let alertMessages = {};

// ================= FILE HANDLING =================

function loadUsers() {
  try {
    if (fs.existsSync(USER_FILE)) {
      users = JSON.parse(fs.readFileSync(USER_FILE));
    }
  } catch {
    users = {};
  }
}

function saveUsers() {
  fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2));
}

function loadLastBlock() {
  if (fs.existsSync(BLOCK_FILE)) {
    lastBlock = parseInt(fs.readFileSync(BLOCK_FILE));
  }
}

function saveLastBlock(block) {
  fs.writeFileSync(BLOCK_FILE, block.toString());
}

// ================= RPC SPEED =================

async function testRpcSpeed(rpc) {
  const start = Date.now();
  try {
    const temp = new ethers.JsonRpcProvider(rpc);
    await temp.getBlockNumber();
    return { rpc, speed: Date.now() - start };
  } catch {
    return { rpc, speed: 999999 };
  }
}

async function rankRpcs() {
  const results = [];
  for (const rpc of RPC_LIST) {
    results.push(await testRpcSpeed(rpc));
  }
  results.sort((a, b) => a.speed - b.speed);
  sortedRpcList = results.map(r => r.rpc);
}

// ================= RPC INIT =================

function initProvider() {
  const rpc = sortedRpcList[currentRpcIndex];
  CURRENT_RPC = rpc;

  provider = new ethers.JsonRpcProvider(rpc, {
    name: "celo",
    chainId: 42220
  });

  contract = new ethers.Contract(USDT_CONTRACT, ABI, provider);
}

function switchRpc() {
  currentRpcIndex++;
  if (currentRpcIndex >= sortedRpcList.length) currentRpcIndex = 0;
  initProvider();
}

async function safeCall(fn) {
  try {
    CONNECTION_STATUS = "🟢 Connected";
    return await fn();
  } catch {
    CONNECTION_STATUS = "🔴 RPC Error";
    switchRpc();
    return null;
  }
}

// ================= TELEGRAM =================

async function removeWebhook() {
  try {
    await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`);
  } catch {}
}

async function deleteMessage(chatId, messageId) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`,
      { chat_id: chatId, message_id: messageId }
    );
  } catch {}
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
    if (err.response?.data?.error_code === 403) {
      delete users[chatId];
      saveUsers();
    }
  }
}

async function sendBigAlert(chatId, text) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Tandai Sudah Dilihat", callback_data: "delete_alert" }]
          ]
        }
      }
    );
    alertMessages[chatId] = res.data.result.message_id;
  } catch {}
}

// ================= HISTORY =================

async function sendLastHistory(chatId) {
  if (lastMessageCache) {
    await sendOrEdit(chatId, lastMessageCache);
    return;
  }

  const decimals = await contract.decimals();
  const balanceRaw = await contract.balanceOf(WALLET_ADDRESS);
  const balance = ethers.formatUnits(balanceRaw, decimals);

  const message =
`Address : https://celoscan.io/address/${WALLET_ADDRESS}
Balance : ${balance} USDT

━━━━━━━━━━━━━━━━

Belum ada transaksi terbaru.

${new Date().toLocaleString()}
`;
  await sendOrEdit(chatId, message);
}

// ================= TELEGRAM POLLING =================

async function checkTelegram() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`,
      { params: { offset: lastUpdateId + 1 } }
    );

    for (const update of res.data.result) {
      lastUpdateId = update.update_id;

      // HANDLE START
      if (update.message?.text === "/start") {

        const chatId = String(update.message.chat.id);
        const userMsgId = update.message.message_id;

        if (users[chatId]?.messageId) {
          await deleteMessage(chatId, users[chatId].messageId);
        }

        await deleteMessage(chatId, userMsgId);

        users[chatId] = { messageId: null };
        saveUsers();

        await sendLastHistory(chatId);
      }

      // HANDLE ALERT BUTTON
      if (update.callback_query) {
        const chatId = String(update.callback_query.message.chat.id);
        const messageId = update.callback_query.message.message_id;

        if (update.callback_query.data === "delete_alert") {
          await deleteMessage(chatId, messageId);
          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
            {
              callback_query_id: update.callback_query.id,
              text: "Alert dihapus ✅"
            }
          );
        }
      }
    }
  } catch {}
}

// ================= DASHBOARD =================

function renderDashboard() {
  process.stdout.write("\x1Bc");
  console.log("========= CELO USDT MONITOR =========\n");
  console.log("👥 Total User      :", Object.keys(users).length);
  console.log("🧱 Block Terakhir  :", lastBlock);
  console.log("⚡ RPC Aktif       :", CURRENT_RPC);
  console.log("⏱ Delay Interval   :", INTERVAL_DELAY / 1000, "detik");
  console.log("📡 Status Koneksi  :", CONNECTION_STATUS);
  console.log("\n======================================");
}

// ================= TRANSFER =================

async function checkTransfers() {

  const currentBlock = await safeCall(() => provider.getBlockNumber());
  if (!currentBlock) return;

  if (lastBlock === 0) lastBlock = currentBlock - 1;

  const events = await safeCall(() =>
    contract.queryFilter(contract.filters.Transfer(), lastBlock + 1, currentBlock)
  );

  if (events?.length) {
    for (const e of events) {

      const from = e.args.from.toLowerCase();
      const to = e.args.to.toLowerCase();

      if (from === WALLET_ADDRESS || to === WALLET_ADDRESS) {

        const decimals = await contract.decimals();
        const amount = ethers.formatUnits(e.args.value, decimals);
        const balanceRaw = await contract.balanceOf(WALLET_ADDRESS);
        const balance = ethers.formatUnits(balanceRaw, decimals);

        const block = await provider.getBlock(e.blockNumber);
        const d = new Date(block.timestamp * 1000);
        const pad = n => String(n).padStart(2,"0");

        const time =
`${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} | ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;

        const isIn = to === WALLET_ADDRESS;
        const type = isIn ? "🟢 USDT IN" : "🔴 USDT OUT";
        const addrLine = isIn ? `From : ${from}` : `To : ${to}`;

        const message =
`Address : https://celoscan.io/address/${WALLET_ADDRESS}
Balance : ${balance} USDT

━━━━━━━━━━━━━━━━

${type}
${addrLine}
Jumlah : ${amount} USDT
Block : ${e.blockNumber}
Tx : https://celoscan.io/tx/${e.transactionHash}

${time}
`;

        lastMessageCache = message;

        for (const chatId of Object.keys(users)) {
          await sendOrEdit(chatId, message);
        }

        // 🚨 ALERT > 1000
        if (parseFloat(amount) > 1000) {

          const alertText =
`🚨 <b>ALERT TRANSAKSI BESAR</b>

Jumlah : ${amount} USDT
Block  : ${e.blockNumber}
Tx     : https://celoscan.io/tx/${e.transactionHash}

Segera periksa transaksi ini!`;

          for (const chatId of Object.keys(users)) {
            await sendBigAlert(chatId, alertText);
          }
        }
      }
    }
  }

  lastBlock = currentBlock;
  saveLastBlock(currentBlock);
}

// ================= LOOP =================

async function transferLoop() {
  while (true) {
    await checkTransfers();
    await new Promise(r => setTimeout(r, INTERVAL_DELAY));
  }
}

// ================= START =================

async function start() {

  await removeWebhook();
  loadUsers();
  loadLastBlock();

  await rankRpcs();
  initProvider();

  renderDashboard();
  setInterval(renderDashboard, 60000);

  setInterval(checkTelegram, 5000);
  transferLoop();
}

start();
