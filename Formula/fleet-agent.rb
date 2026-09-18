class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "b80354b0d0a1f34c3d868e7eb977f25343d1e6acb370baa658f87ecdc4a8b65e"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "b9708d3ea87d687b5783347818bda874fef3e1189ca20ac34435736552b5de1f"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "08a426ae67d69b71a06c101fa8194ebb5e13cfccc2814a26a67c4c3db5fce0cc"
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
    assert_match "fleet-agent 0.6.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
