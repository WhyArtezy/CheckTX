require("dotenv").config();
const { ethers } = require("ethers");
const axios = require("axios");
const fs = require("fs");

// ================= CONFIG =================

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS.toLowerCase();

const RPC_LIST = [
  process.env.RPC_1,
  process.env.RPC_2,
  process.env.RPC_3
].filter(Boolean);

const INTERVAL_DELAY = 10000; // 10 detik
const ALERT_LIMIT = 1000;

const USDT_CONTRACT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";

const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// ================= GLOBAL =================

let provider;
let contract;
let users = [];
let lastBlock = 0;
let sortedRpcList = [];
let CURRENT_RPC = "";
let CONNECTION_STATUS = "🟢 Connected";

// ================= FILE HANDLING =================

function loadUsers() {
  try {
    if (!fs.existsSync("user.json")) {
      fs.writeFileSync("user.json", "[]");
    }

    const data = fs.readFileSync("user.json");

    if (!data.length) {
      users = [];
      return;
    }

    users = JSON.parse(data);
  } catch {
    users = [];
    fs.writeFileSync("user.json", "[]");
  }
}

function saveUsers() {
  fs.writeFileSync("user.json", JSON.stringify(users, null, 2));
}

// ================= RPC SPEED =================

async function testRpcSpeed(rpc) {
  try {
    const start = Date.now();
    const p = new ethers.JsonRpcProvider(rpc);
    await p.getBlockNumber();
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

function initProvider() {
  CURRENT_RPC = sortedRpcList[0];
  provider = new ethers.JsonRpcProvider(CURRENT_RPC);
  contract = new ethers.Contract(USDT_CONTRACT, ABI, provider);
}

function switchRpc() {
  sortedRpcList.push(sortedRpcList.shift());
  initProvider();
}

// ================= TIME FORMAT =================

function getTime() {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hour = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");

  return `${day}/${month}/${year} | ${hour}.${min}.${sec}`;
}

// ================= TELEGRAM =================

async function sendMessage(chatId, text, keyboard = null) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text: text,
        reply_markup: keyboard,
        disable_web_page_preview: true
      }
    );

    return res.data.result.message_id;
  } catch (err) {
    if (err.response?.status === 403) {
      users = users.filter(u => u.chatId !== chatId);
      saveUsers();
      console.log("🚫 User blokir bot:", chatId);
    }
  }
}

async function editMessage(chatId, messageId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
      {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        disable_web_page_preview: true
      }
    );
  } catch {}
}

async function deleteMessage(chatId, messageId) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`,
      {
        chat_id: chatId,
        message_id: messageId
      }
    );
  } catch {}
}

// ================= DASHBOARD =================

function renderDashboard() {
  process.stdout.write("\x1Bc");

  console.log("========= CELO USDT MONITOR =========\n");
  console.log("👥 Total User      :", users.length);
  console.log("🧱 Block Terakhir  :", lastBlock);
  console.log("⚡ RPC Aktif       :", CURRENT_RPC);
  console.log("⏱ Delay Interval  :", INTERVAL_DELAY / 1000, "detik");
  console.log("📡 Status Koneksi  :", CONNECTION_STATUS);
  console.log("\n======================================");
}

// ================= CHECK TX =================

async function checkTransfers() {
  try {
    const currentBlock = await provider.getBlockNumber();

    if (lastBlock === 0) {
      lastBlock = currentBlock;
      return;
    }

    const events = await contract.queryFilter(
      contract.filters.Transfer(),
      lastBlock,
      currentBlock
    );

    for (const e of events) {
      const from = e.args.from.toLowerCase();
      const to = e.args.to.toLowerCase();

      if (from === WALLET_ADDRESS || to === WALLET_ADDRESS) {
        const decimals = await contract.decimals();
        const amount = Number(ethers.formatUnits(e.args.value, decimals));

        const rawBalance = await contract.balanceOf(WALLET_ADDRESS);
        const balance = ethers.formatUnits(rawBalance, decimals);

        const type = to === WALLET_ADDRESS ? "🟢 USDT IN" : "🔴 USDT OUT";
        const addressLine =
          to === WALLET_ADDRESS ? `From : ${from}` : `To : ${to}`;

        const message = `Address : https://celoscan.io/address/${WALLET_ADDRESS}#tokentxns
Balance : ${balance} USDT

━━━━━━━━━━━━━━━━

${type}
${addressLine}
Jumlah : ${amount} USDT
Block : ${e.blockNumber}
Tx : ${e.transactionHash}

${getTime()}`;

        for (let user of users) {
          if (!user.messageId) {
            user.messageId = await sendMessage(user.chatId, message);
          } else {
            await editMessage(user.chatId, user.messageId, message);
          }

          if (amount > ALERT_LIMIT) {
            const keyboard = {
              inline_keyboard: [
                [{ text: "✅ Tutup Alert", callback_data: "close_alert" }]
              ]
            };

            await sendMessage(
              user.chatId,
              `🚨 ALERT TRANSAKSI BESAR\n\nJumlah : ${amount} USDT\nBlock : ${e.blockNumber}\nTx : ${e.transactionHash}`,
              keyboard
            );
          }
        }

        saveUsers();
      }
    }

    lastBlock = currentBlock;
    CONNECTION_STATUS = "🟢 Connected";

  } catch {
    CONNECTION_STATUS = "🔴 RPC Error";
    switchRpc();
  }
}

// ================= TELEGRAM LISTENER =================

async function listenTelegram() {
  let offset = 0;

  setInterval(async () => {
    try {
      const res = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`,
        { params: { offset: offset + 1, timeout: 10 } }
      );

      for (let update of res.data.result) {
        offset = update.update_id;

        if (update.message?.text === "/start") {
          const chatId = update.message.chat.id;

          users = users.filter(u => u.chatId !== chatId);

          users.push({ chatId, messageId: null });

          saveUsers();
          console.log("🔄 User refresh:", chatId);
        }

        if (update.callback_query?.data === "close_alert") {
          const chatId = update.callback_query.message.chat.id;
          const msgId = update.callback_query.message.message_id;
          await deleteMessage(chatId, msgId);
        }
      }
    } catch {}
  }, 3000);
}

// ================= START =================

async function start() {
  loadUsers();
  await rankRpcs();
  initProvider();

  renderDashboard();
  setInterval(renderDashboard, 60000);
  setInterval(checkTransfers, INTERVAL_DELAY);

  listenTelegram();
}

start();
