class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.12.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.1/fleet-macos-arm64.tar.gz"
      sha256 "c278f89e5db649e4da11580d12caa0ffe9aa0f02365fea4a35c35e60b4060059"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.1/fleet-macos-amd64.tar.gz"
      sha256 "edfa105cccbc36bb119d6ac2769167f147e3b194bdb4027885d8f4db57080ac8"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.1/fleet-linux-amd64.tar.gz"
    sha256 "1f001d4b97f7ff3f9fb1492147f5848e58abe92e18220b97bac9c1b8b42f8d76"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.12.1", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
