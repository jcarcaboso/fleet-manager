class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.8.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.0/fleet-macos-arm64.tar.gz"
      sha256 "4d1936f84896b797bf01a1e93904734eb043fc5dc7ddc9a0413d0ce259b143b9"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.0/fleet-macos-amd64.tar.gz"
      sha256 "be2c4bc8118e8960ce8b39784907fbd1edfea728562def0d887026da8ba1b984"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.0/fleet-linux-amd64.tar.gz"
    sha256 "dfccc5853b6d9ff625d4000c32600b7046f1e5a589b301060fa0615b3a9d5e22"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.8.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
