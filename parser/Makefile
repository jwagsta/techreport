# Parse "Final Tech Report.docx" into JSON + assets.
# Output goes to ../data/ (the canonical input for build.py).

PYTHON      ?= .venv/bin/python
PIP         ?= .venv/bin/pip
DOCX        ?= ../Final\ Tech\ Report.docx
INTERMED    := intermediates
HTML        := $(INTERMED)/report.html
RAW_MEDIA   := $(INTERMED)/media
DATA_DIR    := ../data

.PHONY: all html json clean venv

all: json

# 1) Set up venv on first run
venv: .venv/bin/python

.venv/bin/python:
	python3 -m venv .venv
	$(PIP) install -r requirements.txt

# 2) docx -> html (via pandoc, with media extracted)
$(HTML): $(DOCX)
	mkdir -p $(INTERMED)
	pandoc $(DOCX) \
		--track-changes=accept \
		--extract-media=$(RAW_MEDIA) \
		-t html -o $(HTML)

html: $(HTML)

# 3) html -> json + assets
json: venv $(HTML)
	$(PYTHON) parse.py

clean:
	rm -rf $(INTERMED)
	rm -rf $(DATA_DIR)
