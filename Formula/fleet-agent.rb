class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.15.2"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.2/fleet-agent-macos-arm64.tar.gz"
      sha256 "95c85732281fcf87400412061164ddac5a9924cb026a8abb6364ee6812ff2d36"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.2/fleet-agent-macos-amd64.tar.gz"
      sha256 "df9e42da19768d9235f279d1b63a4998c5605269e03a32c8a4be56c44c16fabd"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.2/fleet-agent-linux-arm64.tar.gz"
      sha256 "e5e6fab9ad90a17dbc1993a3d93a36bc1a89048e94b47dd5f3a74d86819c41f1"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.2/fleet-agent-linux-amd64.tar.gz"
      sha256 "b985dc3d391b6edd5d0008176b0747388abc2548159bd18a87078bbcd82f34b7"
    end
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
    assert_match "fleet-agent 0.15.2", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
