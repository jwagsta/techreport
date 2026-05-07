# Mirror Bacteria Report — full pipeline.
#
# 1) parser/   reads "Final Tech Report.docx", emits data/*.json + data/assets/
# 2) build.py  reads data/, emits site/  (the static website)

.PHONY: all data site serve clean chat-corpus chat-deploy chat-dev

all: site

# Run the parser (docx -> data/)
data:
	$(MAKE) -C parser json

# Build the static website (data/ + site-assets/ -> site/)
site: data
	python3 build.py

# Serve the built site locally on :8765
serve: site
	cd site && python3 -m http.server 8765

# Wipe everything generated
clean:
	$(MAKE) -C parser clean
	rm -rf site

# Regenerate the report corpus the chat-worker bundles.
chat-corpus:
	cd chat-worker && npm install && npm run build:corpus

# Deploy the chat-worker (requires wrangler login + secrets configured).
chat-deploy: chat-corpus
	cd chat-worker && npm run deploy

# Run the chat-worker locally on :8787.
chat-dev: chat-corpus
	cd chat-worker && npm run dev
