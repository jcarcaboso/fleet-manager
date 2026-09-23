class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.3"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.3/fleet-agent-macos-arm64.tar.gz"
      sha256 "796100db2887da1410fcbdfe79328a9d869a8e1f722f3737840c15b60bf21a2b"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.3/fleet-agent-macos-amd64.tar.gz"
      sha256 "5d81c8a031ecc484c394940e22dccf39fd9d99788bf9d99f30a71b8b429d2899"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.3/fleet-agent-linux-amd64.tar.gz"
    sha256 "d4c6aa7a39ba3a7d1b3ecb79e53274b02f60d202106deb1b153be2f27a0a4216"
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
    assert_match "fleet-agent 0.6.3", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
