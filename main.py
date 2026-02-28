import time
from web3 import Web3

# --- KONFIGURASI ---
RPC_URLS = [
    "https://purple-silent-emerald.celo-mainnet.quiknode.pro/84dc79220c3f2ec54f9c54e91ec79635a73feb53/",
    "https://forno.celo.org",
    "https://rpc.ankr.com/celo",
    "https://1rpc.io/celo"
]

USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6995348f152"
USDT_ABI = [
    {"anonymous": False, "inputs": [{"indexed": True, "name": "from", "type": "address"}, {"indexed": True, "name": "to", "type": "address"}, {"indexed": False, "name": "value", "type": "uint256"}], "name": "Transfer", "type": "event"}
]

class CryptoMonitor:
    def __init__(self, rpcs):
        self.rpcs = rpcs
        self.current_rpc_idx = 0
        self.w3 = None
        self.usdt_contract = None
        self.connect()

    def connect(self):
        while self.current_rpc_idx < len(self.rpcs):
            # Tampilan diubah menjadi anonim sesuai permintaan
            print(f"🔄 Mencoba Terhubung Ke RPC...")
            self.w3 = Web3(Web3.HTTPProvider(self.rpcs[self.current_rpc_idx]))
            
            if self.w3.is_connected():
                print(f"✅ Terhubung! Blok: {self.w3.eth.block_number}")
                self.usdt_contract = self.w3.eth.contract(
                    address=Web3.to_checksum_address(USDT_ADDRESS), 
                    abi=USDT_ABI
                )
                return
            
            print(f"❌ Gagal. Mencoba cadangan...")
            self.current_rpc_idx += 1
        
        print("⚠️ Semua RPC gagal. Mengulang dalam 10 detik...")
        self.current_rpc_idx = 0
        time.sleep(10)
        self.connect()

    def get_watched_addresses(self):
        try:
            with open("address.txt", "r") as f:
                return [Web3.to_checksum_address(line.strip()) for line in f if line.strip()]
        except:
            return []

    def run(self):
        last_block = self.w3.eth.block_number
        print("🚀 Monitoring dimulai. Menunggu transaksi...")

        while True:
            try:
                current_block = self.w3.eth.block_number
                if current_block <= last_block:
                    time.sleep(2)
                    continue

                for block_num in range(last_block + 1, current_block + 1):
                    watched = self.get_watched_addresses()
                    if not watched: continue

                    # 1. CEK NATIVE CELO
                    block = self.w3.eth.get_block(block_num, full_transactions=True)
                    for tx in block.transactions:
                        to_a, from_a = tx.get('to'), tx.get('from')
                        if from_a in watched or to_a in watched:
                            status = "MASUK 📥" if to_a in watched else "KELUAR 📤"
                            val = self.w3.from_wei(tx['value'], 'ether')
                            if val > 0:
                                self.log_tx("CELO NATIVE", status, from_a, to_a, val, tx['hash'].hex(), block_num)

                    # 2. CEK USDT
                    logs = self.usdt_contract.events.Transfer().get_logs(fromBlock=block_num, toBlock=block_num)
                    for log in logs:
                        f_a, t_a = log.args['from'], log.args['to']
                        if f_a in watched or t_a in watched:
                            status = "MASUK 📥" if t_a in watched else "KELUAR 📤"
                            val = log.args['value'] / 10**6
                            self.log_tx("USDT CELO", status, f_a, t_a, val, log.transactionHash.hex(), block_num)

                last_block = current_block

            except Exception:
                print(f"\n❗ Gangguan koneksi. Mengalihkan...")
                self.connect()

    def log_tx(self, asset, status, f, t, v, tx_hash, block):
        print(f"\n🔔 [{asset}] {status}")
        print(f"   Nilai : {v:.4f} {asset.split()[0]}")
        print(f"   Dari  : {f}")
        print(f"   Ke    : {t}")
        print(f"   Hash  : {tx_hash}")
        print(f"   Blok  : {block}")
        print("-" * 50)

if __name__ == "__main__":
    monitor = CryptoMonitor(RPC_URLS)
    monitor.run()
    
