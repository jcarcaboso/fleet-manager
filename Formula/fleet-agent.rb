class FleetAgent < Formula
  desc "Node agent for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.3.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.3.0/fleet-agent-macos-arm64.tar.gz"
      sha256 "dc19a5092192a6c561afda3361fe34247564ccbeed6eee82c90480995891eba2"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.3.0/fleet-agent-macos-amd64.tar.gz"
      sha256 "fba7f021657438f7df273ab156166884a92a3c0f2b50c0768d4151107178b1cc"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.3.0/fleet-agent-linux-amd64.tar.gz"
    sha256 "e1fa249d812382162910454f9149e92ea73cd40cb9765538a5cb1b49eca25a2e"
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
    assert_match "fleet-agent 0.3.0", shell_output("#{bin}/fleet-agent --version")
    system "#{bin}/fleet-agent", "--help"
  end
end
