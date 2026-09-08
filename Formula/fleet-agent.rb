class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.4.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.4.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "d33f3c056d280308b9204a3916f537d68d6c7acf0cf1e63d92a2a7738525ef94"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.4.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "19373f49deadf320feb5e13f6eb7bae7b0cc1d8b31f0d7568a3f70aefb18016f"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.4.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "15b68678d37dbb73dee658a3c68a9628df374a0bcf2a2069d960127527b1fe6d"
  end

  def install
    bin.install "fleet-agent"
  end

  service do
    run [opt_bin/"fleet-agent", "run"]
    keep_alive true
    restart_delay 15
  end

  def caveats
    <<~EOS
      Enroll the Agent before starting its Homebrew service. Then run:

        brew services start fleet-agent

      Do not run the Homebrew service and `fleet-agent service` at the same time.
    EOS
  end

  test do
    assert_match "fleet-agent 0.4.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
