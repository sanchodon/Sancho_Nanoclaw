import subprocess
import os


def get_mac_model():
    
    try:    # This specifically grabs the "Apple M2" text from your system
        cmd = "sysctl -n machdep.cpu.brand_string"
        return subprocess.check_output(cmd, shell=True).decode().strip()
    except:
        return "Apple Silicon Mac"
        # This command is specific to Apple Silicon and may not work on all systems
      
      


def check_process_status(name):
    try:
        # Searches all processes for your bot's name
        cmd = f"ps aux | grep -i '{name}' | grep -v grep"
        output = subprocess.check_output(cmd, shell=True).decode()
        return "RUNNING ✅" if output else "STOPPED ❌"
    except:
        return "STOPPED ❌"

def check_api_ping():
    try:
        subprocess.check_output("ping -c 1 google.com", shell=True)
        return "CONNECTED 🌐"
    except:
        return "DISCONNECTED ⚠️"

# --- This is where the output happens ---
# --- Production Dashboard ---
print(f"\n--- 🖥️  SARO IT | {get_mac_model()} ---")
# (The rest of your print lines stay the same below this)
print("--- 🛡️ NANOCLAW SYSTEM CHECK (Apple Container) ---")
#print(f"📍 M2 Thermal Status: {get_m2_temp()}")
print(f"🌍 Internet/API Path: {check_api_ping()}")
# Updated to look for Sancho
print(f"🤖 Bot Status (Sancho): {check_process_status('nanoclaw')}") 
print("-------------------------------------------------")