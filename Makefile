.PHONY: help dev dev-frontend down build build-linux build-windows build-macos notarize setup install lint lint-fix format check test typecheck clean version

# ==================================================================
# OS DETECTION
# ==================================================================
# Detect OS for platform-specific commands
# On Windows, uname doesn't exist, so we check for Windows-specific env vars first
ifdef OS
    # Windows sets OS=Windows_NT
    ifeq ($(OS),Windows_NT)
        UNAME_S := Windows
    else
        UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
    endif
else
    UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
endif
ifneq (,$(findstring MINGW,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring MSYS,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring CYGWIN,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring Windows,$(UNAME_S)))
    DETECTED_OS := windows
else ifeq ($(UNAME_S),Linux)
    DETECTED_OS := linux
else ifeq ($(UNAME_S),Darwin)
    DETECTED_OS := macos
else
    DETECTED_OS := windows
endif

# ==================================================================
# PATHS
# ==================================================================
# Apps live under apps/<name>/ per the portfolio structure. Lily is a
# single-deployment Tauri desktop app, so one app dir: apps/desktop/.
BACKEND := apps/desktop/backend
FRONTEND := apps/desktop/frontend

# Windows-specific: use PowerShell 7 (pwsh) for complex commands
ifeq ($(DETECTED_OS),windows)
    SHELL := pwsh.exe
    .SHELLFLAGS := -NoProfile -Command
    BUN := bun
    # Run the tauri CLI JS entry point directly with bun to avoid needing node on PATH.
    # Path is relative to $(BACKEND) — backend and frontend are siblings under
    # apps/desktop/, so ..\frontend\node_modules\... resolves correctly.
    TAURI := bun ..\frontend\node_modules\@tauri-apps\cli\tauri.js
    MKDIR := New-Item -ItemType Directory -Force -Path
    RM := Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    NULL := $$null
else
    BUN := bun
    # Run the tauri CLI JS entry point directly with bun to avoid the #!/usr/bin/env node shim,
    # since node may not be on PATH (bun replaces it as our JS runtime).
    # Path is relative to $(BACKEND) — backend and frontend are siblings under
    # apps/desktop/, so ../frontend/node_modules/... resolves correctly.
    TAURI := bun ../frontend/node_modules/@tauri-apps/cli/tauri.js
    MKDIR := mkdir -p
    RM := rm -rf
    NULL := /dev/null
    ifeq ($(DETECTED_OS),macos)
        SED_INPLACE := sed -i ''
    else
        SED_INPLACE := sed -i
    endif
endif

help:
	@echo "================================================================================"
	@echo "  Lily — Document Drafting Toolset"
	@echo "================================================================================"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Running (Development):"
	@echo "  dev                - Start Tauri dev server (frontend + Rust hot-reload)"
	@echo "  dev-frontend       - Start Bun dev server only (rapid UI iteration)"
	@echo "  down               - Stop any running dev server"
	@echo ""
	@echo "Building:"
	@echo "  setup              - Install all dependencies (Rust + Bun)"
	@echo "  install            - Alias for setup"
	@echo "  build              - Build for current platform (detects OS)"
	@echo "  build-linux        - Build Linux installers (.deb, .rpm, AppImage)"
	@echo "  build-windows      - Build Windows installers (.msi, .exe)"
	@echo "  build-macos        - Build macOS installers (.dmg, .app)"
	@echo "  notarize     - Submit macOS build for Apple notarization"
	@echo "  check              - Run Rust compiler checks without building"
	@echo ""
	@echo "Quality:"
	@echo "  lint               - Run Biome linter and Rust clippy"
	@echo "  lint-fix           - Run Biome linter with auto-fix"
	@echo "  format             - Format code with Biome and rustfmt"
	@echo "  typecheck          - Run TypeScript type checking"
	@echo "  test               - Run Rust tests"
	@echo ""
	@echo "Versioning:"
	@echo "  version            - Show current version"
	@echo "  version V=X.Y.Z   - Set version across all config files"
	@echo ""
	@echo "Maintenance:"
	@echo "  clean              - Remove build artifacts and dependencies"
	@echo ""
	@echo "Detected OS: $(DETECTED_OS)"
	@echo "================================================================================"

# ==================================================================
# SERVICE COMMANDS
# ==================================================================

# -------------
# Running
# -------------

ifeq ($(DETECTED_OS),windows)
dev:
	@echo "Starting Tauri development server (frontend + Rust)..."
	cd $(BACKEND); $(TAURI) dev

dev-frontend:
	@echo "Starting Bun dev server only (rapid UI iteration)..."
	cd $(FRONTEND); $(BUN) run dev

down:
	@echo "Stopping dev server..."
	@echo "On Windows, close the terminal running the dev server or use Task Manager."
else
dev:
	@echo "Starting Tauri development server (frontend + Rust)..."
	@# Warn about and kill any leftover dev server on port 5173
	@EXISTING_PID=$$(lsof -ti :5173 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "  -> WARNING: Port 5173 in use (pid $$EXISTING_PID) — killing to free port"; \
		kill $$EXISTING_PID 2>/dev/null || true; \
		sleep 1; \
	fi
	@echo "  -> Starting Tauri (frontend dev server started by Tauri via beforeDevCommand)..."
	@cd $(BACKEND) && $(TAURI) dev

down:
	@echo "Stopping Lily dev server..."
	@echo "  -> Checking port 5173..."
	@PORT_PID=$$(lsof -ti :5173 2>/dev/null); \
	if [ -n "$$PORT_PID" ]; then \
		kill $$PORT_PID 2>/dev/null || true; \
		echo "  -> Killed process on port 5173 (pid $$PORT_PID)"; \
	else \
		echo "  -> No dev server running"; \
	fi

dev-frontend:
	@echo "Starting Bun dev server only (rapid UI iteration)..."
	@cd $(FRONTEND) && $(BUN) run dev
endif

# ==================================================================
# COMMAND MODULES
# ==================================================================

# -------------
# Building
# -------------

ifeq ($(DETECTED_OS),windows)
setup:
	@echo "Installing all dependencies (Rust + Bun)..."
	@echo "Please ensure Rust and Bun are installed."
	$(BUN) install
	@echo "Setup complete"

install: setup

else
setup:
	@echo "Installing all dependencies (Rust + Bun)..."
	@$(BUN) install
	@echo "Setup complete"

install: setup

endif

ifeq ($(DETECTED_OS),windows)
build:
	@echo "Building Windows installers (.msi, .exe)..."
	@echo "  -> Building frontend..."
	cd $(FRONTEND); $(BUN) run build
	@echo "  -> Building Tauri app for Windows..."
	$$env:PATH = "$$env:USERPROFILE\.cargo\bin;$$env:PATH"; cd $(BACKEND); $(TAURI) build
	@echo ""
	@echo "Windows build complete!"
	@echo ""
	@echo "Build outputs in ./target/release/bundle/:"
	@echo "  - MSI Installer:  ./target/release/bundle/msi/"
	@echo "  - NSIS Installer: ./target/release/bundle/nsis/"
else
build:
ifeq ($(DETECTED_OS),linux)
	@$(MAKE) build-linux
else ifeq ($(DETECTED_OS),macos)
	@$(MAKE) build-macos
endif
endif

ifeq ($(DETECTED_OS),windows)
build-linux:
	@echo "ERROR: Linux builds must be run on Linux"
	@exit 1

build-windows:
	@echo "Building Windows installers (.msi, .exe)..."
	@echo "  -> Building frontend..."
	cd $(FRONTEND); $(BUN) run build
	@echo "  -> Building Tauri app for Windows..."
	$$env:PATH = "$$env:USERPROFILE\.cargo\bin;$$env:PATH"; cd $(BACKEND); $(TAURI) build
	@echo ""
	@echo "Windows build complete!"
	@echo ""
	@echo "Build outputs in ./target/release/bundle/:"
	@echo "  - MSI Installer:  ./target/release/bundle/msi/"
	@echo "  - NSIS Installer: ./target/release/bundle/nsis/"

build-macos:
	@echo "ERROR: macOS builds must be run on macOS"
	@exit 1

notarize:
	@echo "ERROR: macOS notarization must be run on macOS"
	@exit 1
else
build-linux:
	@echo "Building Linux installers (.deb, .rpm, AppImage)..."
	@echo "  -> Building frontend..."
	@cd $(FRONTEND) && $(BUN) run build
	@echo "  -> Building Tauri app for Linux..."
	@cd $(BACKEND) && $(TAURI) build
	@echo ""
	@echo "Linux build complete!"
	@echo ""
	@echo "Build outputs in ./target/release/bundle/:"
	@echo "  - AppImage: ./target/release/bundle/appimage/"
	@echo "  - Debian:   ./target/release/bundle/deb/"
	@echo "  - RPM:      ./target/release/bundle/rpm/"

build-windows:
	@echo "ERROR: Windows builds must be run on Windows"
	@exit 1

build-macos:
	@echo "Building macOS installers (.dmg, .app)..."
	@if [ -f .env ]; then \
		echo "  -> Loading signing config from .env"; \
	else \
		echo "  -> WARNING: No .env file found — build will not be signed"; \
		echo "     Copy .env.example to .env and fill in your Apple credentials"; \
	fi
	@echo "  -> Building frontend..."
	@cd $(FRONTEND) && $(BUN) run build
	@echo "  -> Building Tauri app for macOS..."
	@if [ -f .env ]; then \
		. ./.env && \
		( unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID && cd $(BACKEND) && $(TAURI) build ); \
	else \
		cd $(BACKEND) && $(TAURI) build; \
	fi
	@if [ -f .env ]; then \
		. ./.env && \
		echo "" && \
		echo "Re-signing with hardened runtime and secure timestamp..." && \
		echo "  (Tauri's bundler omits --timestamp; re-signing to fix)" && \
		codesign --force --options runtime --timestamp \
			--entitlements $(BACKEND)/entitlements.plist \
			--sign "$$APPLE_SIGNING_IDENTITY" \
			./target/release/bundle/macos/Lily.app/Contents/MacOS/lily && \
		codesign --force --options runtime --timestamp \
			--entitlements $(BACKEND)/entitlements.plist \
			--sign "$$APPLE_SIGNING_IDENTITY" \
			./target/release/bundle/macos/Lily.app && \
		echo "  -> Re-signed .app bundle" && \
		echo "" && \
		echo "Rebuilding DMG from re-signed .app..." && \
		VERSION=$$(grep '^version = ' $(BACKEND)/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/') && \
		ARCH=$$(uname -m | sed 's/arm64/aarch64/') && \
		DMG_NAME="Lily_$${VERSION}_$${ARCH}.dmg" && \
		DMG_PATH="./target/release/bundle/dmg/$${DMG_NAME}" && \
		rm -f "$${DMG_PATH}" && \
		hdiutil create -volname "Lily" \
			-srcfolder ./target/release/bundle/macos/Lily.app \
			-ov -format UDZO \
			"$${DMG_PATH}" && \
		codesign --force --timestamp \
			--sign "$$APPLE_SIGNING_IDENTITY" \
			"$${DMG_PATH}" && \
		echo "  -> DMG rebuilt and signed: $${DMG_PATH}" && \
		echo "" && \
		echo "Verifying code signature..." && \
		codesign --verify --deep --strict ./target/release/bundle/macos/Lily.app && \
		echo "  -> Code signature: OK"; \
	fi
	@echo ""
	@echo "macOS build complete!"
	@echo ""
	@echo "Build outputs in ./target/release/bundle/:"
	@echo "  - DMG:  ./target/release/bundle/dmg/"
	@echo "  - App:  ./target/release/bundle/macos/"
	@if [ -f .env ]; then \
		echo "" && \
		echo "To notarize, run: make notarize"; \
	fi

notarize:
	@if [ ! -f .env ]; then \
		echo "ERROR: .env file required for notarization"; \
		echo "  Copy .env.example to .env and fill in your Apple credentials"; \
		exit 1; \
	fi
	@. ./.env && \
	VERSION=$$(grep '^version = ' $(BACKEND)/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/') && \
	ARCH=$$(uname -m | sed 's/arm64/aarch64/') && \
	DMG_NAME="Lily_$${VERSION}_$${ARCH}.dmg" && \
	DMG_PATH="./target/release/bundle/dmg/$${DMG_NAME}" && \
	if [ ! -f "$${DMG_PATH}" ]; then \
		echo "ERROR: DMG not found at $${DMG_PATH}"; \
		echo "  Run 'make build-macos' first"; \
		exit 1; \
	fi && \
	echo "Submitting $${DMG_NAME} for notarization..." && \
	xcrun notarytool submit "$${DMG_PATH}" \
		--apple-id "$$APPLE_ID" \
		--password "$$APPLE_PASSWORD" \
		--team-id "$$APPLE_TEAM_ID" \
		--wait && \
	echo "" && \
	echo "Stapling notarization ticket..." && \
	xcrun stapler staple "$${DMG_PATH}" && \
	echo "  -> Notarization complete: $${DMG_PATH}" && \
	echo "" && \
	echo "Verifying Gatekeeper assessment..." && \
	spctl --assess --type open --context context:primary-signature "$${DMG_PATH}" 2>&1 && \
	echo "  -> Gatekeeper: OK"
endif

ifeq ($(DETECTED_OS),windows)
check:
	@echo "Running Rust compiler checks..."
	cd $(BACKEND); cargo check
	@echo "Rust checks passed"
else
check:
	@echo "Running Rust compiler checks..."
	@cd $(BACKEND) && cargo check
	@echo "Rust checks passed"
endif

# -------------
# Quality
# -------------

ifeq ($(DETECTED_OS),windows)
lint:
	@echo "Linting frontend code..."
	$(BUN)x biome check .
	@echo "Linting Rust code..."
	cd $(BACKEND); cargo clippy -- -D warnings
	@echo "Lint complete"

lint-fix:
	@echo "Fixing frontend lint issues..."
	$(BUN)x biome check --write .
	@echo "Lint fix complete"

format:
	@echo "Formatting frontend code..."
	$(BUN)x biome format --write .
	@echo "Formatting Rust code..."
	cd $(BACKEND); cargo fmt
	@echo "Format complete"

typecheck:
	@echo "Running TypeScript type checking..."
	cd $(FRONTEND); $(BUN) run typecheck
	@echo "Type check passed"

test:
	@echo "Running frontend tests..."
	cd $(FRONTEND); $(BUN) test
	@echo "Running Rust tests..."
	cd $(BACKEND); cargo test
	@echo "Tests complete"
else
lint:
	@echo "Linting frontend code..."
	@$(BUN)x biome check .
	@echo "Linting Rust code..."
	@cd $(BACKEND) && cargo clippy -- -D warnings
	@echo "Lint complete"

lint-fix:
	@echo "Fixing frontend lint issues..."
	@$(BUN)x biome check --write .
	@echo "Lint fix complete"

format:
	@echo "Formatting frontend code..."
	@$(BUN)x biome format --write .
	@echo "Formatting Rust code..."
	@cd $(BACKEND) && cargo fmt
	@echo "Format complete"

typecheck:
	@echo "Running TypeScript type checking..."
	@cd $(FRONTEND) && $(BUN) run typecheck
	@echo "Type check passed"

test:
	@echo "Running frontend tests..."
	@cd $(FRONTEND) && $(BUN) test
	@echo "Running Rust tests..."
	@cd $(BACKEND) && cargo test
	@echo "Tests complete"
endif

# -------------
# Versioning
# -------------

ifeq ($(DETECTED_OS),windows)
version:
ifndef V
	@echo "Current version:"
	@cd $(BACKEND); (Select-String -Path Cargo.toml -Pattern '^version = "(.+)"').Matches.Groups[1].Value
else
	@echo "Updating version to $(V)..."
	@(Get-Content $(BACKEND)\Cargo.toml -Raw) -replace '(?m)^version = ".*"', 'version = "$(V)"' | Set-Content $(BACKEND)\Cargo.toml -NoNewline
	@(Get-Content $(BACKEND)\tauri.conf.json -Raw) -replace '"version": ".*"', '"version": "$(V)"' | Set-Content $(BACKEND)\tauri.conf.json -NoNewline
	@(Get-Content $(FRONTEND)\package.json -Raw) -replace '"version": ".*"', '"version": "$(V)"' | Set-Content $(FRONTEND)\package.json -NoNewline
	@(Get-Content package.json -Raw) -replace '"version": ".*"', '"version": "$(V)"' | Set-Content package.json -NoNewline
	@echo "  -> $(BACKEND)/Cargo.toml"
	@echo "  -> $(BACKEND)/tauri.conf.json"
	@echo "  -> $(FRONTEND)/package.json"
	@echo "  -> package.json"
	@echo ""
	@echo "Version updated to $(V)"
endif
else
version:
ifndef V
	@echo "Current version: $$(grep '^version = ' $(BACKEND)/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/')"
else
	@echo "Updating version to $(V)..."
	@$(SED_INPLACE) 's/^version = ".*"/version = "$(V)"/' $(BACKEND)/Cargo.toml
	@$(SED_INPLACE) 's/"version": ".*"/"version": "$(V)"/' $(BACKEND)/tauri.conf.json
	@$(SED_INPLACE) 's/"version": ".*"/"version": "$(V)"/' $(FRONTEND)/package.json
	@$(SED_INPLACE) 's/"version": ".*"/"version": "$(V)"/' package.json
	@echo "  -> $(BACKEND)/Cargo.toml"
	@echo "  -> $(BACKEND)/tauri.conf.json"
	@echo "  -> $(FRONTEND)/package.json"
	@echo "  -> package.json"
	@echo ""
	@echo "Version updated to $(V)"
endif
endif

# -------------
# Maintenance
# -------------

ifeq ($(DETECTED_OS),windows)
clean:
	@echo "Cleaning build artifacts..."
	if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }
	if (Test-Path $(FRONTEND)\dist) { Remove-Item -Recurse -Force $(FRONTEND)\dist }
	if (Test-Path target) { Remove-Item -Recurse -Force target }
	@echo "Cleanup complete"
else
clean:
	@echo "Cleaning build artifacts..."
	@$(RM) node_modules
	@$(RM) $(FRONTEND)/dist
	@$(RM) target
	@echo "Cleanup complete"
endif

.DEFAULT_GOAL := help
