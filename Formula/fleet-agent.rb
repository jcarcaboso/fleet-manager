class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.15.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.1/fleet-agent-macos-arm64.tar.gz"
      sha256 "f6222647e55acbc97c83a0a32304770f01f40e1beff9592b97358269e51c7b8c"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.1/fleet-agent-macos-amd64.tar.gz"
      sha256 "b7e6ea7b8ba219fcf98d67b6b4a751c1642c6d666e0fe372103b323a34411ec2"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.1/fleet-agent-linux-arm64.tar.gz"
      sha256 "0f56d21bea0e12db967822affa9a2769ed528c6739cfaffa0f1ed8926e92c343"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.1/fleet-agent-linux-amd64.tar.gz"
      sha256 "9a03bed2f8e769e05c58d6cda60732985549448a9a30d35d89ca0f0e618986e8"
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
    assert_match "fleet-agent 0.15.1", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
