import time
import json
from web3 import Web3

# --- KONFIGURASI ---
# Daftar RPC untuk Failover (Jika satu down, pindah ke bawahnya)
RPC_URLS = [
    "https://forno.celo.org",
    "https://rpc.ankr.com/celo",
    "https://celo-mainnet.public.blastapi.io",
    "https://1rpc.io/celo"
]

USDT_CELO_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6995348f152"

ERC20_ABI = [
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "from", "type": "address"},
            {"indexed": True, "name": "to", "type": "address"},
            {"indexed": False, "name": "value", "type": "uint256"}
        ],
        "name": "Transfer",
        "type": "event"
    }
]

class CeloMonitor:
    def __init__(self, rpc_list):
        self.rpc_list = rpc_list
        self.current_rpc_index = 0
        self.w3 = None
        self.connect_rpc()

    def connect_rpc(self):
        """Mencoba menghubungkan ke RPC yang tersedia"""
        while self.current_rpc_index < len(self.rpc_list):
            url = self.rpc_list[self.current_rpc_index]
            print(f"🔄 Mencoba terhubung ke RPC: {url}")
            self.w3 = Web3(Web3.HTTPProvider(url))
            
            if self.w3.is_connected():
                print(f"✅ Terhubung ke {url}")
                return True
            else:
                print(f"❌ RPC {url} Down. Mencoba rpc berikutnya...")
                self.current_rpc_index += 1
        
        # Jika semua RPC gagal, balik ke awal dan tunggu
        print("⚠️ Semua RPC Down. Menunggu 10 detik sebelum mengulang...")
        self.current_rpc_index = 0
        time.sleep(10)
        return self.connect_rpc()

    def load_addresses(self, filename):
        try:
            with open(filename, "r") as f:
                return [Web3.to_checksum_address(line.strip()) for line in f if line.strip()]
        except Exception as e:
            print(f"Error membaca file: {e}")
            return []

    def start_monitoring(self):
        usdt_contract = self.w3.eth.contract(
            address=Web3.to_checksum_address(USDT_CELO_ADDRESS), 
            abi=ERC20_ABI
        )
        
        print("--- MONITORING USDT CELO AKTIF ---")
        last_block = self.w3.eth.block_number

        while True:
            try:
                current_block = self.w3.eth.block_number
                
                if current_block <= last_block:
                    time.sleep(2)
                    continue

                for block_num in range(last_block + 1, current_block + 1):
                    watched_wallets = self.load_addresses("address.txt")
                    logs = usdt_contract.events.Transfer().get_logs(fromBlock=block_num, toBlock=block_num)
                    
                    for log in logs:
                        from_addr = log.args['from']
                        to_addr = log.args['to']
                        value = log.args['value'] / 10**6 

                        if from_addr in watched_wallets or to_addr in watched_wallets:
                            status = "MASUK 📥" if to_addr in watched_wallets else "KELUAR 📤"
                            print(f"\n🔔 [USDT CELO] {status} | {value:.2f} USDT")
                            print(f"Hash: {log.transactionHash.hex()}")
                            print(f"Dari: {from_addr}\nKe  : {to_addr}")
                            print("-" * 40)

                last_block = current_block

            except Exception as e:
                print(f"❗ Gangguan koneksi: {e}")
                print("🔄 Mengalihkan ke RPC cadangan...")
                self.current_rpc_index = (self.current_rpc_index + 1) % len(self.rpc_list)
                self.connect_rpc()
                # Update contract instance dengan koneksi baru
                usdt_contract = self.w3.eth.contract(
                    address=Web3.to_checksum_address(USDT_CELO_ADDRESS), 
                    abi=ERC20_ABI
                )

if __name__ == "__main__":
    monitor = CeloMonitor(RPC_URLS)
    monitor.start_monitoring()
    
