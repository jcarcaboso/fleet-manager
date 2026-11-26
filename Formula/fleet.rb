class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.15.2"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.2/fleet-macos-arm64.tar.gz"
      sha256 "544db216baaa8c0766fe0d69eabe592eb7cfb12a57ec843305ec247cd6154522"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.2/fleet-macos-amd64.tar.gz"
      sha256 "8b3e204c843a26ad20922d65f1eb3e699ffa01946267abfb8d17f146ea2044f5"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.2/fleet-linux-arm64.tar.gz"
      sha256 "a02aa72b99ebc1554b51c44a1694d860c519821a80a76d2826698ea4f71add2d"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.2/fleet-linux-amd64.tar.gz"
      sha256 "647e3ac8cf7ac6f579a285a5e846d994db61f8832f69213935443facbb5f08f3"
    end
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.15.2", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
