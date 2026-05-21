.PHONY: build build-omp install install-hooks build-plugin test test-go test-plugin lint lint-go lint-plugin clean

BINARY := omr
COMPAT_BINARY := omp
INSTALL_DIR := $(HOME)/.local/bin
HOOKS_DIR := .git/hooks
HOOK_TEMPLATE_DIR := .githooks
PRE_PUSH_HOOK := $(HOOK_TEMPLATE_DIR)/pre-push

build:
	go build -o $(BINARY) ./cmd/omr/

build-omp:
	go build -o $(COMPAT_BINARY) ./cmd/omp/

install: build
	mkdir -p $(INSTALL_DIR)
	cp $(BINARY) $(INSTALL_DIR)/$(BINARY)
	@echo "Installed $(BINARY) to $(INSTALL_DIR)/$(BINARY)"
	@echo "(To enable the optional pre-push rebuild+test hook, run: make install-hooks)"

install-hooks:
	mkdir -p $(HOOKS_DIR)
	install -m 0755 $(PRE_PUSH_HOOK) $(HOOKS_DIR)/pre-push
	@echo "Installed git hook to $(HOOKS_DIR)/pre-push"

build-plugin:
	cd plugin && bun install --frozen-lockfile && bun run typecheck

test-go:
	go test ./... -count=1

test-plugin:
	cd plugin && bun test

test: test-go test-plugin

lint-go:
	go vet ./...
	./schema-contract-check.sh

lint-plugin:
	cd plugin && bun run typecheck

lint: lint-go lint-plugin

clean:
	rm -f $(BINARY) $(COMPAT_BINARY)
	rm -rf plugin/node_modules plugin/dist
