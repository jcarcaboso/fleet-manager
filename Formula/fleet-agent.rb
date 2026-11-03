class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.12.2"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.2/fleet-agent-macos-arm64.tar.gz"
      sha256 "6128d7310b3b4b96ca0e5f8a3345f82cadcb9831a3e167234c363e29093f51c4"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.2/fleet-agent-macos-amd64.tar.gz"
      sha256 "efadd4214125417d4c77ae382c45d39d7b96bcb752eabc5d758b468097084b7a"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.2/fleet-agent-linux-amd64.tar.gz"
    sha256 "43f0a270f6c6159aecb1838a0b773a8a4c403f2703db68c55b242e4d40e0e97e"
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
    assert_match "fleet-agent 0.12.2", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
