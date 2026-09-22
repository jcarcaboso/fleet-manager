class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.1/fleet-agent-macos-arm64.tar.gz"
      sha256 "f3112b3614753d5b502b53162e994ec91af42ec28bd9c01187c327fcdd0dbb7d"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.1/fleet-agent-macos-amd64.tar.gz"
      sha256 "28566544aaab05dee777d77c5557d98df6212ffa8979d22329300ccb5bb2f2cc"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.1/fleet-agent-linux-amd64.tar.gz"
    sha256 "3d23f0afb6e18136fa3b83961a04211d2709a0482de4c3502a7712b8b31f57b1"
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
    assert_match "fleet-agent 0.6.1", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
