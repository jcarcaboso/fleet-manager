class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.15.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "d71f96b2fc5e8e9167128bb514900d96994b64f25559a08b7a96f949a74113a8"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "e6f0dd4f48a2b40a1ba1062c198ec41ba954f38e84ac4176a15d81193320be23"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.0/fleet-agent-linux-arm64.tar.gz"
      sha256 "b49d025e4e1c9ff65ee8d348d66016f6cf62528247a0e7d0631b3b9331dbb27d"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.0/fleet-agent-linux-amd64.tar.gz"
      sha256 "fc79a65cb6516897732d84bf59d90c8033cd638cdd8069002c41838dcc7fa160"
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
    assert_match "fleet-agent 0.15.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
