class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.5.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.0/fleet-macos-arm64.tar.gz"
      sha256 "6b9b2ac75b86d622d9d619f858b96719ea2317f9875119afd2111be439a294cc"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.0/fleet-macos-amd64.tar.gz"
      sha256 "6591953ed9259786a0688e7f46ae81b81b9806a7adb84797119e049a9e441793"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.0/fleet-linux-amd64.tar.gz"
    sha256 "104a8608ab4fffc2fe63b1c4d4c3e1de966d71fd7e683a4f929d02e4d098e3b1"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.5.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
