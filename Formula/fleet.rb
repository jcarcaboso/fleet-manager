class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.6"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.6/fleet-macos-arm64.tar.gz"
      sha256 "b7247dc7f7f479650994e2192671ebe06e2a230eef9d75e720add5a0a9981b37"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.6/fleet-macos-amd64.tar.gz"
      sha256 "a58fc1bc50fe0eb37295bfd0138403c53307505b40084d863f63a0594e2e0044"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.6/fleet-linux-amd64.tar.gz"
    sha256 "3be87406ac0bb0de6fdd551ba8ecb19df2a7ee3c1d0cf189f61e39d2dd2d56c0"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.6.6", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
