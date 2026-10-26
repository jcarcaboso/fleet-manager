.PHONY: restore format check test security docs-check dashboard-image

restore:
	dotnet restore --locked-mode Fleet.slnx
	cargo fetch --locked --manifest-path clients/Cargo.toml
	npm ci --prefix dashboard

format:
	dotnet format Fleet.slnx --no-restore --verify-no-changes
	cargo fmt --manifest-path clients/Cargo.toml --all -- --check

check:
	dotnet build Fleet.slnx --no-restore --configuration Release
	cargo clippy --manifest-path clients/Cargo.toml --workspace --all-targets --locked -- -D warnings
	npm run --prefix dashboard typecheck
	npm run --prefix dashboard build

test:
	dotnet test Fleet.slnx --no-restore --configuration Release
	cargo test --manifest-path clients/Cargo.toml --workspace --locked
	npm test --prefix dashboard

security:
	dotnet restore --locked-mode Fleet.slnx
	cargo audit --file clients/Cargo.lock
	npm audit --prefix dashboard --omit=dev --audit-level=high

docs-check:
	python3 scripts/check-doc-links.py

dashboard-image:
	docker build -f dashboard/Dockerfile -t fleet-manager-dashboard:local .
	scripts/smoke-dashboard-image.sh fleet-manager-dashboard:local
