#!/bin/bash
# ============================================================
#  NanoClaw Installer v5.3
#  Anan · Maria · Nadia — AI Agent Team via LINE
#
#  Architecture:
#  [LINE] -> [ngrok] -> [NanoClaw on Mac, node dist/index.js]
#                            | (spawned per agent task)
#                      [Apple Container ephemeral]
#
#  Agents installed:
#    Anan  — AI Accountant for Thai SME
#    Maria — Personal AI Secretary
#    Nadia — TikTok Product Sourcing Specialist
#
#  Usage:
#    Normal install (when repo is public):
#      curl -fsSL https://your-gist-url | bash
#
#    Developer mode (also installs Claude Code):
#      curl -fsSL https://your-gist-url | bash -s -- --dev
#
#    Local test mode (before repo is public):
#      curl -fsSL https://your-gist-url | bash -s -- --local
#      curl -fsSL https://your-gist-url | bash -s -- --local --dev
#
#    Note: --local installs into ~/nanoclaw-fresh (never touches ~/nanoclaw)
# ============================================================

set -euo pipefail

# Colours
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}OK  $1${NC}"; }
info() { echo -e "${CYAN}... $1${NC}"; }
warn() { echo -e "${YELLOW}!   $1${NC}"; }
fail() { echo -e "${RED}ERR $1${NC}"; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}> $1${NC}"; }

# Config
NANOCLAW_REPO="https://github.com/YOUR_USERNAME/nanoclaw.git"
NANOCLAW_INSTALL_DIR="$HOME/nanoclaw"
NANOCLAW_LOCAL_SRC="$HOME/nanoclaw"
NANOCLAW_TEST_DIR="$HOME/nanoclaw-fresh"
NANOCLAW_PORT=3000
APPLE_CONTAINER_API="https://api.github.com/repos/apple/container/releases/latest"

# Parse flags
INSTALL_CLAUDE_CODE=false
LOCAL_TEST=false
for arg in "$@"; do
  [[ "$arg" == "--dev"   ]] && INSTALL_CLAUDE_CODE=true
  [[ "$arg" == "--local" ]] && LOCAL_TEST=true
done

# Banner
echo ""
echo -e "${BOLD}${CYAN}=====================================================${NC}"
echo -e "${BOLD}${CYAN}   NanoClaw Installer v5.3${NC}"
echo -e "${BOLD}${CYAN}   Anan · Maria · Nadia — AI Agent Team${NC}"
echo -e "${BOLD}${CYAN}=====================================================${NC}"
echo ""
[[ "$LOCAL_TEST"          == true ]] && warn "Local test mode - install to ~/nanoclaw-fresh"
[[ "$INSTALL_CLAUDE_CODE" == true ]] && info "Developer mode - Claude Code will be installed"
echo ""

# Confirmation prompt - important for trust with non-technical users
echo -e "  This script will install NanoClaw on your Mac."
echo -e "  It will install: Homebrew, Node.js, Git, Apple Container, NanoClaw"
echo -e "  Agents: Anan (Accounting), Maria (Secretary), Nadia (Sourcing)"
echo ""
read -rp "  Continue? (y/N): " CONFIRM
[[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]] && { echo "Cancelled."; exit 0; }
echo ""

# ====================================================
step "1 - Check macOS"
# ====================================================

[[ "$(uname)" != "Darwin" ]] && fail "macOS only"

OS_VER=$(sw_vers -productVersion)
OS_MAJOR=$(echo "$OS_VER" | cut -d. -f1)

if [[ "$OS_MAJOR" -lt 26 ]]; then
  warn "macOS $OS_VER - Apple Container requires macOS 26 (Tahoe) or later"
  read -rp "   Continue without Apple Container? (y/N) " CONT
  [[ "$CONT" != "y" && "$CONT" != "Y" ]] && fail "Cancelled"
  USE_CONTAINER=false
else
  ok "macOS $OS_VER (Tahoe) - Apple Container supported"
  USE_CONTAINER=true
fi

# ====================================================
step "2 - Install Homebrew, Node, Git"
# ====================================================

if ! command -v brew &>/dev/null; then
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null \
    || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
else
  ok "Homebrew ready"
fi

for tool in node git; do
  if ! command -v "$tool" &>/dev/null; then
    info "Installing $tool..."
    brew install "$tool"
  else
    ok "$tool ready ($(${tool} --version 2>/dev/null | head -1))"
  fi
done

# ====================================================
step "3 - Install Apple Container CLI"
# ====================================================
# NanoClaw runs on Mac directly.
# Apple Container system service must be running so agents
# can spawn ephemeral containers for tasks.

if [[ "$USE_CONTAINER" == true ]]; then
  if command -v container &>/dev/null; then
    ok "Apple Container CLI already installed"
  else
    info "Downloading Apple Container CLI (latest version)..."
    DEFAULT_CONTAINER_VERSION="0.10.0"
    CONTAINER_VERSION=$(curl -fsSL "$APPLE_CONTAINER_API" \
      | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
    if [[ -z "$CONTAINER_VERSION" ]]; then
      warn "Could not fetch latest version - using fallback version $DEFAULT_CONTAINER_VERSION"
      CONTAINER_VERSION="$DEFAULT_CONTAINER_VERSION"
    fi
    info "Version: $CONTAINER_VERSION"
    PKG_URL="https://github.com/apple/container/releases/download/${CONTAINER_VERSION}/container-${CONTAINER_VERSION}-installer-signed.pkg"
    PKG_FILE="/tmp/apple-container-installer.pkg"
    curl -fsSL -o "$PKG_FILE" "$PKG_URL" || fail "Download failed"
    sudo installer -pkg "$PKG_FILE" -target / || fail "Install failed"
    rm -f "$PKG_FILE"
    ok "Apple Container $CONTAINER_VERSION installed"
  fi

  info "Starting Apple Container system service..."
  container system start 2>/dev/null || true
  sleep 2

  if container system status &>/dev/null 2>&1; then
    ok "Apple Container system service running"
  else
    warn "Container service may not be ready - NanoClaw will try to start it on launch"
  fi
fi

# ====================================================
step "4 - Get NanoClaw source"
# ====================================================

if [[ "$LOCAL_TEST" == true ]]; then
  # Local test: copy ~/nanoclaw -> ~/nanoclaw-fresh
  # Never deletes or modifies ~/nanoclaw (the original)
  [[ ! -d "$NANOCLAW_LOCAL_SRC" ]] && fail "Source not found at $NANOCLAW_LOCAL_SRC"

  NANOCLAW_INSTALL_DIR="$NANOCLAW_TEST_DIR"

  if [[ -d "$NANOCLAW_INSTALL_DIR" ]]; then
    info "Removing old test folder $NANOCLAW_INSTALL_DIR..."
    rm -rf "$NANOCLAW_INSTALL_DIR"
  fi

  info "Copying source to $NANOCLAW_INSTALL_DIR (simulating fresh install)..."
  rsync -a \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='.env' \
    --exclude='store' \
    --exclude='data' \
    --exclude='logs' \
    "$NANOCLAW_LOCAL_SRC/" "$NANOCLAW_INSTALL_DIR/"
  ok "Source copied to $NANOCLAW_INSTALL_DIR"

else
  # Normal: clone from GitHub
  [[ "$NANOCLAW_REPO" == *"YOUR_USERNAME"* ]] && \
    fail "Please update NANOCLAW_REPO in this script before going public"

  if [[ -d "$NANOCLAW_INSTALL_DIR" ]]; then
    warn "Folder $NANOCLAW_INSTALL_DIR already exists"
    read -rp "   Delete and reinstall? (y/N) " REINSTALL
    if [[ "$REINSTALL" == "y" || "$REINSTALL" == "Y" ]]; then
      rm -rf "$NANOCLAW_INSTALL_DIR"
    else
      info "Keeping existing folder - skipping clone"
    fi
  fi

  if [[ ! -d "$NANOCLAW_INSTALL_DIR" ]]; then
    info "Cloning from GitHub..."
    git clone "$NANOCLAW_REPO" "$NANOCLAW_INSTALL_DIR" \
      || fail "Clone failed - check repo URL and access"
    ok "Clone complete"
  fi
fi

# ====================================================
step "5 - Build NanoClaw"
# ====================================================

cd "$NANOCLAW_INSTALL_DIR"

info "Installing dependencies..."
npm ci

info "Building TypeScript -> dist/..."
npm run build || fail "Build failed - check errors with: npm run typecheck"

ok "Build complete - dist/index.js ready"

# ====================================================
step "6 - Register Anan, Maria, and Nadia"
# ====================================================
# Seeds the database so every new LINE group automatically
# gets the right agent - no manual setup needed per group.

info "Creating store directory..."
mkdir -p "$NANOCLAW_INSTALL_DIR/store"

# --- Anan: SME Accounting Assistant ---
info "Registering Anan (AI Accountant for Thai SME)..."
npm run setup -- --step register \
  --jid "anan-template" \
  --name "Anan" \
  --folder "anan" \
  --trigger "Anan|อนันต์" \
  --no-trigger-required \
  --assistant-name "Anan" \
  || fail "Failed to register Anan"
ok "Anan registered"

# --- Maria: Personal AI Secretary ---
info "Registering Maria (Personal AI Secretary)..."
npm run setup -- --step register \
  --jid "maria-template" \
  --name "Maria" \
  --folder "maria" \
  --trigger "Maria|มาเรีย" \
  --no-trigger-required \
  --assistant-name "Maria" \
  || fail "Failed to register Maria"
ok "Maria registered"

# --- Nadia: TikTok Product Sourcing Specialist ---
info "Registering Nadia (TikTok Sourcing Specialist)..."
npm run setup -- --step register \
  --jid "nadia-template" \
  --name "Nadia" \
  --folder "nadia" \
  --trigger "Nadia|นาเดีย" \
  --no-trigger-required \
  --assistant-name "Nadia" \
  || fail "Failed to register Nadia"
ok "Nadia registered"

# --- LINE DM channel (default: Anan) ---
info "Registering main LINE DM channel..."
npm run setup -- --step register \
  --jid "line-main" \
  --name "LINE DM" \
  --folder "main" \
  --trigger "@" \
  --no-trigger-required \
  --assistant-name "Anan" \
  || fail "Failed to register LINE DM channel"
ok "LINE DM channel registered"

# ====================================================
step "7 - Setup .env"
# ====================================================

if [[ ! -f "$NANOCLAW_INSTALL_DIR/.env" ]]; then
  if [[ -f "$NANOCLAW_INSTALL_DIR/.env.example" ]]; then
    cp "$NANOCLAW_INSTALL_DIR/.env.example" "$NANOCLAW_INSTALL_DIR/.env"
    warn ".env created from .env.example - fill in these values before starting:"
  else
    cat > "$NANOCLAW_INSTALL_DIR/.env" <<'ENVEOF'
# LINE Channel credentials (get from LINE Developer Console)
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=

# Anthropic API key (get from console.anthropic.com)
ANTHROPIC_API_KEY=

# Default agent name for the main LINE DM channel
ASSISTANT_NAME=Anan
ENVEOF
    warn ".env created - fill in your credentials before starting"
  fi
  info "  LINE_CHANNEL_ACCESS_TOKEN=  <- from LINE Developer Console"
  info "  LINE_CHANNEL_SECRET=        <- from LINE Developer Console"
  info "  ANTHROPIC_API_KEY=          <- from console.anthropic.com"
else
  ok ".env already exists"
fi

# ====================================================
step "8 - Install NanoClaw as auto-start service"
# ====================================================
# Uses setup/service.ts which handles automatically:
# - macOS  -> launchd plist in ~/Library/LaunchAgents/
#             Starts on every login, restarts if it crashes
# - Linux  -> systemd user service
# - WSL    -> nohup fallback script

if [[ "$LOCAL_TEST" == true ]]; then
  warn "Skipping service install in local test mode (protects production com.nanoclaw.plist)"
  info "To test service manually: cd $NANOCLAW_INSTALL_DIR && npm start"
else
  info "Installing NanoClaw service (auto-start on login)..."
  npm run setup -- --step service \
    || warn "Service install failed - start manually with: cd $NANOCLAW_INSTALL_DIR && npm start"
  ok "NanoClaw service installed - agents start automatically on login"
fi

# ====================================================
step "9 - Check ngrok"
# ====================================================

if command -v ngrok &>/dev/null; then
  ok "ngrok found - LINE -> ngrok -> localhost:$NANOCLAW_PORT -> NanoClaw"
else
  warn "ngrok not found - install before using:"
  info "  brew install ngrok/ngrok/ngrok"
  info "  ngrok config add-authtoken <YOUR_TOKEN>"
fi

# ====================================================
step "10 - Install Claude Code CLI (Developer Mode)"
# ====================================================

if [[ "$INSTALL_CLAUDE_CODE" == true ]]; then
  if command -v claude &>/dev/null; then
    ok "Claude Code already installed ($(claude --version 2>/dev/null || echo 'installed'))"
  else
    info "Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code || fail "Claude Code install failed"
    ok "Claude Code installed"
  fi
else
  info "Skipping Claude Code - add --dev flag to install"
fi

# ====================================================
step "11 - Health check"
# ====================================================

info "Checking if NanoClaw is running..."
sleep 2
if lsof -i :$NANOCLAW_PORT >/dev/null 2>&1; then
  ok "NanoClaw is running on port $NANOCLAW_PORT"
else
  warn "NanoClaw not detected on port $NANOCLAW_PORT"
  info "Fill in .env credentials then start with:"
  info "  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
fi

# ====================================================
# Summary
# ====================================================

echo ""
echo -e "${BOLD}${GREEN}=====================================================${NC}"
echo -e "${BOLD}${GREEN}   NanoClaw v5.3 installed successfully!${NC}"
echo -e "${BOLD}${GREEN}=====================================================${NC}"
echo ""
echo -e "  ${YELLOW}Next Steps:${NC}"
echo ""
echo -e "  1. Fill in your credentials in .env"
echo -e "     ${BLUE}nano $NANOCLAW_INSTALL_DIR/.env${NC}"
echo ""
echo -e "  2. Agents auto-start on login - or start now:"
echo -e "     ${BLUE}launchctl kickstart -k gui/\$(id -u)/com.nanoclaw${NC}"
echo ""
echo -e "  3. Open ngrok tunnel (new terminal):"
echo -e "     ${BLUE}ngrok http $NANOCLAW_PORT${NC}"
echo ""
echo -e "  4. Set Webhook URL in LINE Developer Console"
echo ""
echo -e "  5. Add your LINE bot to a group and mention an agent by name:"
echo -e "     ${CYAN}Anan${NC}  or ${CYAN}อนันต์${NC}   — SME Accounting"
echo -e "     ${CYAN}Maria${NC} or ${CYAN}มาเรีย${NC}  — Personal Secretary"
echo -e "     ${CYAN}Nadia${NC} or ${CYAN}นาเดีย${NC}  — TikTok Sourcing"
echo ""
if [[ "$USE_CONTAINER" == true ]]; then
  echo -e "  ${CYAN}Apple Container:${NC} Agents spawn containers automatically when needed"
  echo -e "  Check: ${BLUE}container list${NC}"
  echo ""
fi
echo -e "  ${CYAN}Service commands:${NC}"
echo -e "  Stop:    ${BLUE}launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist${NC}"
echo -e "  Restart: ${BLUE}launchctl kickstart -k gui/\$(id -u)/com.nanoclaw${NC}"
echo -e "  Logs:    ${BLUE}tail -f $NANOCLAW_INSTALL_DIR/logs/nanoclaw.log${NC}"
echo ""
[[ "$LOCAL_TEST" == true ]] && \
  echo -e "  ${YELLOW}Test install location:${NC} $NANOCLAW_INSTALL_DIR"
[[ "$INSTALL_CLAUDE_CODE" == true ]] && \
  echo -e "  ${CYAN}Claude Code:${NC}  ${BLUE}cd $NANOCLAW_INSTALL_DIR && claude${NC}"
echo ""
echo -e "  ${BOLD}${GREEN}Anan, Maria, and Nadia are ready to help!${NC}"
echo ""
