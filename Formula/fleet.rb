class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.15.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.1/fleet-macos-arm64.tar.gz"
      sha256 "b60b5f2ba9f5d27a918fd49cb1f4d836787a2e576197034b00374e189f69a6cd"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.1/fleet-macos-amd64.tar.gz"
      sha256 "18aa8eea327e20fbc3d16118f850a99e8c20b3980c4e8458e4a3183b55ab0e3e"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.1/fleet-linux-arm64.tar.gz"
      sha256 "29ae91b3f4e9d022bfd1910af3f526097387f2b154b73309b55f77ef90b13d51"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.1/fleet-linux-amd64.tar.gz"
      sha256 "3afe9ad39f5e3d027b2c4a69398df23cdf06bfb39896ce3e903a9a23672b1228"
    end
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.15.1", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
