PORT          ?= 8080
OG_MODULES    := /tmp/og-gen/node_modules

dev:
	@echo "Запуск локального сервера на http://localhost:$(PORT)"
	python3 -m http.server $(PORT)

$(OG_MODULES):
	npm install @resvg/resvg-js --no-save --prefix /tmp/og-gen

og: $(OG_MODULES)
	@echo "Генерация og-image.png и icon-512.png..."
	NODE_PATH=$(OG_MODULES) node scripts/gen-og.js

.PHONY: dev og
