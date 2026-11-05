class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.13.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.13.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "d224ba2403d6c9e70c99dc2168a218b4215eb990eea489638388678638207e83"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.13.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "f9c1f4be9e749dd81f468ccc833b9bc6d2535644634c0a10355f0f55181a9142"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.13.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "9833668ca1cf4afcf5350a1bc0bd53a289d8a5c969b154b75d148cd7fdef7090"
  end

  def install
    bin.install "fleet-agent"
  end

  def caveats
    <<~EOS
      Enroll the Agent, then install and start its background service:

        fleet-agent enroll --link
        fleet-agent service install

      The service runs its own copy of fleet-agent. After `brew upgrade
      fleet-agent`, run `fleet-agent service install` again to switch it to
      the new version. If an older release runs as a Homebrew service,
      `fleet-agent service install` stops it and replaces it.
    EOS
  end

  test do
    assert_match "fleet-agent 0.13.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
