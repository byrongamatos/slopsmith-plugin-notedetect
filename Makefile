# slopsmith-plugin-notedetect — dev workflow
#
# Point SLOPSMITH_DIR at your slopsmith checkout (default: ../slopsmith).
# `make dev` brings up slopsmith with this plugin mounted via a compose overlay;
# edits to screen.js are live on the next page load.

SLOPSMITH_DIR  ?= $(abspath ../slopsmith)
SLOPSMITH_PORT ?= 8000
PLUGIN_DIR     := $(abspath .)
OVERLAY        := $(PLUGIN_DIR)/docker-compose.slopsmith.yml
# PLUGIN_DIR is exported so the overlay's ${PLUGIN_DIR} resolves to this repo.
# Compose resolves relative volume paths from the first -f file's dir, not
# the overlay's, which is why an absolute path is required.
export PLUGIN_DIR
export SLOPSMITH_PORT
COMPOSE        := docker compose -f $(SLOPSMITH_DIR)/docker-compose.yml -f $(OVERLAY)

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "Vars:"
	@echo "  SLOPSMITH_DIR=$(SLOPSMITH_DIR)"
	@echo "  SLOPSMITH_PORT=$(SLOPSMITH_PORT)   (override if 8000 is taken)"
	@echo "  PLUGIN_DIR=$(PLUGIN_DIR)"

.PHONY: check-slopsmith
check-slopsmith:
	@test -f $(SLOPSMITH_DIR)/docker-compose.yml || { \
	    echo "error: $(SLOPSMITH_DIR)/docker-compose.yml not found"; \
	    echo "       set SLOPSMITH_DIR=/path/to/slopsmith"; \
	    exit 1; }

.PHONY: test
test: ## Run the plugin's node:test suite (no deps)
	npm test

.PHONY: dev
dev: check-slopsmith ## Start slopsmith with this plugin mounted (http://localhost:$(SLOPSMITH_PORT))
	$(COMPOSE) up -d
	@echo
	@echo "Slopsmith running at http://localhost:$(SLOPSMITH_PORT)"
	@echo "Edit screen.js here; reload the browser to see changes."
	@echo "Tail logs: make logs"

.PHONY: logs
logs: check-slopsmith ## Tail slopsmith container logs (Ctrl-C to exit)
	$(COMPOSE) logs -f web

.PHONY: restart
restart: check-slopsmith ## Restart slopsmith (picks up plugin.json / routes.py changes)
	$(COMPOSE) restart web

.PHONY: down
down: check-slopsmith ## Stop slopsmith
	$(COMPOSE) down

.PHONY: ps
ps: check-slopsmith ## Show slopsmith container status
	$(COMPOSE) ps

.PHONY: shell
shell: check-slopsmith ## Open a shell in the running slopsmith container
	$(COMPOSE) exec web bash

.PHONY: verify-mount
verify-mount: check-slopsmith ## Confirm the plugin is visible inside the container
	@$(COMPOSE) exec web ls -la /opt/user-plugins/note_detect 2>&1 | head -10 \
	    || echo "container not running — try 'make dev' first"
