import time
import json
from web3 import Web3

# --- KONFIGURASI ---
CELO_RPC_URL = "https://forno.celo.org" # Bisa diganti ke WSS jika punya provider premium
USDT_CELO_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6995348f152"

# ABI Minimal untuk mendeteksi event Transfer ERC-20
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

def load_addresses(filename):
    """Membaca daftar wallet dari file address.txt"""
    try:
        with open(filename, "r") as f:
            # Pastikan semua alamat dalam format Checksum (case-sensitive)
            return [Web3.to_checksum_address(line.strip()) for line in f if line.strip()]
    except Exception as e:
        print(f"Error file: {e}")
        return []

def main():
    w3 = Web3(Web3.HTTPProvider(CELO_RPC_URL))
    if not w3.is_connected():
        print("Gagal terhubung ke Celo Network")
        return

    usdt_contract = w3.eth.contract(address=Web3.to_checksum_address(USDT_CELO_ADDRESS), abi=ERC20_ABI)
    
    print("--- MONITORING USDT CELO DIMULAI ---")
    last_block = w3.eth.block_number

    while True:
        try:
            current_block = w3.eth.block_number
            if current_block <= last_block:
                time.sleep(2) # Tunggu blok baru
                continue

            # Scan blok dari yang terakhir kita cek sampai yang terbaru
            for block_num in range(last_block + 1, current_block + 1):
                watched_wallets = load_addresses("address.txt")
                
                # Cari logs Transfer USDT di blok ini
                logs = usdt_contract.events.Transfer().get_logs(fromBlock=block_num, toBlock=block_num)
                
                for log in logs:
                    from_addr = log.args['from']
                    to_addr = log.args['to']
                    # USDT Celo menggunakan 6 desimal
                    value = log.args['value'] / 10**6 

                    # Cek apakah pengirim atau penerima ada di list kita
                    if from_addr in watched_wallets or to_addr in watched_wallets:
                        status = "MASUK 📥" if to_addr in watched_wallets else "KELUAR 📤"
                        
                        print(f"\n🔔 [USDT CELO] Transaksi {status}")
                        print(f"Hash : {log.transactionHash.hex()}")
                        print(f"Dari : {from_addr}")
                        print(f"Ke   : {to_addr}")
                        print(f"Nilai: {value:.2f} USDT")
                        print(f"Block: {block_num}")
                        print("-" * 40)

            last_block = current_block

        except Exception as e:
            print(f"Error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    main()
          
