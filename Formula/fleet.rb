class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.9.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.9.0/fleet-macos-arm64.tar.gz"
      sha256 "3c0335c883586742668fd3da056f39a5bf5b6dce29911b05c5cc8b0e0d1a24aa"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.9.0/fleet-macos-amd64.tar.gz"
      sha256 "d12e6e8224655fb3b229806924936d9f7088485eb5fc550bee1ec89bc75352f7"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.9.0/fleet-linux-amd64.tar.gz"
    sha256 "88f211279d4259f1123e2b8ab9b51c6e0a046fec00024e5925540fa882dc4dc3"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.9.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
