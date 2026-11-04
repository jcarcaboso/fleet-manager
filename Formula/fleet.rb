class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.12.3"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.3/fleet-macos-arm64.tar.gz"
      sha256 "33897d82a15a154d6d0c56c160b521a1cdf3c8479fe181b01cefb801ce771f71"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.3/fleet-macos-amd64.tar.gz"
      sha256 "f5ee7376d93f76a4c741b96fca28a9f657a4a754d10804ee15686aec53d83049"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.3/fleet-linux-amd64.tar.gz"
    sha256 "04bee62e3c93a2f84d1a18a2b68bc09b7d2ec97a9ad2089dcf1432632380cc2e"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.12.3", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
