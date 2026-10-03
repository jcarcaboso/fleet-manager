class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.8.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.1/fleet-agent-macos-arm64.tar.gz"
      sha256 "f9a546d62cb443e4a797b12fb0dd770f5d35c411f9a31de874da087533fb9873"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.1/fleet-agent-macos-amd64.tar.gz"
      sha256 "6ce87d4822f71dcc30e6af38670145f450cf599ad783d02aff7b07f519f74573"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.1/fleet-agent-linux-amd64.tar.gz"
    sha256 "e7025607e49ba3e0fd098bb3f3690a625e2f9cb3ac2a02f4c861b66e8172bcd4"
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
    assert_match "fleet-agent 0.8.1", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
