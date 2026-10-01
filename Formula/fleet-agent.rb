class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.8.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "a8febf9047a3b61121bbbb59d534744fbc2f2d585d56dfd6c891d326e298eea2"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "f4b0942de63ffe940f278d82883f861e91ed87e77819f954d6dc333d6350e61d"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "ac559c0a03ac11a4f535d89b2f3edad0f71e280d72daa09256378770b5a07510"
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
    assert_match "fleet-agent 0.8.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
