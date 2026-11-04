class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.12.3"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.3/fleet-agent-macos-arm64.tar.gz"
      sha256 "72ac8b6dbda8387febb59b0684ccc80165bdc3de8b62b5b2df4276764405076c"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.3/fleet-agent-macos-amd64.tar.gz"
      sha256 "cd3115e42c5d097d3ae153a58dc1018a47ba1e8fb7d53d39b1b132ba991d8d92"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.3/fleet-agent-linux-amd64.tar.gz"
    sha256 "ad7959c4c6d40ddaba8f16a90c814a8dbb76af4c5938c69dad9b6ebe8fc15afb"
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
    assert_match "fleet-agent 0.12.3", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
