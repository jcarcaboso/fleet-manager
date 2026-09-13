class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.5.2"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.2/fleet-agent-macos-arm64.tar.gz"
      sha256 "19835c7828e9d0746fd32409d44ec416f1c4bb439b4aaff4dbb829f7cafc5de9"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.2/fleet-agent-macos-amd64.tar.gz"
      sha256 "7e2b38a50fcb5e7841fd77cd32fb94c808c4c80355c242ac5a2d73c7a1352162"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.2/fleet-agent-linux-amd64.tar.gz"
    sha256 "6899251b1033f248fac22582cd4cb6d637c4513514c78ad4d3311730bb08dd80"
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
    assert_match "fleet-agent 0.5.2", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
