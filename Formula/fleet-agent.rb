class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.10.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.10.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "abfc9bf4dda891cc65335a8506bb9920a20e1461f1ca34cc4210e52069951a78"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.10.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "fb7eb2dfd597e873d08aaef9d0487f8a0b945bc17ae230e6ce4f4a127d142ce8"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.10.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "d60e7716878c861a4ae526e94d9f1e8ad5e0f4a0b37a5551d00539a2db28c8ab"
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
    assert_match "fleet-agent 0.10.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
