class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.5.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "657f57619526329e5ad9bacb0c4420c96b5753069d0011e725fe2fb37b7df2b9"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "a26b74f1589524b77b581dba3abc24e67c78fca990ea0b50c573e412309027f6"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "e0ae8f5667968c3e222ab45fa96e5dc46eebe8bfd3c9d8af8f8772b1e5121699"
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
    assert_match "fleet-agent 0.5.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
