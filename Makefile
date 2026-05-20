.PHONY: build install install-hooks clean

BINARY := omp
INSTALL_DIR := $(HOME)/.local/bin
HOOKS_DIR := .git/hooks
HOOK_TEMPLATE_DIR := .githooks
PRE_PUSH_HOOK := $(HOOK_TEMPLATE_DIR)/pre-push

build:
	go build -o $(BINARY) ./cmd/omp/

install: build
	mkdir -p $(INSTALL_DIR)
	cp $(BINARY) $(INSTALL_DIR)/$(BINARY)
	@echo "Installed $(BINARY) to $(INSTALL_DIR)/$(BINARY)"
	@echo "(To enable the optional pre-push rebuild+test hook, run: make install-hooks)"

install-hooks:
	mkdir -p $(HOOKS_DIR)
	install -m 0755 $(PRE_PUSH_HOOK) $(HOOKS_DIR)/pre-push
	@echo "Installed git hook to $(HOOKS_DIR)/pre-push"

clean:
	rm -f $(BINARY)
