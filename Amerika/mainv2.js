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

const USDT_CONTRACT = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";

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
let lastUpdateId = 0;
let scannedUpTo = 0;

let CURRENT_RPC = "";
let CONNECTION_STATUS = "🟢 Connected";
const INTERVAL_DELAY = 2000;

const USER_FILE = "user.json";

let users = {};
let lastMessageCache = null;
let processedTx = new Set();
let lowBalanceAlerted = false;

// ================= FILE =================

function loadUsers() {
  try {
    if (fs.existsSync(USER_FILE)) {
      const data = fs.readFileSync(USER_FILE, "utf8");
      users = data ? JSON.parse(data) : {};
    }
  } catch {
    users = {};
  }
}

function saveUsers() {
  fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2));
}

// ================= RPC =================

async function rankRpcs() {
  const results = [];
  for (const rpc of RPC_LIST) {
    try {
      const start = Date.now();
      const temp = new ethers.JsonRpcProvider(rpc);
      await temp.getBlockNumber();
      results.push({ rpc, speed: Date.now() - start });
    } catch {
      results.push({ rpc, speed: 999999 });
    }
  }
  results.sort((a, b) => a.speed - b.speed);
  sortedRpcList = results.map(r => r.rpc);
}

function initProvider() {
  const rpc = sortedRpcList[currentRpcIndex];
  CURRENT_RPC = rpc;
  provider = new ethers.JsonRpcProvider(rpc, {
    name: "celo",
    chainId: 42220
  });
  contract = new ethers.Contract(USDT_CONTRACT, ABI, provider);
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
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Tandai Sudah Dilihat", callback_data: "delete_alert" }]
        ]
      }
    }
  );
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

      if (update.message?.text === "/start") {

        const chatId = String(update.message.chat.id);
        const userMsgId = update.message.message_id;

        if (users[chatId]?.messageId) {
          await deleteMessage(chatId, users[chatId].messageId);
        }

        await deleteMessage(chatId, userMsgId);

        users[chatId] = { messageId: null };
        saveUsers();

        if (lastMessageCache) {
          await sendOrEdit(chatId, lastMessageCache);
        }
      }

      if (update.callback_query?.data === "delete_alert") {
        const chatId = String(update.callback_query.message.chat.id);
        const messageId = update.callback_query.message.message_id;

        await deleteMessage(chatId, messageId);

        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
          {
            callback_query_id: update.callback_query.id,
            text: "Alert dihapus"
          }
        );
      }
    }
  } catch {}
}

// ================= TRANSFER CHECK =================

async function checkTransfers() {

  const currentBlock = await provider.getBlockNumber();

  // Inisialisasi awal: mulai dari block saat ini agar tidak scan history
  if (scannedUpTo === 0) {
    scannedUpTo = currentBlock;
    return;
  }

  // Tidak ada block baru, skip
  if (currentBlock <= scannedUpTo) return;

  const events = await contract.queryFilter(
    contract.filters.Transfer(),
    scannedUpTo + 1,
    currentBlock
  );

  // Filter hanya transaksi yang relevan dengan wallet, ambil yang terakhir saja
  const relevantEvents = events.filter(e => {
    const from = e.args.from.toLowerCase();
    const to = e.args.to.toLowerCase();
    return (from === WALLET_ADDRESS || to === WALLET_ADDRESS) && !processedTx.has(e.transactionHash);
  });

  if (relevantEvents.length === 0) {
    scannedUpTo = currentBlock;
    return;
  }

  const e = relevantEvents[relevantEvents.length - 1];
  processedTx.add(e.transactionHash);

  const from = e.args.from.toLowerCase();
  const to = e.args.to.toLowerCase();

  const decimals = await contract.decimals();
  const amount = ethers.formatUnits(e.args.value, decimals);
  const balanceRaw = await contract.balanceOf(WALLET_ADDRESS);
  const balance = ethers.formatUnits(balanceRaw, decimals);

  const block = await provider.getBlock(e.blockNumber);
  const d = new Date(block.timestamp * 1000);

  const time =
    `${String(d.getDate()).padStart(2,"0")}/` +
    `${String(d.getMonth()+1).padStart(2,"0")}/` +
    `${d.getFullYear()} | ` +
    `${String(d.getHours()).padStart(2,"0")}:` +
    `${String(d.getMinutes()).padStart(2,"0")}:` +
    `${String(d.getSeconds()).padStart(2,"0")}`;

  const isIn = to === WALLET_ADDRESS;
  const type = isIn ? "🟢 USDT IN" : "🔴 USDT OUT";
  const counterparty = isIn ? from : to;

  const message =
`<b>AMERIKA</b>

Address : <a href="https://celoscan.io/address/${WALLET_ADDRESS}">${WALLET_ADDRESS}</a>
Balance : ${balance} USDC

${time}
`;

  lastMessageCache = message;

  // Kirim ke semua user secara paralel
  await Promise.all(
    Object.keys(users).map(chatId => sendOrEdit(chatId, message))
  );

  if (parseFloat(amount) > 1000) {
    const alertText =
`🚨 <b> AMERIKA | TRANSAKSI BESAR</b>

Address : <a href="https://celoscan.io/address/${WALLET_ADDRESS}">${WALLET_ADDRESS}</a>
Jumlah: ${amount} USDC
Block : ${e.blockNumber}
Tx : <a href="https://celoscan.io/tx/${e.transactionHash}">${e.transactionHash}</a>

${time}
`;

    // Kirim alert besar ke semua user secara paralel
    await Promise.all(
      Object.keys(users).map(chatId => sendBigAlert(chatId, alertText))
    );
  }

  // ---- ALERT LOW BALANCE ----
  const balanceNum = parseFloat(balance);
  if (balanceNum < 500 && !lowBalanceAlerted) {
    lowBalanceAlerted = true;
    const lowBalanceText =
`⚠️ <b> AMERIKA |  SALDO RENDAH</b>

Address : <a href="https://celoscan.io/address/${WALLET_ADDRESS}">${WALLET_ADDRESS}</a>
Saldo saat ini <b>${balance} USDC</b>

${time}
`;

    await Promise.all(
      Object.keys(users).map(chatId => sendBigAlert(chatId, lowBalanceText))
    );
  }

  // Reset flag jika saldo sudah kembali >= 500
  if (balanceNum >= 500 && lowBalanceAlerted) {
    lowBalanceAlerted = false;
  }

  // Bersihkan processedTx agar memori tidak membengkak
  if (processedTx.size > 10000) {
    processedTx.clear();
  }

  scannedUpTo = currentBlock;
}

// ================= TERMINAL STATUS =================

setInterval(() => {
  process.stdout.write("\x1Bc");
  console.log(`Total User        : ${Object.keys(users).length}`);
  console.log(`Block Terakhir    : ${scannedUpTo}`);
  console.log(`RPC Aktif         : ${CURRENT_RPC}`);
  console.log(`Delay Interval    : ${INTERVAL_DELAY / 1000} detik`);
  console.log(`Status Koneksi    : ${CONNECTION_STATUS}`);
}, 10000);

// ================= START =================

async function start() {
  await removeWebhook();
  loadUsers();
  await rankRpcs();
  initProvider();

  while (true) {
    try {
      await Promise.all([
        checkTransfers(),
        checkTelegram()
      ]);
      CONNECTION_STATUS = "🟢 Connected";
    } catch {
      CONNECTION_STATUS = "🔴 Reconnecting";
      currentRpcIndex = (currentRpcIndex + 1) % sortedRpcList.length;
      initProvider();
    }

    await new Promise(r => setTimeout(r, INTERVAL_DELAY));
  }
}

start();
