.PHONY: help dev dev-frontend down build build-linux build-windows build-macos setup install lint lint-fix format check test typecheck clean

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

# Windows-specific: use PowerShell 7 (pwsh) for complex commands
ifeq ($(DETECTED_OS),windows)
    SHELL := pwsh.exe
    .SHELLFLAGS := -NoProfile -Command
    BUN := bun
    # Run the tauri CLI JS entry point directly with bun to avoid needing node on PATH.
    # Path is relative to backend/ since Tauri commands must run from there.
    TAURI := bun ..\frontend\node_modules\@tauri-apps\cli\tauri.js
    MKDIR := New-Item -ItemType Directory -Force -Path
    RM := Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    NULL := $$null
else
    BUN := bun
    # Run the tauri CLI JS entry point directly with bun to avoid the #!/usr/bin/env node shim,
    # since node may not be on PATH (bun replaces it as our JS runtime).
    # Path is relative to backend/ since Tauri commands must run from there.
    TAURI := bun ../frontend/node_modules/@tauri-apps/cli/tauri.js
    MKDIR := mkdir -p
    RM := rm -rf
    NULL := /dev/null
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
	@echo "  dev-frontend       - Start Vite dev server only (rapid UI iteration)"
	@echo "  down               - Stop any running dev server"
	@echo ""
	@echo "Building:"
	@echo "  setup              - Install all dependencies (Rust + Bun)"
	@echo "  install            - Alias for setup"
	@echo "  build              - Build for current platform (detects OS)"
	@echo "  build-linux        - Build Linux installers (.deb, .rpm, AppImage)"
	@echo "  build-windows      - Build Windows installers (.msi, .exe)"
	@echo "  build-macos        - Build macOS installers (.dmg, .app)"
	@echo "  check              - Run Rust compiler checks without building"
	@echo ""
	@echo "Quality:"
	@echo "  lint               - Run Biome linter and Rust clippy"
	@echo "  lint-fix           - Run Biome linter with auto-fix"
	@echo "  format             - Format code with Biome and rustfmt"
	@echo "  typecheck          - Run TypeScript type checking"
	@echo "  test               - Run Rust tests"
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
	cd backend; $(TAURI) dev

dev-frontend:
	@echo "Starting Vite dev server only (rapid UI iteration)..."
	cd frontend; $(BUN) run dev

down:
	@echo "Stopping dev server..."
	@echo "On Windows, close the terminal running the dev server or use Task Manager."
else
dev:
	@echo "Starting Tauri development server (frontend + Rust)..."
	@# Kill any leftover Vite dev server on port 5173 (prevents cross-project conflicts)
	@EXISTING_PID=$$(lsof -ti :5173 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "  -> Killing existing process on port 5173 (pid $$EXISTING_PID)..."; \
		kill $$EXISTING_PID 2>/dev/null || true; \
		sleep 1; \
	fi
	@echo "  -> Starting Vite dev server in background..."
	@cd frontend && $(BUN) run dev > $(NULL) 2>&1 & echo $$! > .vite.pid
	@sleep 2
	@echo "  -> Starting Tauri..."
	@cd backend && $(TAURI) dev; \
	VITE_PID=$$(cat ../.vite.pid 2>/dev/null); \
	if [ -n "$$VITE_PID" ]; then \
		kill $$VITE_PID 2>/dev/null || true; \
	fi; \
	rm -f ../.vite.pid

down:
	@echo "Stopping Lily dev server..."
	@VITE_PID=$$(cat .vite.pid 2>/dev/null); \
	if [ -n "$$VITE_PID" ]; then \
		kill $$VITE_PID 2>/dev/null || true; \
		rm -f .vite.pid; \
		echo "  -> Killed Vite dev server (pid $$VITE_PID)"; \
	else \
		echo "  -> No .vite.pid found, checking port 5173..."; \
		PORT_PID=$$(lsof -ti :5173 2>/dev/null); \
		if [ -n "$$PORT_PID" ]; then \
			kill $$PORT_PID 2>/dev/null || true; \
			echo "  -> Killed process on port 5173 (pid $$PORT_PID)"; \
		else \
			echo "  -> No dev server running"; \
		fi; \
	fi

dev-frontend:
	@echo "Starting Vite dev server only (rapid UI iteration)..."
	@cd frontend && $(BUN) run dev
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
	cd frontend; $(BUN) install
	@echo "Setup complete"

install: setup

else
setup:
	@echo "Installing all dependencies (Rust + Bun)..."
	@cd frontend && $(BUN) install
	@echo "Setup complete"

install: setup

endif

ifeq ($(DETECTED_OS),windows)
build:
	@echo "Building Windows installers (.msi, .exe)..."
	@echo "  -> Building frontend..."
	cd frontend; $(BUN) run build
	@echo "  -> Building Tauri app for Windows..."
	$$env:PATH = "$$env:USERPROFILE\.cargo\bin;$$env:PATH"; cd backend; $(TAURI) build
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
	cd frontend; $(BUN) run build
	@echo "  -> Building Tauri app for Windows..."
	$$env:PATH = "$$env:USERPROFILE\.cargo\bin;$$env:PATH"; cd backend; $(TAURI) build
	@echo ""
	@echo "Windows build complete!"
	@echo ""
	@echo "Build outputs in ./target/release/bundle/:"
	@echo "  - MSI Installer:  ./target/release/bundle/msi/"
	@echo "  - NSIS Installer: ./target/release/bundle/nsis/"

build-macos:
	@echo "ERROR: macOS builds must be run on macOS"
	@exit 1
else
build-linux:
	@echo "Building Linux installers (.deb, .rpm, AppImage)..."
	@echo "  -> Building frontend..."
	@cd frontend && $(BUN) run build
	@echo "  -> Building Tauri app for Linux..."
	@cd backend && $(TAURI) build
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
	@echo "  -> Building frontend..."
	@cd frontend && $(BUN) run build
	@echo "  -> Building Tauri app for macOS..."
	@cd backend && $(TAURI) build
	@echo ""
	@echo "macOS build complete!"
	@echo ""
	@echo "Build outputs in ./target/release/bundle/:"
	@echo "  - DMG:  ./target/release/bundle/dmg/"
	@echo "  - App:  ./target/release/bundle/macos/"
endif

ifeq ($(DETECTED_OS),windows)
check:
	@echo "Running Rust compiler checks..."
	cd backend; cargo check
	@echo "Rust checks passed"
else
check:
	@echo "Running Rust compiler checks..."
	@cd backend && cargo check
	@echo "Rust checks passed"
endif

# -------------
# Quality
# -------------

ifeq ($(DETECTED_OS),windows)
lint:
	@echo "Linting frontend code..."
	cd frontend; $(BUN)x biome check .
	@echo "Linting Rust code..."
	cd backend; cargo clippy -- -D warnings
	@echo "Lint complete"

lint-fix:
	@echo "Fixing frontend lint issues..."
	cd frontend; $(BUN)x biome check --write .
	@echo "Lint fix complete"

format:
	@echo "Formatting frontend code..."
	cd frontend; $(BUN)x biome format --write .
	@echo "Formatting Rust code..."
	cd backend; cargo fmt
	@echo "Format complete"

typecheck:
	@echo "Running TypeScript type checking..."
	cd frontend; $(BUN) run typecheck
	@echo "Type check passed"

test:
	@echo "Running Rust tests..."
	cd backend; cargo test
	@echo "Tests complete"
else
lint:
	@echo "Linting frontend code..."
	@cd frontend && $(BUN)x biome check .
	@echo "Linting Rust code..."
	@cd backend && cargo clippy -- -D warnings
	@echo "Lint complete"

lint-fix:
	@echo "Fixing frontend lint issues..."
	@cd frontend && $(BUN)x biome check --write .
	@echo "Lint fix complete"

format:
	@echo "Formatting frontend code..."
	@cd frontend && $(BUN)x biome format --write .
	@echo "Formatting Rust code..."
	@cd backend && cargo fmt
	@echo "Format complete"

typecheck:
	@echo "Running TypeScript type checking..."
	@cd frontend && $(BUN) run typecheck
	@echo "Type check passed"

test:
	@echo "Running Rust tests..."
	@cd backend && cargo test
	@echo "Tests complete"
endif

# -------------
# Maintenance
# -------------

ifeq ($(DETECTED_OS),windows)
clean:
	@echo "Cleaning build artifacts..."
	if (Test-Path frontend\node_modules) { Remove-Item -Recurse -Force frontend\node_modules }
	if (Test-Path frontend\dist) { Remove-Item -Recurse -Force frontend\dist }
	if (Test-Path target) { Remove-Item -Recurse -Force target }
	@echo "Cleanup complete"
else
clean:
	@echo "Cleaning build artifacts..."
	@$(RM) frontend/node_modules
	@$(RM) frontend/dist
	@$(RM) target
	@echo "Cleanup complete"
endif

.DEFAULT_GOAL := help
