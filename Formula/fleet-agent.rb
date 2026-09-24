class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.5"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.5/fleet-agent-macos-arm64.tar.gz"
      sha256 "69e906aa33201afef2dc065a15d55e878af53bf8b5cb79ba17f3a337a73ebae1"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.5/fleet-agent-macos-amd64.tar.gz"
      sha256 "be0a1a662ff853a754cd724b95adf55f4e0a57d8b6a933026a365985431cd6ea"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.5/fleet-agent-linux-amd64.tar.gz"
    sha256 "d29751022fe71f41b6f360584da0366a471e1b3242c646f51f3768b910be5e5e"
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
    assert_match "fleet-agent 0.6.5", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
