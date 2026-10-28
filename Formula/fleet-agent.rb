class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.11.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.11.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "12d8f07052e2ee789eaef50cbf2c767f302b6b40eefa10101c22a6f48eb6881b"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.11.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "3d65734f43ab84559d8250e7d85792774ab0ac9b1aacf032488a338ced2a428d"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.11.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "947c4cdd66862b4847d76c5c976a606a2652512e31fb0b148734058737bdb375"
  end

  def install
    bin.install "fleet-agent"
  end

  service do
    run [opt_bin/"fleet-agent", "run"]
    keep_alive true
    restart_delay 15
    log_path var/"log/fleet-agent.log"
    error_log_path var/"log/fleet-agent.log"
  end

  def caveats
    <<~EOS
      Enroll the Agent before starting its Homebrew service. Then run:

        brew services start fleet-agent

      Manage this service with `brew services`, not `fleet-agent service`, and
      do not run both at the same time. Its log is
      #{var}/log/fleet-agent.log.
    EOS
  end

  test do
    assert_match "fleet-agent 0.11.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
