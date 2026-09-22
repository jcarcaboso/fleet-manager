class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.2"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.2/fleet-agent-macos-arm64.tar.gz"
      sha256 "eb0c9342b19502e845fabab11aa9f6cd2a00acab0c5476347354af4b2913a824"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.2/fleet-agent-macos-amd64.tar.gz"
      sha256 "63e5b48498e8c68ac2efdd85ad6fd2edcf774a71f04e4e9f275f950316fffa9e"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.2/fleet-agent-linux-amd64.tar.gz"
    sha256 "a9b1dc8fe7c3c9071f58294861be52d41d14db95f0527081622f9701b4b72867"
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
    assert_match "fleet-agent 0.6.2", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
