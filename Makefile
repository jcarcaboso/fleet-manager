.PHONY: restore format check test security docs-check

restore:
	dotnet restore --locked-mode Fleet.slnx
	cargo fetch --locked --manifest-path clients/Cargo.toml

format:
	dotnet format Fleet.slnx --no-restore --verify-no-changes
	cargo fmt --manifest-path clients/Cargo.toml --all -- --check

check:
	dotnet build Fleet.slnx --no-restore --configuration Release
	cargo clippy --manifest-path clients/Cargo.toml --workspace --all-targets --locked -- -D warnings

test:
	dotnet test Fleet.slnx --no-restore --configuration Release
	cargo test --manifest-path clients/Cargo.toml --workspace --locked

security:
	dotnet restore --locked-mode Fleet.slnx
	cargo audit --file clients/Cargo.lock

docs-check:
	python3 scripts/check-doc-links.py
