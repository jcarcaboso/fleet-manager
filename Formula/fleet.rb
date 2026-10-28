class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.11.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.11.0/fleet-macos-arm64.tar.gz"
      sha256 "fba614007619dbd4126a0933f6b9b3ddc97318ace891586668252e788b32d2c7"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.11.0/fleet-macos-amd64.tar.gz"
      sha256 "05c302edebd41dfd1de4aa7c05e517bb56ac340ea42bdccb3ed9e53749836ff1"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.11.0/fleet-linux-amd64.tar.gz"
    sha256 "94d19513e321c247264a0e3502917d753482859f6e9c12e64006239e002264ff"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.11.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
