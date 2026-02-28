import time
from web3 import Web3

# 1. Inisialisasi menggunakan URL QuickNode kamu
QUICKNODE_URL = "https://purple-silent-emerald.celo-mainnet.quiknode.pro/84dc79220c3f2ec54f9c54e91ec79635a73feb53/"
w3 = Web3(Web3.HTTPProvider(QUICKNODE_URL))

if not w3.is_connected():
    print("Gagal terhubung ke QuickNode!")
    exit()

def load_addresses():
    try:
        with open("address.txt", "r") as f:
            return [Web3.to_checksum_address(line.strip()) for line in f if line.strip()]
    except FileNotFoundError:
        print("File address.txt tidak ditemukan!")
        return []

def main():
    print(f"Terhubung ke Celo. Blok Saat Ini: {w3.eth.block_number}")
    print("Menunggu transaksi baru...")
    
    last_checked_block = w3.eth.block_number

    while True:
        try:
            current_block = w3.eth.block_number
            
            # Jika ada blok baru
            if current_block > last_checked_block:
                for block_num in range(last_checked_block + 1, current_block + 1):
                    watched_wallets = load_addresses()
                    block = w3.eth.get_block(block_num, full_transactions=True)
                    
                    for tx in block.transactions:
                        # Cek transaksi CELO native
                        to_addr = tx.get('to')
                        from_addr = tx.get('from')

                        if from_addr in watched_wallets or to_addr in watched_wallets:
                            status = "MASUK 📥" if to_addr in watched_wallets else "KELUAR 📤"
                            val = w3.from_wei(tx['value'], 'ether')
                            print(f"\n🔔 [CELO NATIVE] {status}")
                            print(f"Hash : {tx['hash'].hex()}")
                            print(f"Nilai: {val} CELO")
                            print("-" * 30)

                last_checked_block = current_block
            
            time.sleep(1) # Jeda agar tidak terkena rate limit berlebih

        except Exception as e:
            print(f"Error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    main()
