class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.5.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.1/fleet-agent-macos-arm64.tar.gz"
      sha256 "162e66b46d7dffefdfc0dbe5550249c3d1df6ab1e0fc666dbe51244a492e9499"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.1/fleet-agent-macos-amd64.tar.gz"
      sha256 "f2b8c07fe76ecfcd289c939af4dd6f55f018e3a295dfb78d10e745f36338a22d"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.1/fleet-agent-linux-amd64.tar.gz"
    sha256 "5242128e16b6fbd1e58b09dee1c7727c1fcdf9c31c3a76434892e26ddb75a504"
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
    assert_match "fleet-agent 0.5.1", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
