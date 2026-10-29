class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.12.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.1/fleet-agent-macos-arm64.tar.gz"
      sha256 "79acb1375bc5962971ff7118928309f36beeb908d6b1985036c41da2f659f6f0"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.1/fleet-agent-macos-amd64.tar.gz"
      sha256 "10cd3e4c6f2dc25c76ccd773fc1436a01223aee3aa32b48e77e0368a4295444e"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.1/fleet-agent-linux-amd64.tar.gz"
    sha256 "f84f1b6a5d5f67247dd5503492f0d8b9ae7a13ea3a396ee1c90430df61f7280e"
  end

  def install
    bin.install "fleet-agent"
  end

  def caveats
    <<~EOS
      Enroll the Agent, then install and start its background service:

        fleet-agent enroll --link
        fleet-agent service install

      The service runs its own copy of fleet-agent. After `brew upgrade
      fleet-agent`, run `fleet-agent service install` again to switch it to
      the new version. If an older release runs as a Homebrew service,
      `fleet-agent service install` stops it and replaces it.
    EOS
  end

  test do
    assert_match "fleet-agent 0.12.1", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
