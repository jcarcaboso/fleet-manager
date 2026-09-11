class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.5.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.1/fleet-macos-arm64.tar.gz"
      sha256 "444707d773fc16dd94cfdb5a47dd726c47699a693bcabbdfba3acdb4a2b76e19"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.1/fleet-macos-amd64.tar.gz"
      sha256 "46a9dfd1e5c00c4d579a82e5abbc301857e386eb9afe363b5ccfa527bcba1cbf"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.5.1/fleet-linux-amd64.tar.gz"
    sha256 "248bb9c28fbde3a523be10bcb085ec73acc29ff47cc64c4fc0140946735b7925"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.5.1", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
