class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.0/fleet-macos-arm64.tar.gz"
      sha256 "f7e6e5afac6b4de596629e9a60d054b940b028abad07bfdcba8afec2fcc76c9a"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.0/fleet-macos-amd64.tar.gz"
      sha256 "c7b4edbacdbe1a47eaf55deefbfebc70126243abac13a138cf01766685619828"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.0/fleet-linux-amd64.tar.gz"
    sha256 "ec0ce0af12c1879b3404b2d34e8c1b99d9baaf11df8deb8b72bfadf97589d6d9"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.6.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
