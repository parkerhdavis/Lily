UNAME := $(shell uname -s 2>/dev/null || echo Windows)

.PHONY: dev build install lint typecheck clean

install:
	bun install

dev:
ifeq ($(UNAME),Linux)
	cd backend && cargo tauri dev
else ifeq ($(UNAME),Darwin)
	cd backend && cargo tauri dev
else
	cd backend && cargo tauri dev
endif

build:
	cd backend && cargo tauri build

lint:
	bunx biome check .

lint-fix:
	bunx biome check --write .

typecheck:
	bun run typecheck

clean:
	rm -rf dist node_modules backend/target
