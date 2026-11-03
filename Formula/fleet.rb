class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.12.2"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.2/fleet-macos-arm64.tar.gz"
      sha256 "0441d8e7c8c73c32108c6f6ae8b61e0fbe61220a9a436f8b0895d426e0523a8a"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.2/fleet-macos-amd64.tar.gz"
      sha256 "1c6b77d5b0d5ae8055587f240fc57cf781b2a07f1c69a60fd8e3ffb29c32f302"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.12.2/fleet-linux-amd64.tar.gz"
    sha256 "59da91df55f89b466639858bd6142242adc8f48f1a2accc550ac35170941dd8f"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.12.2", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
