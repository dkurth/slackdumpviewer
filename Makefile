# slackdumpviewer build
#   make build     frontend + binary (./slackdumpviewer)
#   make test      Go tests
#   make e2e       headless browser tests (needs a built binary)
#   make release   cross-compiled binaries in dist/

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build web go test e2e release clean

build: web go

web:
	cd web && npm ci --no-audit --no-fund && npm run build

go:
	go build -ldflags "$(LDFLAGS)" -o slackdumpviewer$(if $(filter windows,$(GOOS)),.exe,) ./cmd/slackdumpviewer

test:
	go vet ./...
	go test ./...
	cd web && npx tsc --noEmit

e2e: go
	cd web && npx playwright test

release: web
	mkdir -p dist
	GOOS=darwin  GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o dist/slackdumpviewer-darwin-arm64 ./cmd/slackdumpviewer
	GOOS=darwin  GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o dist/slackdumpviewer-darwin-amd64 ./cmd/slackdumpviewer
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o dist/slackdumpviewer-windows-amd64.exe ./cmd/slackdumpviewer
	GOOS=windows GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o dist/slackdumpviewer-windows-arm64.exe ./cmd/slackdumpviewer

clean:
	rm -rf dist slackdumpviewer slackdumpviewer.exe
