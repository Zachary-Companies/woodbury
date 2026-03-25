BINARY_NAME=woodbury-llm-proxy
VERSION=1.0.0

.PHONY: build build-all test clean run

build:
	go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY_NAME) .

build-all: clean
	mkdir -p dist
	GOOS=darwin GOARCH=arm64 go build -ldflags "-X main.version=$(VERSION)" -o dist/$(BINARY_NAME)-darwin-arm64 .
	GOOS=darwin GOARCH=amd64 go build -ldflags "-X main.version=$(VERSION)" -o dist/$(BINARY_NAME)-darwin-amd64 .
	GOOS=linux GOARCH=amd64 go build -ldflags "-X main.version=$(VERSION)" -o dist/$(BINARY_NAME)-linux-amd64 .
	GOOS=windows GOARCH=amd64 go build -ldflags "-X main.version=$(VERSION)" -o dist/$(BINARY_NAME)-windows-amd64.exe .

test:
	go test -v ./...

run: build
	./$(BINARY_NAME)

clean:
	rm -f $(BINARY_NAME)
	rm -rf dist/
