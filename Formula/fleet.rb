class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.2"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.2/fleet-macos-arm64.tar.gz"
      sha256 "b45d1c7a7360254d398a620157b3b45a95855fce1ac9cf2aec707a96b895f8ae"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.2/fleet-macos-amd64.tar.gz"
      sha256 "be92bdfbd7cad9638029dc1ae0e424d84f62c903d2babb3ed2f866859405ae24"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.2/fleet-linux-amd64.tar.gz"
    sha256 "0e7aaf0c7a5f4cf89c6dcc218d9879469c9a7d3acf3318a966bddc487bd5f112"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.6.2", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
