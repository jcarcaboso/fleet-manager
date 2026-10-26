class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.9.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.9.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "009d40dd1382cad3bb18156bb3b6209e37c52b242d5885986c3af395d301e726"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.9.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "6f4f13a21153c12cbb1860721e7b6e45471797005be3d29c64fe819b282788de"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.9.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "5a5589f6b7686b0682afcd7d564a67a9b4601492ebeb0074c60c20ed3a43ec28"
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
    assert_match "fleet-agent 0.9.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
