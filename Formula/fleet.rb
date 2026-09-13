class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.5.2"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.2/fleet-macos-arm64.tar.gz"
      sha256 "889d380102371ab62eab6022b6748f39c1b41e8536a16a4d2a18dbde6437e8f4"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.2/fleet-macos-amd64.tar.gz"
      sha256 "9ff21bea65e84214e1df5670ee7e50a0201c3a0f37153321fd66531c60ec97a6"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.2/fleet-linux-amd64.tar.gz"
    sha256 "992332bb99ac6670b13960af5c7538985d43b2dd89b12e742e3d13e7ba27eedb"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.5.2", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
