class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.6"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.6/fleet-agent-macos-arm64.tar.gz"
      sha256 "d3eded1a985df4e9dbf2027d1f3a75c8acd0267d7d1c2ed2dfa73c5cbe598cdd"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.6/fleet-agent-macos-amd64.tar.gz"
      sha256 "66b112fd1ed07d72a4f12daf62eb3d6c70956ca385f567ae053dd98a1d269206"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.6/fleet-agent-linux-amd64.tar.gz"
    sha256 "8c479bb7cbba3ee3be1fdfe331ceb9220070a391246f429d9a6120074bde8e88"
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
    assert_match "fleet-agent 0.6.6", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
