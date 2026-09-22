class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.1/fleet-macos-arm64.tar.gz"
      sha256 "134c307031e4bd5e83cf4637597ab98777fa3c1b6368dabc0cead22f35cb67b2"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.1/fleet-macos-amd64.tar.gz"
      sha256 "707218ced223020cfcb4a607bfbc998535c771f2893733c0c9486d3e282d6440"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.1/fleet-linux-amd64.tar.gz"
    sha256 "6fd8301218330e8d808e24050d663339f0b09840621a3e521c025e7fc8c86f16"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.6.1", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
